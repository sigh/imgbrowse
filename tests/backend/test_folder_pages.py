"""Folder entry pages share lazy attributes with sorting, without reading media."""

import os
import tempfile
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from image_browser.app import Gallery
from image_browser.catalog.ordering import Ordering
from image_browser.http.catalog_api import CatalogApi
from image_browser.runtime.work import Cancelled, Invalidated, request_work


class FolderPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.gallery = Gallery(self.root)
        self.reads, self.scans = [], []
        self.after_read = lambda: None
        scandir = os.scandir

        @contextmanager
        def tracked(directory):
            self.scans.append(Path(directory))
            with scandir(directory) as entries:
                yield entries

        self.tracker = patch('image_browser.storage.collection.os.scandir', tracked)
        self.tracker.start()
        self.addCleanup(self.tracker.stop)
        read = self.gallery.catalog.facts.read
        def tracked_read(entry):
            try:
                return read(entry)
            finally:
                self.reads.append(entry.name)
                self.after_read()
        self.attribute_tracker = patch.object(self.gallery.catalog.facts, 'read', tracked_read)
        self.attribute_tracker.start()
        self.addCleanup(self.attribute_tracker.stop)

    def file(self, name, seconds=0):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b'not an image')
        os.utime(file, (seconds, seconds))

    def facts(self, path, names, revision=None):
        # Test fixtures explicitly assign each child's identity.
        types = {'child':'folder', 'chapter':'folder', 'implicit':'folder', 'notes.txt':'file'}
        return CatalogApi(self.gallery).entry_page(path, [{'name':name, 'type':types.get(name, 'image')} for name in names], revision=revision)

    def test_name_index_is_cheap_and_fact_batches_are_bounded(self):
        for index in range(2400):
            self.file(f'page{index}.jpg', index)
        index = CatalogApi(self.gallery).folder_index('')
        self.assertEqual(len(index['items']), 2400)
        self.gallery.listing('', ordering=Ordering(order='desc'))
        self.assertEqual(self.reads, [])
        first = CatalogApi(self.gallery).entry_page('', index['items'][:60], revision=index['revision'])
        self.assertEqual(len(first['entries']), 60)
        self.assertEqual(self.reads, [f'page{i}.jpg' for i in range(60)])
        self.assertEqual(first['entries'][0]['modified'],
                         {'kind':'instant', 'value':'1970-01-01T00:00:00+00:00', 'key':'0'})
        page = self.facts('', ['page2300.jpg', 'page2399.jpg'], first['revision'])
        self.assertNotIn('images', page)
        self.assertEqual([entry['name'] for entry in page['entries']], ['page2300.jpg', 'page2399.jpg'])
        self.assertEqual(self.reads[60:], ['page2300.jpg', 'page2399.jpg'])
        self.assertEqual(self.scans, [self.root])

    def test_sort_directions_and_concurrent_requests_share_facts(self):
        for name, seconds in [('a.jpg',100), ('b.jpg',200), ('child/c.jpg',300), ('notes.txt',400)]:
            self.file(name, seconds)
        self.gallery.listing('')
        with patch('image_browser.media.metadata.Image.open', side_effect=AssertionError('Facts must not decode media')):
            with ThreadPoolExecutor(max_workers=3) as workers:
                requests = [workers.submit(self.facts, '', ['a.jpg']) for _ in range(3)]
                for request in requests:
                    self.assertEqual(request.result()['entries'][0]['modified']['key'], '100000000000')
            for direction, expected in [('asc', ['a.jpg','b.jpg']), ('desc', ['b.jpg','a.jpg'])]:
                self.assertEqual(self.gallery.listing('', ordering=Ordering('modified', direction))['images'], expected)
            self.facts('', ['a.jpg','b.jpg','child','notes.txt'])
            self.facts('', ['notes.txt'])
        self.assertCountEqual(self.reads, ['a.jpg','b.jpg','child','notes.txt'])
        self.assertEqual(self.scans, [self.root])
        os.utime(self.root / 'a.jpg', (500,500))
        self.gallery.invalidate('')
        self.assertEqual(self.gallery.listing('', ordering=Ordering('modified','desc'))['images'], ['a.jpg','b.jpg'])
        self.assertEqual(self.reads.count('a.jpg'), 2)

    def test_unknown_dates_sort_last_and_membership_revision_excludes_fact_changes(self):
        self.file('a.jpg'); self.file('b.jpg')
        self.gallery.listing('')
        (self.root / 'a.jpg').unlink()
        first = self.facts('', ['a.jpg'])
        self.assertIsNone(first['entries'][0]['modified'])
        self.file('a.jpg', 200)
        self.assertIsNone(self.facts('', ['a.jpg'])['entries'][0]['modified'])
        for direction in ('asc','desc'):
            self.assertEqual(self.gallery.listing('', ordering=Ordering('modified',direction))['images'], ['b.jpg','a.jpg'])
        self.assertEqual(self.reads.count('a.jpg'), 1)
        self.gallery.invalidate('')
        self.assertIsNotNone(self.facts('', ['a.jpg'])['entries'][0]['modified'])
        self.assertEqual(self.facts('', ['a.jpg'], first['revision'])['revision'], first['revision'])
        self.file('new.jpg'); self.gallery.invalidate('')
        with self.assertRaisesRegex(ValueError, 'listing changed'):
            self.facts('', ['a.jpg'], first['revision'])

    def test_archive_dates_are_calendar_values_and_never_read_members(self):
        with zipfile.ZipFile(self.root / 'book.cbz', 'w') as archive:
            archive.writestr(zipfile.ZipInfo('chapter/', (2024,3,14,12,0,0)), b'')
            archive.writestr(zipfile.ZipInfo('chapter/page.jpg', (2024,3,14,12,30,0)), b'not an image')
            archive.writestr('implicit/readme.txt', b'notes')
        with patch.object(zipfile.ZipFile, 'open', side_effect=AssertionError('No member reads')):
            folders = self.facts('book.cbz', ['chapter','implicit'])['entries']
            self.assertEqual(folders[0]['modified'], {'kind':'calendar', 'value':'2024-03-14T12:00:00', 'key':'20240314120000'})
            self.assertIsNone(folders[1]['modified'])
            self.assertEqual(self.facts('book.cbz/chapter', ['page.jpg'])['entries'][0]['modified']['value'], '2024-03-14T12:30:00')
        self.assertEqual(self.reads, ['chapter','implicit','page.jpg'])

    def test_cancellation_and_refresh_stop_fact_publication(self):
        self.file('a.jpg'); self.file('b.jpg')
        self.gallery.listing('')
        with request_work(cancel=lambda: bool(self.reads)), self.assertRaises(Cancelled):
            self.facts('', ['a.jpg','b.jpg'])
        self.assertEqual(self.reads, ['a.jpg'])
        self.after_read = lambda: self.gallery.invalidate('')
        with self.assertRaises(Invalidated):
            self.facts('', ['b.jpg'])
        self.assertEqual(self.gallery.catalog.indexes.weight, 0)

    def test_batches_reject_invalid_unlisted_or_unbounded_identities(self):
        self.file('page.jpg')
        for items in [[{'name':'../page.jpg','type':'image'}], [{'name':'page.jpg','type':'image'}] * 61,
                      'page.jpg', [{'name':'missing.jpg','type':'image'}], [{'name':'page.jpg','type':'folder'}],
                      [{'name':'page.jpg'}], [{'name':'page.jpg','type':[]}]]:
            with self.subTest(items=items), self.assertRaises(ValueError):
                CatalogApi(self.gallery).entry_page('', items)
        self.assertEqual(self.reads, [])
