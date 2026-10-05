"""Transport, typed facts, ambiguous identities, and retryable failures."""

import io
import json
import tempfile
import threading
import unittest
import zipfile
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode

from PIL import Image

from image_browser.http.server import GalleryServer
from image_browser.runtime.work import Busy


class CatalogApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = GalleryServer(('127.0.0.1', 0), self.root)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, route, data=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request('POST' if data is not None else 'GET', route,
                json.dumps(data, ensure_ascii=False).encode() if data is not None else None,
                {'Content-Type':'application/json'} if data is not None else {})
            response = connection.getresponse()
            body = response.read()
            return response.status, json.loads(body) if response.headers['Content-Type'].startswith('application/json') else body
        finally:
            connection.close()

    def test_large_unicode_fact_batch_uses_body_and_enforces_size_and_count(self):
        names = ['😀' * 200 + str(index) + '.jpg' for index in range(60)]
        with zipfile.ZipFile(self.root / 'long.cbz', 'w') as archive:
            for name in names:
                archive.writestr(name, b'')
        items = [{'name':name, 'type':'image'} for name in names]
        status, page = self.request('/api/folder/entries', {'path':'long.cbz', 'items':items})
        self.assertEqual(status, 200)
        self.assertEqual(len(page['entries']), 60)
        self.assertEqual(self.request('/api/folder/entries', {'path':'long.cbz', 'items':items + items[:1]})[0], 400)
        self.assertEqual(self.request('/api/folder/entries', {'path':'long.cbz', 'items':items, 'padding':'x' * 140000})[0], 400)

    def test_colliding_folder_and_image_keep_distinct_facts_info_and_previews(self):
        buffer = io.BytesIO(); Image.new('RGB', (40, 60), 'red').save(buffer, 'JPEG')
        child = io.BytesIO(); Image.new('RGB', (60, 40), 'blue').save(child, 'JPEG')
        with zipfile.ZipFile(self.root / 'collision.cbz', 'w') as archive:
            archive.writestr(zipfile.ZipInfo('chapter.jpg', (2024,10,6,2,45,0)), buffer.getvalue())
            archive.writestr('chapter.jpg/child.jpg', child.getvalue())
        _, index = self.request('/api/folder?path=collision.cbz')
        self.assertEqual(index['items'], [{'name':'chapter.jpg','type':'folder'}, {'name':'chapter.jpg','type':'image'}])
        status, facts = self.request('/api/folder/entries', {'path':'collision.cbz','items':index['items'],'revision':index['revision']})
        self.assertEqual(status, 200)
        self.assertIsNone(facts['entries'][0]['modified'])
        self.assertEqual(facts['entries'][1]['modified']['kind'], 'calendar')
        for kind, expected in [('folder','directory'), ('image','image')]:
            query = urlencode({'path':'collision.cbz/chapter.jpg', 'kind':kind})
            _, info = self.request('/api/metadata?' + query)
            self.assertEqual(info['kind'], expected)
            self.assertEqual(info['modified'], next(entry['modified'] for entry in facts['entries'] if entry['type'] == kind))
            status, preview = self.request('/thumbnail?' + query)
            self.assertEqual(status, 200)
            image = Image.open(io.BytesIO(preview))
            self.assertEqual(image.size, (60,40) if kind == 'folder' else (40,60))
            if kind == 'folder':
                self.assertEqual(info['container_modified']['kind'], 'instant')

    def test_busy_walk_is_retryable_and_individual_fact_errors_do_not_fail_batch(self):
        (self.root / 'a.jpg').write_bytes(b'fixture')
        with patch.object(self.server.gallery.storage, 'children', side_effect=Busy('busy')):
            status, error = self.request('/api/walk', {'root':''})
        self.assertEqual((status,error['code'],error['retryable']), (503,'storage_busy',True))
        self.assertEqual(self.request('/api/walk', {'root':''})[1]['images'], ['a.jpg'])
        with patch.object(self.server.gallery.catalog.facts, 'read', side_effect=Busy('busy')):
            status, page = self.request('/api/folder/entries', {'items':[{'name':'a.jpg','type':'image'}]})
        self.assertEqual(status, 200)
        self.assertEqual(page['entries'][0]['code'], 'storage_busy')
        self.assertEqual(self.request('/api/folder/entries', {'items':[{'name':'a.jpg','type':'image'}]})[1]['entries'][0]['status'], 'ready')

    def test_stale_membership_is_structured_conflict(self):
        (self.root / 'a.jpg').write_bytes(b'fixture')
        _, index = self.request('/api/folder')
        (self.root / 'b.jpg').write_bytes(b'fixture')
        self.request('/api/refresh', {'path':''})
        status, error = self.request('/api/folder/entries', {'items':[{'name':'a.jpg','type':'image'}], 'revision':index['revision']})
        self.assertEqual((status,error['code']), (409,'stale_view'))

    def test_thumbnail_enforces_the_selected_type_and_preserves_input_errors(self):
        Image.new('RGB', (40, 60)).save(self.root / 'a.jpg')
        for kind in ('folder', 'file', 'unknown'):
            with self.subTest(kind=kind):
                status, error = self.request('/thumbnail?' + urlencode({'path':'a.jpg', 'kind':kind}))
                self.assertEqual((status, error['code']), (400, 'invalid_request'))

    def test_walk_preparation_budget_error_is_structured_and_not_empty_success(self):
        (self.root / 'a.jpg').write_bytes(b'fixture')
        self.server.gallery.catalog.preparations.MAX_BYTES = 1
        status, error = self.request('/api/walk', {'sort':'modified'})
        self.assertEqual((status, error['code'], error['retryable']), (413, 'order_too_large', False))

    def test_only_initial_folder_preparation_supplies_a_cheap_listing(self):
        (self.root / 'a.jpg').write_bytes(b'fixture')
        entered, release = threading.Event(), threading.Event()
        read = self.server.gallery.catalog.facts.read
        def blocked(entry):
            entered.set()
            self.assertTrue(release.wait(3))
            return read(entry)
        try:
            with patch.object(self.server.gallery.catalog.facts, 'read', side_effect=blocked):
                status, progress = self.request('/api/folder?sort=size')
                self.assertEqual(status, 202)
                self.assertTrue(entered.wait(1))
                self.assertEqual(progress['listing']['items'], [{'name':'a.jpg', 'type':'image'}])
                self.assertEqual(progress['listing']['root_name'], self.root.name)
                status, poll = self.request('/api/folder?' + urlencode({'sort':'size', 'order_token':progress['token']}))
                self.assertEqual(status, 202)
                self.assertNotIn('listing', poll, 'Polling must not resend the whole folder')
                self.request('/api/order/cancel', {'token':progress['token']})
        finally:
            release.set()
