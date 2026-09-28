"""On-demand thumbnail generation with a bounded in-memory LRU cache."""

import io
from pathlib import Path

from PIL import Image, ImageOps

from .cache import SharedCache
from .work import ByteBudget, WorkGate

DEFAULT_CACHE_BYTES = 64 * 1024 * 1024
THUMBNAIL_SIZE = (400, 300)
JPEG_QUALITY = 78
ARCHIVE_BUFFER_BUDGET = ByteBudget(128 * 1024 * 1024)
DECODE_BUDGET = ByteBudget(256 * 1024 * 1024)


def render_thumbnail(file) -> bytes:
    """Resize before orientation correction to avoid copying full-size pixels."""
    draft_edge = max(THUMBNAIL_SIZE)
    draft_size = (draft_edge, draft_edge)
    with Image.open(file) as image:
        image.draft('RGB', draft_size)
        with DECODE_BUDGET.reserve(image.width * image.height * 4):
            image.thumbnail(draft_size)
            image = ImageOps.exif_transpose(image)
            image.thumbnail(THUMBNAIL_SIZE)
            output = io.BytesIO()
            image.convert('RGB').save(output, 'JPEG', quality=JPEG_QUALITY)
            return output.getvalue()


class ThumbnailCache:
    """Share pending decodes and retain encoded bytes within a memory budget."""

    def __init__(self, max_bytes=DEFAULT_CACHE_BYTES, workers=4):
        self.max_bytes = max_bytes
        self.cache = SharedCache(max_bytes)
        self.workers = WorkGate(workers, max(1, workers - 1))

    @property
    def bytes_used(self):
        return self.cache.weight

    def get(self, file: Path, stat) -> bytes:
        key = (str(file), stat.st_mtime_ns, stat.st_size)
        return self._get(key, lambda: file)

    def get_archive(self, key, read_member, size=0) -> bytes:
        return self._get(key, lambda: io.BytesIO(read_member()), size)

    def _get(self, key, source, size=0):
        def load():
            with self.workers, ARCHIVE_BUFFER_BUDGET.reserve(size):
                return render_thumbnail(source())
        return self.cache.get(key, load, len)

    def invalidate(self):
        self.cache.invalidate()
