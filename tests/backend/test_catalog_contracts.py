"""Catalog behavior must survive memoization changes and scoped refreshes."""

import json
import os
import tempfile
import threading
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from time import monotonic, sleep
from unittest.mock import patch

from image_browser.app import Gallery
from image_browser.catalog.errors import StaleView
from image_browser.catalog.model import EntryId
from image_browser.catalog.ordering import Ordering
from image_browser.http.catalog_api import CatalogApi
from image_browser.runtime.work import Busy


class CatalogContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.gallery = Gallery(self.root)

    def file(self, path, modified=0):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b'fixture')
        os.utime(file, ns=(modified, modified))

    def test_entry_pages_survive_cache_expiry_without_disk_changes(self):
        self.file('a.jpg')
        self.file('b.jpg')
        first = CatalogApi(self.gallery).folder_index('')
        with patch('image_browser.runtime.cache.monotonic', return_value=monotonic() + 301):
            second = CatalogApi(self.gallery).entry_page('', [{'name':'b.jpg', 'type':'image'}], revision=first['revision'])
        self.assertEqual(second['revision'], first['revision'])
        self.assertEqual(second['entries'][0]['name'], 'b.jpg')

    def test_traversal_survives_eviction_or_disabled_retention(self):
        for name, date in [('a.jpg', 2), ('b.jpg', 1), ('child/c.jpg', 3)]:
            self.file(name, date)
        for budget in (1, 32 * 1024 * 1024):
            for ordering in (Ordering(), Ordering(order='desc'), Ordering('modified')):
                with self.subTest(budget=budget, ordering=ordering):
                    gallery = Gallery(self.root)
                    gallery.catalog.indexes.max_weight = gallery.catalog.views.max_weight = budget
                    paths, cursor = [], None
                    for _ in range(8):
                        page = gallery.walk(limit=1, ordering=ordering, cursor=cursor)
                        paths.extend(page['images'])
                        cursor = json.loads(json.dumps(page['cursor']))
                        gallery.catalog.indexes.invalidate()
                        gallery.catalog.views.invalidate()
                        if cursor is None:
                            break
                    self.assertEqual(len(paths), 3)
                    self.assertEqual(len(set(paths)), 3)
                    self.assertIsNone(cursor)

    def test_large_archive_pages_work_above_listing_cache_capacity(self):
        with zipfile.ZipFile(self.root / 'large.cbz', 'w') as archive:
            for index in range(31_000):
                archive.writestr(f'page{index:05}.jpg', b'')
        first = CatalogApi(self.gallery).folder_index('large.cbz')
        self.gallery.catalog.indexes.invalidate()
        second = CatalogApi(self.gallery).entry_page('large.cbz', [{'name':'page30999.jpg', 'type':'image'}], revision=first['revision'])
        self.assertEqual(second['entries'][0]['name'], 'page30999.jpg')

    def test_archive_file_folder_collision_keeps_both_and_traverses_child(self):
        with zipfile.ZipFile(self.root / 'collision.cbz', 'w') as archive:
            archive.writestr('chapter.jpg', b'fixture')
            archive.writestr('chapter.jpg/child.jpg', b'fixture')
        listing = self.gallery.listing('collision.cbz')
        self.assertEqual(listing['folders'], ['chapter.jpg'])
        self.assertEqual(listing['images'], ['chapter.jpg'])
        self.assertEqual(self.gallery.walk(root='collision.cbz')['images'],
                         ['collision.cbz/chapter.jpg', 'collision.cbz/chapter.jpg/child.jpg'])

    def test_unrelated_refresh_preserves_continuation(self):
        for name in ('A/a.jpg', 'A/b.jpg', 'B/c.jpg'):
            self.file(name)
        page = self.gallery.walk(root='A', limit=1)
        self.gallery.invalidate('B')
        following = self.gallery.walk(root='A', cursor=page['cursor'], limit=1)
        self.assertEqual(following['images'], ['A/b.jpg'])

    def test_busy_traversal_preserves_retryable_failure(self):
        self.file('a.jpg')
        with patch.object(self.gallery.storage, 'children', side_effect=Busy('retry')), self.assertRaises(Busy):
            self.gallery.walk()
        self.assertEqual(self.gallery.walk()['images'], ['a.jpg'])

    def test_parent_changes_are_detected_before_resuming_inside_a_child(self):
        for path in ('a.jpg', 'child/c.jpg', 'child/d.jpg'):
            self.file(path)
        first = self.gallery.walk(limit=2)
        self.assertEqual(first['images'], ['a.jpg','child/c.jpg'])
        self.file('b.jpg')
        self.gallery.invalidate('')
        with self.assertRaises(StaleView):
            self.gallery.walk(limit=1, cursor=first['cursor'])

    def test_new_facts_invalidate_old_order_and_keep_membership_identity(self):
        self.file('a.jpg', 1); self.file('b.jpg', 2)
        old = CatalogApi(self.gallery).folder_index('', ordering=Ordering('modified'))
        self.file('a.jpg', 3)
        self.gallery.catalog.facts.cache.invalidate()
        with self.assertRaises(StaleView):
            CatalogApi(self.gallery).entry_page('', [{'name':'a.jpg','type':'image'}], revision=old['revision'])
        new = CatalogApi(self.gallery).folder_index('', ordering=Ordering('modified'))
        self.assertEqual([entry['name'] for entry in new['items']], ['b.jpg','a.jpg'])
        self.assertEqual(old['revision'], new['revision'])
        self.assertNotEqual(old['view_revision'], new['view_revision'])

    def test_old_active_operations_survive_unrelated_refresh_history_rollover(self):
        valid = self.gallery.refresh.watch('A')
        for _ in range(1000):
            self.gallery.invalidate('B')
        self.assertTrue(valid())
        self.gallery.invalidate('A/child')
        self.assertFalse(valid())

    def test_stale_sort_preparation_is_a_conflict_instead_of_an_unreadable_branch(self):
        self.file('a.jpg', 1); self.file('b.jpg', 2)
        CatalogApi(self.gallery).folder_index('', ordering=Ordering('modified', 'desc'))
        self.file('a.jpg', 3)
        self.gallery.catalog.sort_values.invalidate()
        self.gallery.catalog.facts.cache.invalidate()
        with self.assertRaises(StaleView):
            self.gallery.walk(ordering=Ordering('modified'))
        self.assertEqual(self.gallery.walk(ordering=Ordering('modified'))['images'], ['b.jpg','a.jpg'])

    def test_known_source_version_supersedes_an_older_inflight_fact_read(self):
        self.file('a.jpg', 1)
        entry = self.gallery.catalog.index('').entries[EntryId('a.jpg', 'image')]
        facts = self.gallery.catalog.facts
        entered, release = threading.Event(), threading.Event()
        read = facts.read

        def blocked(descriptor):
            result = read(descriptor)
            if result.modified.key == 1:
                entered.set()
                self.assertTrue(release.wait(3))
            return result

        with patch.object(facts, 'read', side_effect=blocked), ThreadPoolExecutor(2) as pool:
            old = pool.submit(facts.get, entry)
            try:
                self.assertTrue(entered.wait(1))
                self.file('a.jpg', 2)
                attributes = (self.root / 'a.jpg').stat()
                version = (attributes.st_dev, attributes.st_ino, attributes.st_mtime_ns, attributes.st_size)
                current = pool.submit(facts.get, entry, expected_version=version)
                deadline = monotonic() + 1
                while monotonic() < deadline:
                    with facts.cache.lock:
                        joined = any(len(load.consumers) == 2 for load in facts.cache.pending.values())
                    if joined:
                        break
                    sleep(.005)
                self.assertTrue(joined, 'Info must join the pending read to exercise the version race')
            finally:
                release.set()
            old.result(timeout=3)
            self.assertEqual(current.result(timeout=3).source_version, version)
            self.assertEqual(facts.get(entry).modified.key, 2)

    def test_removed_natural_anchor_is_reported_without_losing_insertion_point_seeking(self):
        self.file('a.jpg', 1); self.file('b.jpg', 2)
        for ordering in (Ordering(), Ordering(order='desc')):
            with self.subTest(ordering=ordering):
                page = self.gallery.walk(anchor='aa.jpg', ordering=ordering)
                self.assertTrue(page['anchor_missing'])
                self.assertEqual(page['images'], ['b.jpg'] if ordering.order == 'asc' else ['a.jpg'])
        with self.assertRaisesRegex(ValueError, 'no longer listed'):
            self.gallery.walk(anchor='aa.jpg', ordering=Ordering('modified'))
