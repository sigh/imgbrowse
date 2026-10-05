"""Name exclusions stay consistent across browsing, covers, archives and HTTP access."""

import io
import json
import tempfile
import unittest
import zipfile
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread
from urllib.parse import urlencode

from PIL import Image

from image_browser.app import Gallery
from image_browser.http.server import GalleryServer


class ExclusionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.excluded = ['@eaDir', '#recycle', 'skip.jpg']
        self.gallery = Gallery(self.root, self.excluded)
        buffer = io.BytesIO()
        Image.new('RGB', (12, 18), 'blue').save(buffer, 'JPEG')
        self.image = buffer.getvalue()
        for name in ('@eaDir/hidden.jpg', '#recycle/hidden.jpg', 'Album/@eaDir/hidden.jpg',
                     'Album/#recycle/hidden.jpg', 'Album/page.jpg', 'Album/skip.jpg',
                     '@eaDir-old/page.jpg', 'skip.jpg'):
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(self.image)
        with zipfile.ZipFile(self.root / 'book.cbz', 'w') as archive:
            for name in ('@eaDir/hidden.jpg', '#recycle/hidden.jpg',
                         'Chapter/@eaDir/hidden.jpg', 'Chapter/page.jpg', 'skip.jpg'):
                archive.writestr(name, self.image)

    def sequence(self, reverse=False):
        images, cursor = [], None
        while True:
            page = self.gallery.walk(cursor=cursor, limit=1, reverse=reverse)
            images.extend(page['images'])
            cursor = page['cursor']
            if cursor is None:
                return images

    def test_exclusions_are_optional_and_match_whole_names(self):
        default = Gallery(self.root)
        self.assertIn('@eaDir', default.listing('')['folders'])
        self.assertIn('skip.jpg', default.listing('')['images'])
        self.assertIn('#recycle', default.listing('book.cbz')['folders'])
        self.assertIn('@eaDir-old', self.gallery.listing('')['folders'])

    def test_listings_and_paged_traversal_omit_excluded_branches(self):
        self.assertEqual(self.gallery.listing(''),
                         {'folders': ['@eaDir-old', 'Album', 'book.cbz'], 'images': [], 'other_files': []})
        self.assertEqual(self.gallery.listing('Album'), {'folders': [], 'images': ['page.jpg'], 'other_files': []})
        self.assertEqual(self.gallery.listing('book.cbz'), {'folders': ['Chapter'], 'images': [], 'other_files': []})
        self.assertEqual(self.gallery.listing('book.cbz/Chapter'),
                         {'folders': [], 'images': ['page.jpg'], 'other_files': []})
        expected = ['@eaDir-old/page.jpg', 'Album/page.jpg', 'book.cbz/Chapter/page.jpg']
        self.assertEqual(self.sequence(), expected)
        self.assertEqual(self.sequence(reverse=True), expected[::-1])

    def test_folder_covers_skip_excluded_first_branches(self):
        for name in ('@eaDir/hidden.jpg', '#recycle/hidden.jpg', 'Pages/page.jpg'):
            file = self.root / 'Cover' / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(self.image)
        self.assertEqual(self.gallery.representative('Cover'), 'Cover/Pages/page.jpg')
        self.assertEqual(self.gallery.representative('book.cbz'), 'book.cbz/Chapter/page.jpg')

    def test_excluded_paths_cannot_be_opened_or_used_as_walk_context(self):
        for path in ('@eaDir/hidden.jpg', 'Album/#recycle/hidden.jpg', 'skip.jpg',
                     'book.cbz/Chapter/@eaDir/hidden.jpg', 'book.cbz/skip.jpg'):
            for method in (self.gallery.resolve, self.gallery.source, self.gallery.location,
                           self.gallery.listing, self.gallery.representative, self.gallery.thumbnail_source):
                with self.subTest(path=path, method=method.__name__), self.assertRaises(ValueError):
                    method(path)
            for options in ({'root': path}, {'anchor': path},
                            {'cursor': [{'path': path, 'phase': 0, 'after': None}]}):
                with self.subTest(path=path, options=options), self.assertRaises(ValueError):
                    self.gallery.walk(**options)

    def test_http_routes_use_the_same_exclusions(self):
        server = GalleryServer(('127.0.0.1', 0), self.root, self.excluded)
        Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        connection = HTTPConnection('127.0.0.1', server.server_port, timeout=5)
        self.addCleanup(connection.close)
        for path in ('@eaDir/hidden.jpg', 'Album/#recycle/hidden.jpg', 'skip.jpg',
                     'book.cbz/@eaDir/hidden.jpg', 'book.cbz/skip.jpg'):
            for route in ('/api/folder', '/api/location', '/api/metadata', '/image', '/thumbnail'):
                with self.subTest(path=path, route=route):
                    connection.request('GET', route + '?' + urlencode({'path': path}))
                    response = connection.getresponse()
                    self.assertEqual(response.status, 400)
                    self.assertIn('visible collection', json.loads(response.read())['error'])
        connection.request('GET', '/api/metadata?path=')
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        details = json.loads(response.read())
        self.assertEqual((details['folders'], details['media']), (3, 0))
