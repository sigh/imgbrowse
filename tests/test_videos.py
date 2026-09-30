"""Mixed-media traversal and HTTP seeking regressions."""

import tempfile
import unittest
import zipfile
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread

from image_browser.server import GalleryServer


class VideoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.data = bytes(range(256)) * 8
        (root / '2.MP4').write_bytes(self.data)
        (root / '1.jpg').write_bytes(b'image')
        (root / '3.jpg').write_bytes(b'image')
        with zipfile.ZipFile(root / 'book.cbz', 'w') as archive:
            archive.writestr('video.mp4', self.data)
            archive.writestr('page.jpg', b'image')
        self.server = GalleryServer(('127.0.0.1', 0), root)
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, headers=None, method='GET', path='/image?path=2.MP4'):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_mixed_order_and_archive_exclusion(self):
        gallery = self.server.gallery
        self.assertEqual(gallery.listing('')['images'], ['1.jpg', '2.MP4', '3.jpg'])
        self.assertEqual(gallery.walk()['images'], ['1.jpg', '2.MP4', '3.jpg', 'book.cbz/page.jpg'])
        self.assertEqual(gallery.source('2.MP4').kind, 'video')
        with self.assertRaises(FileNotFoundError):
            gallery.source('book.cbz/video.mp4')
        self.assertEqual(self.request(path='/thumbnail?path=2.MP4')[0], 422)

    def test_ranges_and_full_responses(self):
        status, headers, data = self.request()
        self.assertEqual((status, data), (200, self.data))
        self.assertEqual(headers['Content-Type'], 'video/mp4')
        self.assertEqual(headers['Accept-Ranges'], 'bytes')
        for value, start, end in [('bytes=2-7', 2, 7), ('bytes=2000-', 2000, 2047),
                                  ('bytes=-8', 2040, 2047), ('bytes=2040-9999', 2040, 2047)]:
            status, headers, data = self.request({'Range': value})
            self.assertEqual((status, data), (206, self.data[start:end + 1]))
            self.assertEqual(headers['Content-Range'], f'bytes {start}-{end}/2048')
            self.assertEqual(int(headers['Content-Length']), len(data))
        status, headers, data = self.request({'Range': 'bytes=9999-'})
        self.assertEqual((status, headers['Content-Range'], data), (416, 'bytes */2048', b''))
        for value in ['bytes=0-1,5-6', 'nonsense', 'bytes=9-1']:
            self.assertEqual(self.request({'Range': value})[0], 200)

    def test_head_and_conditional_ranges(self):
        status, headers, data = self.request(method='HEAD')
        self.assertEqual((status, int(headers['Content-Length']), data), (200, 2048, b''))
        self.assertEqual(self.request({'Range': 'bytes=0-9', 'If-Range': headers['ETag']})[0], 206)
        self.assertEqual(self.request({'Range': 'bytes=0-9', 'If-Range': '"old"'})[0], 200)
        self.assertEqual(self.request({'If-None-Match': headers['ETag']})[0], 304)
