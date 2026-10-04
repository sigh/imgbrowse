"""Folder entry pages share lazy attributes with sorting, without reading media."""

import os
import tempfile
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from image_browser.catalog import Gallery
from image_browser.ordering import Ordering
from image_browser.work import Cancelled, Invalidated, request_work


class TrackedEntry:
    def __init__(self, source, reads, after_read):
        self.source, self.reads, self.after_read = source, reads, after_read

    def __getattr__(self, name):
        return getattr(self.source, name)

    def stat(self, *, follow_symlinks):
        self.reads.append(self.source.name)
        try:
            return self.source.stat(follow_symlinks=follow_symlinks)
        finally:
            self.after_read()


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
                yield (TrackedEntry(entry, self.reads, lambda: self.after_read()) for entry in entries)

        self.tracker = patch('image_browser.catalog.os.scandir', tracked)
        self.tracker.start()
        self.addCleanup(self.tracker.stop)

    def file(self, name, seconds=0):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b'not an image')
        os.utime(file, (seconds, seconds))

    def test_name_index_is_cheap_and_complete_entry_pages_are_bounded(self):
        for index in range(2400):
            self.file(f'page{index}.jpg', index)
        self.assertEqual(len(self.gallery.listing('')['images']), 2400)
        self.gallery.listing('', ordering=Ordering(order='desc'))
        self.assertEqual(self.reads, [])
        first = self.gallery.folder_page('')
        self.assertEqual(len(first['images']), 2400)
        self.assertEqual(len(first['entries']), 60)
        self.assertEqual(self.reads, [f'page{i}.jpg' for i in range(60)])
        self.assertEqual(first['entries'][0],
                         {'name':'page0.jpg', 'type':'image', 'modified':'1970-01-01T00:00:00+00:00'})
        # Sparse selection serves filtered views and a deep return without reading the prefix.
        page = self.gallery.folder_page('', names=['page2300.jpg', 'page2399.jpg'], revision=first['revision'])
        self.assertNotIn('images', page)
        self.assertEqual([entry['name'] for entry in page['entries']], ['page2300.jpg', 'page2399.jpg'])
        self.assertEqual(self.reads[60:], ['page2300.jpg', 'page2399.jpg'])
        self.assertEqual(self.scans, [self.root])

    def test_pages_sort_directions_and_concurrent_requests_share_attributes(self):
        self.file('a.jpg', 100)
        self.file('b.jpg', 200)
        self.file('child/c.jpg', 300)
        self.file('notes.txt', 400)
        self.gallery.listing('')
        with patch.object(Path, 'lstat', side_effect=AssertionError('Use retained DirEntry')):
            with ThreadPoolExecutor(max_workers=3) as workers:
                requests = [workers.submit(self.gallery.folder_page, '', names=['a.jpg']) for _ in range(3)]
                for request in requests:
                    self.assertEqual(request.result()['entries'][0]['modified'],
                                     datetime.fromtimestamp(100, timezone.utc).isoformat())
            for direction, expected in [('asc', ['a.jpg', 'b.jpg']), ('desc', ['b.jpg', 'a.jpg'])]:
                self.assertEqual(self.gallery.listing('', ordering=Ordering('modified', direction))['images'], expected)
            self.gallery.folder_page('', names=['a.jpg', 'b.jpg', 'child', 'notes.txt'])
            self.gallery.folder_page('', names=['notes.txt'])
        self.assertCountEqual(self.reads, ['a.jpg', 'b.jpg', 'child', 'notes.txt'])
        self.assertEqual(self.scans, [self.root])
        os.utime(self.root / 'a.jpg', (500, 500))
        self.gallery.invalidate('')
        self.assertEqual(self.gallery.listing('', ordering=Ordering('modified', 'desc'))['images'], ['a.jpg', 'b.jpg'])
        self.assertEqual(self.reads.count('a.jpg'), 2)
        self.assertEqual(self.scans, [self.root, self.root])

    def test_missing_attributes_are_retained_until_refresh_and_unknowns_sort_last(self):
        self.file('a.jpg')
        self.file('b.jpg')
        self.gallery.listing('')
        (self.root / 'a.jpg').unlink()
        first = self.gallery.folder_page('', names=['a.jpg'])
        self.assertIsNone(first['entries'][0]['modified'])
        self.file('a.jpg', 200)
        self.assertIsNone(self.gallery.folder_page('', names=['a.jpg'])['entries'][0]['modified'])
        for direction in ('asc', 'desc'):
            self.assertEqual(self.gallery.listing('', ordering=Ordering('modified', direction))['images'], ['b.jpg', 'a.jpg'])
        self.assertEqual(self.reads.count('a.jpg'), 1)
        self.gallery.invalidate('')
        self.assertIsNotNone(self.gallery.folder_page('', names=['a.jpg'])['entries'][0]['modified'])
        with self.assertRaisesRegex(ValueError, 'listing changed'):
            self.gallery.folder_page('', names=['a.jpg'], revision=first['revision'])

    def test_archives_use_retained_calendar_dates_without_opening_members(self):
        with zipfile.ZipFile(self.root / 'book.cbz', 'w') as archive:
            archive.writestr(zipfile.ZipInfo('chapter/', (2024, 3, 14, 12, 0, 0)), b'')
            archive.writestr(zipfile.ZipInfo('chapter/page.jpg', (2024, 3, 14, 12, 30, 0)), b'not an image')
            archive.writestr('implicit/readme.txt', b'notes')
        self.gallery.listing('book.cbz')
        with patch.object(zipfile.ZipFile, 'open', side_effect=AssertionError('No member reads')):
            folders = self.gallery.folder_page('book.cbz')['entries']
            self.assertEqual(folders, [
                {'name':'chapter', 'type':'folder', 'modified':'2024-03-14T12:00:00'},
                {'name':'implicit', 'type':'folder', 'modified':None}])
            self.assertEqual(self.gallery.folder_page('book.cbz/chapter')['entries'],
                             [{'name':'page.jpg', 'type':'image', 'modified':'2024-03-14T12:30:00'}])
        self.assertEqual(self.reads, [])

    def test_cancellation_stops_attribute_reads_and_refresh_supersedes_pages(self):
        self.file('a.jpg')
        self.file('b.jpg')
        self.gallery.listing('')
        with request_work(cancel=lambda: bool(self.reads)), self.assertRaises(Cancelled):
            self.gallery.folder_page('')
        self.assertEqual(self.reads, ['a.jpg'])
        self.after_read = lambda: self.gallery.invalidate('')
        with self.assertRaises(Invalidated):
            self.gallery.folder_page('', names=['b.jpg'])
        self.assertEqual(self.gallery.listings.weight, 0)

    def test_pages_reject_unbounded_invalid_and_unlisted_children(self):
        self.file('page.jpg')
        for options in [{'names':['../page.jpg']}, {'names':['page.jpg'] * 61}, {'names':'page.jpg'},
                        {'names':['missing.jpg']}, {'limit':0}, {'limit':61}, {'limit':True}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.gallery.folder_page('', **options)
        self.assertEqual(self.reads, [])
