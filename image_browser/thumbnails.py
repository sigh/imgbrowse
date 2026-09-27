"""On-demand thumbnail generation with a bounded in-memory LRU cache."""

import io
import threading
from collections import OrderedDict
from pathlib import Path

from PIL import Image, ImageOps

DEFAULT_CACHE_BYTES = 64 * 1024 * 1024
THUMBNAIL_SIZE = (400, 300)
JPEG_QUALITY = 78


def render_thumbnail(file: Path) -> bytes:
    """Resize before orientation correction to avoid copying full-size pixels."""
    draft_edge = max(THUMBNAIL_SIZE)
    draft_size = (draft_edge, draft_edge)
    with Image.open(file) as image:
        image.draft('RGB', draft_size)
        image.thumbnail(draft_size)
        image = ImageOps.exif_transpose(image)
        image.thumbnail(THUMBNAIL_SIZE)
        output = io.BytesIO()
        image.convert('RGB').save(output, 'JPEG', quality=JPEG_QUALITY)
        return output.getvalue()


class ThumbnailCache:
    """Store encoded bytes; file identity changes invalidate old cache keys."""

    def __init__(self, max_bytes=DEFAULT_CACHE_BYTES, workers=4):
        self.max_bytes = max_bytes
        self.bytes_used = 0
        self._entries = OrderedDict()
        self._lock = threading.Lock()
        self._workers = threading.BoundedSemaphore(workers)

    def get(self, file: Path, stat) -> bytes:
        key = (str(file), stat.st_mtime_ns, stat.st_size)
        cached = self._lookup(key)
        if cached is not None:
            return cached
        with self._workers:
            # Another worker may have populated the cache while we were waiting.
            cached = self._lookup(key)
            if cached is not None:
                return cached
            data = render_thumbnail(file)
            self._store(key, data)
            return data

    def _lookup(self, key):
        with self._lock:
            data = self._entries.get(key)
            if data is not None:
                self._entries.move_to_end(key)
            return data

    def _store(self, key, data):
        with self._lock:
            if key in self._entries or len(data) > self.max_bytes:
                return
            self._entries[key] = data
            self.bytes_used += len(data)
            while self.bytes_used > self.max_bytes:
                _, evicted = self._entries.popitem(last=False)
                self.bytes_used -= len(evicted)
