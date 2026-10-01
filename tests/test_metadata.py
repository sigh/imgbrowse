"""Metadata API reports the selected item and preserves collection boundaries."""

import io
import json
import tempfile
import unittest
import zipfile
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread
from unittest.mock import patch
from urllib.parse import urlencode

from PIL import Image

from image_browser.server import GalleryServer


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.server = GalleryServer(('127.0.0.1', 0), self.root)
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        buffer = io.BytesIO()
        exif = Image.Exif()
        exif[272] = 'Test camera'
        exif[34665] = {36867: '2024:03:14 12:30:00'}
        Image.new('RGB', (40, 60)).save(buffer, 'JPEG', exif=exif)
        self.image = buffer.getvalue()
        (self.root / 'photo.jpg').write_bytes(self.image)

    def request(self, path):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request('GET', '/api/metadata?' + urlencode({'path': path}))
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_image_details_and_location(self):
        status, data = self.request('photo.jpg')
        self.assertEqual(status, 200)
        self.assertEqual(data['filesystem_path'], str(self.root / 'photo.jpg'))
        self.assertEqual((data['width'], data['height'], data['format']), (40, 60, 'JPEG'))
        self.assertEqual(data['size'], len(self.image))
        self.assertEqual(data['exif']['Camera model'], 'Test camera')
        self.assertEqual(data['exif']['Taken'], '2024-03-14T12:30:00')
        self.assertIsNone(data['archive_member'])

    def test_directory_counts_do_not_traverse_descendants(self):
        (self.root / 'nested').mkdir()
        (self.root / 'nested/deeper').mkdir()
        (self.root / 'nested/deeper/other.jpg').write_bytes(self.image)
        (self.root / 'notes.txt').write_text('ignored')
        with patch.object(self.server.gallery, '_scan_directory',
                          wraps=self.server.gallery._scan_directory) as scan:
            status, data = self.request('')
            self.assertEqual(status, 200)
            self.assertEqual((data['kind'], data['folders'], data['media']), ('directory', 1, 1))
            self.assertEqual(scan.call_count, 1)

    def test_archive_members_and_virtual_folders(self):
        with zipfile.ZipFile(self.root / 'book.cbz', 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('chapter/page.jpg', self.image)
        status, data = self.request('book.cbz/chapter/page.jpg')
        self.assertEqual(status, 200)
        self.assertEqual(data['archive_member'], 'chapter/page.jpg')
        self.assertEqual(data['filesystem_path'], str(self.root / 'book.cbz'))
        self.assertEqual((data['width'], data['height'], data['size']), (40, 60, len(self.image)))
        self.assertLess(data['compressed_size'], data['size'])
        self.assertEqual(self.request('book.cbz')[1]['kind'], 'archive')
        folder = self.request('book.cbz/chapter')[1]
        self.assertEqual((folder['kind'], folder['folders'], folder['media']), ('directory', 0, 1))
        self.assertEqual(self.request('book.cbz/missing')[0], 404)

    def test_unreadable_image_still_has_file_details(self):
        (self.root / 'broken.jpg').write_bytes(b'broken')
        status, data = self.request('broken.jpg')
        self.assertEqual(status, 200)
        self.assertEqual(data['size'], 6)
        self.assertIn('metadata_error', data)

    def test_rejects_hidden_escaping_missing_and_symlink_paths(self):
        (self.root / 'link.jpg').symlink_to(self.root / 'photo.jpg')
        for path in ['../photo.jpg', '/etc/passwd', '.hidden.jpg', 'link.jpg', 'missing.jpg']:
            with self.subTest(path=path):
                self.assertIn(self.request(path)[0], (400, 404))


if __name__ == '__main__':
    unittest.main()
