"""Cold sorting has an explicit, cancellable lifetime outside cache retention."""

import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from image_browser.app import Gallery
from image_browser.catalog.errors import OrderTooLarge, StaleView
from image_browser.catalog.ordering import Ordering
from image_browser.catalog.preparation import Preparing
from image_browser.http.catalog_api import CatalogApi
from image_browser.runtime.work import Busy


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for folder in ('A', 'B', 'C'):
            (self.root / folder).mkdir()
            for name, date in [('a.jpg', 2), ('b.jpg', 1)]:
                file = self.root / folder / name
                file.write_bytes(b'fixture')
                os.utime(file, ns=(date, date))
        self.gallery = Gallery(self.root)
        self.preparations = self.gallery.catalog.preparations

    def prepare(self, path, token=None):
        with self.preparations.required(token):
            return CatalogApi(self.gallery).folder_index(path, ordering=Ordering('modified'))

    def pending(self, path, token=None):
        with self.assertRaises(Preparing) as raised:
            self.prepare(path, token)
        return raised.exception.progress

    def wait_ready(self, path, token):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                return self.prepare(path, token)
            except Preparing:
                time.sleep(.005)
        self.fail('Preparation did not finish')

    def test_shared_leases_progress_and_reuse_across_directions_without_retention(self):
        entered, release = threading.Event(), threading.Event()
        read = self.gallery.catalog.facts.read
        def blocked(entry):
            entered.set()
            self.assertTrue(release.wait(3))
            return read(entry)
        self.gallery.catalog.indexes.max_weight = self.gallery.catalog.views.max_weight = 1
        with patch.object(self.gallery.catalog.facts, 'read', side_effect=blocked) as reads:
            first = self.pending('A')
            self.assertEqual(first['total'], 2)
            self.assertTrue(entered.wait(1))
            second = self.pending('A')
            self.assertNotEqual(first['token'], second['token'])
            self.assertEqual(len(self.preparations.running), 1)
            self.preparations.cancel(first['token'])
            release.set()
            ready = self.wait_ready('A', second['token'])
            self.assertEqual([item['name'] for item in ready['items']], ['b.jpg', 'a.jpg'])
            with self.preparations.required():
                reverse = CatalogApi(self.gallery).folder_index('A', ordering=Ordering('modified', 'desc'))
            self.assertEqual([item['name'] for item in reverse['items']], ['a.jpg', 'b.jpg'])
            self.assertEqual(reads.call_count, 2)

    def test_capacity_counts_cancelled_work_until_its_storage_call_returns(self):
        entered, release = threading.Event(), threading.Event()
        read = self.gallery.catalog.facts.read
        def blocked(entry):
            entered.set(); release.wait(3)
            return read(entry)
        try:
            with patch.object(self.gallery.catalog.facts, 'read', blocked):
                a, b = self.pending('A'), self.pending('B')
                self.assertTrue(entered.wait(1))
                with self.assertRaises(Busy):
                    self.prepare('C')
                self.preparations.cancel(a['token'])
                with self.assertRaises(Busy):
                    self.prepare('C')
                self.assertLessEqual(len(self.preparations.running), 2)
                release.set()
                self.wait_ready('B', b['token'])
        finally:
            release.set()

    def test_related_refresh_cancels_only_its_preparation(self):
        entered, release = threading.Event(), threading.Event()
        read = self.gallery.catalog.facts.read
        def blocked(entry):
            entered.set(); release.wait(3)
            return read(entry)
        try:
            with patch.object(self.gallery.catalog.facts, 'read', blocked):
                a, b = self.pending('A'), self.pending('B')
                self.assertTrue(entered.wait(1))
                self.gallery.invalidate('A')
                self.assertFalse(any(a['token'] in job.leases for job in self.preparations.jobs.values()))
                self.assertTrue(any(b['token'] in job.leases for job in self.preparations.jobs.values()))
                release.set()
                self.wait_ready('B', b['token'])
        finally:
            release.set()

    def test_oversize_preparation_is_explicit_and_natural_browsing_still_works(self):
        self.preparations.MAX_BYTES = 1
        with self.assertRaises(OrderTooLarge):
            self.prepare('A')
        self.assertEqual(len(self.preparations.running), 0)
        self.assertEqual(len(CatalogApi(self.gallery).folder_index('A')['items']), 2)

    def test_oversize_walk_does_not_publish_an_empty_unreadable_branch(self):
        self.preparations.MAX_BYTES = 1
        with self.preparations.required(), self.assertRaises(OrderTooLarge):
            self.gallery.walk(root='A', ordering=Ordering('modified'))

    def test_new_root_image_facts_preserve_unrelated_child_preparation(self):
        file = self.root / 'root.jpg'
        file.write_bytes(b'fixture'); os.utime(file, ns=(1,1))
        CatalogApi(self.gallery).folder_index('', ordering=Ordering('modified'))
        entered, release = threading.Event(), threading.Event()
        read = self.gallery.catalog.facts.read
        def blocked(entry):
            if entry.path.startswith('B/'):
                entered.set(); release.wait(3)
            return read(entry)
        try:
            with patch.object(self.gallery.catalog.facts, 'read', blocked):
                b = self.pending('B')
                self.assertTrue(entered.wait(1))
                os.utime(file, ns=(2,2))
                self.gallery.catalog.facts.cache.invalidate(lambda key: key[0] == 'root.jpg')
                with self.assertRaises(StaleView):
                    CatalogApi(self.gallery).entry_page('', [{'name':'root.jpg','type':'image'}])
                self.assertTrue(any(b['token'] in job.leases for job in self.preparations.jobs.values()))
                release.set()
                self.wait_ready('B', b['token'])
        finally:
            release.set()
