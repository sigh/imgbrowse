"""Thumbnail cache behavior, invalidation, bounds, and image orientation."""

import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from image_browser.media.sources import MediaSource
from image_browser.media.thumbnails import ThumbnailCache


class ThumbnailTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = ThumbnailCache()

    def image(self, name):
        Image.new('RGB', (12, 18), 'blue').save(self.root / name)
        return name

    def test_thumbnail_reuse_and_file_change(self):
        path = self.root / self.image('page.jpg')
        first = self.cache.get(MediaSource(path, path.stat()))
        with patch('image_browser.media.thumbnails.Image.open', side_effect=AssertionError('decoded twice')):
            self.assertEqual(self.cache.get(MediaSource(path, path.stat())), first)
        timestamp = path.stat().st_mtime_ns
        Image.new('RGB', (20, 20), 'red').save(path)
        os.utime(path, ns=(timestamp + 1_000_000, timestamp + 1_000_000))
        self.assertNotEqual(self.cache.get(MediaSource(path, path.stat())), first)

    def test_thumbnail_memory_bound_and_orientation(self):
        path = self.root / 'rotated.jpg'
        image = Image.new('RGB', (1000, 500), 'blue')
        exif = image.getexif()
        exif[274] = 6  # Rotate clockwise for display.
        image.save(path, exif=exif)
        data = self.cache.get(MediaSource(path, path.stat()))
        with Image.open(io.BytesIO(data)) as thumbnail:
            self.assertLess(thumbnail.width, thumbnail.height)
            self.assertLessEqual(thumbnail.height, 300)
        budget = len(data) + 100
        self.cache = ThumbnailCache(max_bytes=budget)
        for name in ('a.jpg', 'b.jpg', 'c.jpg'):
            path = self.root / self.image(name)
            self.cache.get(MediaSource(path, path.stat()))
            self.assertLessEqual(self.cache.bytes_used, budget)
