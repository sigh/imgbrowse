"""Shared work, refresh races, resource bounds, and traversal reuse."""

import tempfile
import threading
import unittest
import zipfile
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from image_browser.app import Gallery
from image_browser.runtime.cache import SharedCache
from image_browser.runtime.work import Cancelled
from image_browser.storage.archives import ArchiveCache


class CacheTests(unittest.TestCase):
    def test_error_retention_is_an_explicit_policy(self):
        cache = SharedCache(1024)
        with self.assertRaises(ValueError):
            cache.get('key', lambda: (_ for _ in ()).throw(ValueError('bad')))
        self.assertEqual(cache.get('key', lambda: 'recovered'), 'recovered')
        cache = SharedCache(1024, cache_errors=lambda error: isinstance(error, ValueError))
        with self.assertRaises(ValueError):
            cache.get('key', lambda: (_ for _ in ()).throw(ValueError('bad')))
        with self.assertRaisesRegex(ValueError, 'bad'):
            cache.get('key', lambda: self.fail('A retained failure must not reload'))

    def test_scoped_invalidation_preserves_unrelated_pending_load(self):
        cache = SharedCache(100)
        entered, release = threading.Event(), threading.Event()
        def load():
            entered.set(); release.wait(2)
            return b'alive'
        with ThreadPoolExecutor(1) as pool:
            pending = pool.submit(cache.get, 'B', load, len)
            self.assertTrue(entered.wait(1))
            cache.invalidate(lambda key: key == 'A')
            release.set()
            self.assertEqual(pending.result(), b'alive')
        self.assertEqual(cache.get('B', lambda: self.fail('Unrelated work was discarded')), b'alive')

    def test_cancelled_load_does_not_unregister_its_replacement(self):
        cache = SharedCache(100)
        entered, release = threading.Event(), threading.Event()
        first = Future()
        replacements = []

        def replacement():
            entered.set()
            self.assertTrue(release.wait(2))
            return b'new'

        def cancelled():
            raise Cancelled()

        with ThreadPoolExecutor(2) as pool:
            def retry(_):
                replacements.append(pool.submit(cache.get, 'key', replacement))
                self.assertTrue(entered.wait(2))
            first.add_done_callback(retry)
            with patch('image_browser.runtime.cache.Future', side_effect=[first, Future()]):
                old = pool.submit(cache.get, 'key', cancelled)
                try:
                    with self.assertRaises(Cancelled):
                        old.result(timeout=2)
                    with cache.lock:
                        self.assertEqual(len(cache.pending), 1, 'Replacement must remain available to shared consumers')
                finally:
                    release.set()
                self.assertEqual(replacements[0].result(timeout=2), b'new')

    def test_parallel_requests_share_one_load(self):
        cache = SharedCache(100)
        entered, release = threading.Event(), threading.Event()
        calls = []
        def load():
            calls.append(1)
            entered.set()
            release.wait(2)
            return b'data'
        with ThreadPoolExecutor(4) as pool:
            tasks = [pool.submit(cache.get, 'same', load, len) for _ in range(4)]
            self.assertTrue(entered.wait(1))
            release.set()
            self.assertEqual([task.result() for task in tasks], [b'data'] * 4)
        self.assertEqual(len(calls), 1)

    def test_refresh_does_not_repopulate_from_old_pending_load(self):
        cache = SharedCache(100)
        entered, release = threading.Event(), threading.Event()
        def old():
            entered.set(); release.wait(2)
            return b'old'
        with ThreadPoolExecutor() as pool:
            task = pool.submit(cache.get, 'key', old, len)
            self.assertTrue(entered.wait(1))
            cache.invalidate()
            self.assertEqual(cache.get('key', lambda: b'new', len), b'new')
            release.set(); task.result()
        self.assertEqual(cache.get('key', lambda: self.fail('reloaded')), b'new')

    def test_memory_bound(self):
        cache = SharedCache(10)
        for key in range(100):
            cache.get(key, lambda: b'123456', len)
            self.assertLessEqual(cache.weight, 10)
        self.assertEqual(len(cache.entries), 1)

    def test_neighbors_share_listing_until_refresh(self):
        with tempfile.TemporaryDirectory() as root:
            for name in ('1.jpg', '2.jpg', '3.jpg'):
                (Path(root) / name).write_bytes(b'fixture')
            gallery = Gallery(root)
            with patch.object(gallery.storage, 'children', wraps=gallery.storage.children) as scan:
                gallery.listing('')
                for _ in range(10):
                    gallery.walk(anchor='2.jpg', limit=1)
                    gallery.walk(anchor='2.jpg', limit=1, reverse=True)
                    gallery.representative('')
                self.assertEqual(scan.call_count, 1)
                (Path(root) / '4.jpg').write_bytes(b'fixture')
                gallery.invalidate('')
                self.assertIn('4.jpg', gallery.listing('')['images'])
                self.assertEqual(scan.call_count, 2)

    def test_archive_members_reuse_reader_and_active_lease_survives_refresh(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'book.cbz'
            with zipfile.ZipFile(file, 'w') as archive:
                for i in range(12):
                    archive.writestr(f'{i}.jpg', b'fixture')
            cache = ArchiveCache()
            with patch('image_browser.storage.archives.zipfile.ZipFile', wraps=zipfile.ZipFile) as open_archive:
                reader = cache.get(file)
                for i in range(12):
                    self.assertIs(cache.get(file), reader)
                self.assertEqual(reader.read(reader.member(f'{i}.jpg')), b'fixture')
                self.assertEqual(open_archive.call_count, 1)
                cache.invalidate()
                self.assertEqual(reader.read(reader.member('0.jpg')), b'fixture')


class SchedulingTests(unittest.TestCase):
    def test_background_work_leaves_capacity_for_navigation(self):
        from image_browser.runtime.work import WorkGate, request_work

        gate = WorkGate(capacity=2, background=1)
        running, release, demand_done = threading.Event(), threading.Event(), threading.Event()
        def background():
            with request_work(2), gate:
                running.set()
                release.wait(2)
        def demand():
            with request_work(0), gate:
                demand_done.set()
        with ThreadPoolExecutor(2) as pool:
            job = pool.submit(background)
            self.assertTrue(running.wait(1))
            request = pool.submit(demand)
            try:
                self.assertTrue(demand_done.wait(1))
            finally:
                release.set()
            job.result(); request.result()

    def test_cancelled_queued_work_does_not_run(self):
        from image_browser.runtime.work import Cancelled, WorkGate, request_work

        gate = WorkGate(capacity=1, background=1)
        stop = threading.Event()
        def queued():
            with request_work(2, stop.is_set), gate:
                self.fail('Cancelled job started')
        with gate, ThreadPoolExecutor(1) as pool:
            job = pool.submit(queued)
            stop.set()
            with self.assertRaises(Cancelled):
                job.result(timeout=1)
