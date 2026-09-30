"""Folder covers are complete representations, independent of directory depth."""

import io
import json
import os
import tempfile
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from pathlib import Path
from threading import Event, Thread
from time import monotonic, sleep
from unittest.mock import patch
from urllib.parse import urlencode

from PIL import Image

from image_browser.server import GalleryServer
from image_browser.thumbnails import render_thumbnail
from image_browser.work import Cancelled, Invalidated, request_work


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = GalleryServer(('127.0.0.1', 0), self.root)
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.gallery = self.server.gallery

    def image(self, path, color='blue'):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (40, 60), color).save(file)
        return file

    def request(self, path, method='GET', headers=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request(method, '/thumbnail?' + urlencode({'path': path}), headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_one_response_completes_a_deep_branch_and_reuses_direct_thumbnail(self):
        branch = '/'.join(['deep'] * 28)
        path = branch + '/1.jpg'
        self.image(path)
        with patch('image_browser.thumbnails.render_thumbnail', wraps=render_thumbnail) as render:
            status, headers, body = self.request('deep')
            self.assertEqual(status, 200)
            self.assertEqual(headers['X-Media-Kind'], 'image')
            self.assertEqual(Image.open(io.BytesIO(body)).format, 'JPEG')
            with patch.object(self.gallery, '_listing', side_effect=AssertionError('rescanned')):
                self.assertEqual(self.request('deep')[2], body)
                self.assertEqual(self.request(path)[2], body)
            self.assertEqual(render.call_count, 1)

    def test_direct_thumbnail_reuses_recent_source_validation(self):
        self.image('book/1.jpg')
        source = self.gallery.source('book/1.jpg')
        with patch.object(Path, 'lstat', side_effect=AssertionError('Repeated path validation')):
            self.assertEqual(self.gallery.thumbnail_source('book/1.jpg'), source)
            self.assertEqual(self.request('book/1.jpg')[0], 200)
        self.gallery.invalidate('book')
        with patch.object(self.gallery, '_locate', wraps=self.gallery._locate) as locate:
            self.gallery.thumbnail_source('book/1.jpg')
            self.assertEqual(locate.call_count, 1)

    def test_empty_first_branch_does_not_search_siblings(self):
        (self.root / 'book/first/empty').mkdir(parents=True)
        self.image('book/second/1.jpg')
        with patch.object(self.gallery, '_listing', wraps=self.gallery._listing) as listing:
            status, headers, body = self.request('book')
            self.assertEqual((status, body), (204, b''))
            self.assertNotIn('Content-Length', headers)
            self.assertEqual([call.args[0] for call in listing.call_args_list],
                             ['book', 'book/first', 'book/first/empty'])
        self.assertEqual(self.request('missing')[0], 404)

    def test_conditional_and_head_skip_body_and_conditional_skips_render(self):
        self.image('book/1.jpg')
        status, headers, body = self.request('book')
        self.assertEqual(status, 200)
        with patch.object(self.server.previews, 'render', side_effect=AssertionError('rendered')):
            conditional = self.request('book', headers={'If-None-Match': headers['ETag']})
            self.assertEqual((conditional[0], conditional[2]), (304, b''))
            self.assertIn('Cache-Control', conditional[1])
        head = self.request('book', method='HEAD')
        self.assertEqual((head[0], head[2], int(head[1]['Content-Length'])), (200, b'', len(body)))

    def test_refresh_clears_ancestor_selection_and_listing_and_negative_cover(self):
        (self.root / 'book/first').mkdir(parents=True)
        old = self.image('book/second/1.jpg')
        self.assertEqual(self.request('book')[0], 204)
        self.image('book/first/1.jpg', 'red')
        self.gallery.invalidate('book/first')
        first = self.request('book')
        self.assertEqual(first[0], 200)
        (self.root / 'book/first/1.jpg').unlink()
        (self.root / 'book/first').rmdir()
        self.gallery.invalidate('book/first')
        self.assertEqual(self.request('book')[2], self.request(str(old.relative_to(self.root)))[2])

    def test_validator_includes_selected_file_identity(self):
        first = self.image('book/1.jpg')
        second = self.root / 'book/2.jpg'
        second.write_bytes(first.read_bytes())
        timestamp = first.stat().st_mtime_ns
        os.utime(second, ns=(timestamp, timestamp))
        old = self.request('book')[1]['ETag']
        first.unlink()
        self.gallery.invalidate('book')
        status, headers, _ = self.request('book', headers={'If-None-Match': old})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers['ETag'], old)

    def test_refresh_between_preparation_and_render_rejects_old_work(self):
        self.image('book/1.jpg')
        prepared = self.server.previews.prepare('book')
        self.gallery.invalidate('book')
        with patch.object(self.server.thumbnails, 'get', side_effect=AssertionError('rendered')), \
                self.assertRaises(Invalidated):
            self.server.previews.render(prepared)

    def test_shared_selection_survives_owner_cancellation(self):
        self.image('book/chapter/1.jpg')
        entered, release, cancel_owner = Event(), Event(), Event()
        original = self.gallery._representative

        def select(*args):
            entered.set()
            self.assertTrue(release.wait(3))
            return original(*args)

        def cover(cancel):
            with request_work(2, cancel):
                prepared = self.server.previews.prepare('book')
                return self.server.previews.render(prepared)

        with patch.object(self.gallery, '_representative', side_effect=select) as selection, ThreadPoolExecutor(2) as pool:
            owner = pool.submit(cover, cancel_owner.is_set)
            self.assertTrue(entered.wait(2))
            follower = pool.submit(cover, lambda: False)
            try:
                joined = False
                deadline = monotonic() + 2
                while monotonic() < deadline:
                    with self.gallery.previews.lock:
                        joined = any(len(consumers) == 2 for _, consumers in self.gallery.previews.pending.values())
                    if joined:
                        break
                    sleep(.005)
                self.assertTrue(joined)
                cancel_owner.set()
            finally:
                release.set()
            with self.assertRaises(Cancelled):
                owner.result(timeout=3)
            self.assertTrue(follower.result(timeout=3))
            self.assertEqual(selection.call_count, 1)

    def test_abandoned_cover_stops_before_next_directory_or_decode(self):
        self.image('book/chapter/1.jpg')
        cancel = Event()
        original = self.gallery.listing

        def listing(*args, **kwargs):
            result = original(*args, **kwargs)
            cancel.set()
            return result

        with request_work(2, cancel.is_set), patch.object(self.gallery, 'listing', side_effect=listing) as scan, \
             patch.object(self.server.thumbnails, 'get', side_effect=AssertionError('decoded abandoned cover')):
            with self.assertRaises(Cancelled):
                self.server.previews.prepare('book')
            self.assertEqual(scan.call_count, 1)

    def test_archive_and_suffix_named_directory_covers(self):
        file = self.image('photo.jpg/1.jpg')
        with zipfile.ZipFile(self.root / 'book.cbz', 'w') as archive:
            archive.writestr('chapter/1.jpg', file.read_bytes())
        for path in ('photo.jpg', 'book.cbz', 'book.cbz/chapter'):
            self.assertEqual(self.request(path)[0], 200, path)

    def test_refresh_during_archive_classification_cannot_cache_old_index(self):
        first = self.image('first.jpg').read_bytes()
        second = self.image('second.jpg', 'red').read_bytes()
        archive_path = self.root / 'book.cbz'
        with zipfile.ZipFile(archive_path, 'w') as archive:
            archive.writestr('chapter/1.jpg', first)
        original = self.gallery._locate

        def locate(path):
            result = original(path)
            with zipfile.ZipFile(archive_path, 'w') as archive:
                archive.writestr('other/2.jpg', second)
            self.gallery.invalidate('book.cbz/chapter')
            return result

        with patch.object(self.gallery, '_locate', side_effect=locate):
            self.assertEqual(self.request('book.cbz')[0], 503)
        self.assertEqual(self.request('book.cbz')[0], 200)
        self.assertEqual(self.gallery.representative('book.cbz'), 'book.cbz/other/2.jpg')

    def test_refresh_inside_archive_invalidates_sibling_covers(self):
        first = self.image('first.jpg').read_bytes()
        archive_path = self.root / 'book.cbz'
        with zipfile.ZipFile(archive_path, 'w') as archive:
            archive.writestr('one/1.jpg', first)
            archive.writestr('two/1.jpg', first)
        self.assertEqual(self.request('book.cbz/two')[0], 200)
        with zipfile.ZipFile(archive_path, 'w') as archive:
            archive.writestr('one/1.jpg', first)
            archive.writestr('two/2.jpg', first)
        self.gallery.invalidate('book.cbz/one')
        self.assertEqual(self.request('book.cbz/two')[0], 200)
        self.assertEqual(self.gallery.representative('book.cbz/two'), 'book.cbz/two/2.jpg')

    def test_video_cover_does_not_probe_metadata_and_unavailability_is_explicit(self):
        (self.root / 'videos').mkdir()
        (self.root / 'videos/1.mp4').write_bytes(b'video')
        with patch('image_browser.thumbnails.render_video_thumbnail', return_value=b'jpeg'), \
             patch('image_browser.thumbnails.video_metadata', side_effect=AssertionError('ffprobe')):
            status, headers, body = self.request('videos')
            self.assertEqual((status, body, headers['X-Media-Kind']), (200, b'jpeg', 'video'))
            self.assertNotIn('X-Video-Duration', headers)
        self.server.thumbnails.invalidate()
        with patch('image_browser.thumbnails.render_video_thumbnail', side_effect=ValueError('No FFmpeg')):
            status, _, body = self.request('videos')
            self.assertEqual(status, 422)
            self.assertEqual(json.loads(body)['code'], 'video_preview_unavailable')

    def test_corrupt_hidden_and_symlink_paths_do_not_become_empty_covers(self):
        (self.root / 'bad.jpg').write_bytes(b'broken')
        self.image('.hidden/1.jpg')
        self.image('real/1.jpg')
        (self.root / 'link').symlink_to(self.root / 'real', target_is_directory=True)
        self.assertEqual(self.request('bad.jpg')[0], 422)
        self.assertEqual(self.request('.hidden')[0], 400)
        self.assertEqual(self.request('link')[0], 403)
