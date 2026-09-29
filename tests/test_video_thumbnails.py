"""Optional video preview extraction, reuse, and process cleanup."""

import io
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from image_browser.sources import MediaSource
from image_browser.thumbnails import ThumbnailCache
from image_browser.video_thumbnails import render_video_thumbnail, video_metadata
from image_browser.work import Cancelled

FIXTURE = Path(__file__).parent / 'fixtures' / 'sample.webm'


class VideoThumbnailTests(unittest.TestCase):
    def test_optional_dependency(self):
        with patch('image_browser.video_thumbnails.shutil.which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'FFmpeg'):
                render_video_thumbnail(FIXTURE, (400, 300))

    def test_cache_reuse_and_invalidation(self):
        cache = ThumbnailCache()
        source = MediaSource(FIXTURE, FIXTURE.stat())
        with patch('image_browser.thumbnails.render_video_thumbnail', return_value=b'jpeg') as render:
            self.assertEqual(cache.get_video(source), b'jpeg')
            self.assertEqual(cache.get_video(source), b'jpeg')
            self.assertEqual(render.call_count, 1)
            cache.invalidate()
            cache.get_video(source)
            self.assertEqual(render.call_count, 2)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg is optional')
    def test_real_frame_and_short_clip_fallback(self):
        def verify(path):
            data = render_video_thumbnail(path, (400, 300))
            with Image.open(io.BytesIO(data)) as image:
                self.assertEqual(image.format, 'JPEG')
                self.assertLessEqual(image.width, 400)
                self.assertLessEqual(image.height, 300)
        verify(FIXTURE)
        if shutil.which('ffprobe'):
            self.assertAlmostEqual(video_metadata(FIXTURE)['duration'], 2, delta=.1)
        with tempfile.TemporaryDirectory() as directory:
            short = Path(directory) / 'short.webm'
            subprocess.run([shutil.which('ffmpeg'), '-loglevel', 'error', '-i', str(FIXTURE),
                            '-t', '0.2', '-c', 'copy', str(short)], check=True)
            verify(short)

    def test_timeout_and_cancellation_reap_child(self):
        popen = subprocess.Popen
        for cancelled in (False, True):
            children = []
            def start(*_args, **kwargs):
                child = popen([sys.executable, '-c', 'import time; time.sleep(30)'], **kwargs)
                children.append(child)
                return child
            with patch('image_browser.video_thumbnails.shutil.which', return_value='ffmpeg'), \
                 patch('image_browser.video_thumbnails.subprocess.Popen', side_effect=start), \
                 patch('image_browser.video_thumbnails.EXTRACTION_TIMEOUT', .05), \
                 patch('image_browser.video_thumbnails.check_cancelled',
                       side_effect=[None, Cancelled()] if cancelled else None):
                with self.assertRaises(Cancelled if cancelled else ValueError):
                    render_video_thumbnail(FIXTURE, (400, 300))
            self.assertEqual(len(children), 1)
            self.assertIsNotNone(children[0].returncode)
