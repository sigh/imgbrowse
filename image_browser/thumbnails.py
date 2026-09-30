"""On-demand thumbnail generation with a bounded in-memory LRU cache."""

import io
from hashlib import sha256

from PIL import Image, ImageOps

from .cache import SharedCache
from .video_thumbnails import render_video_thumbnail, video_metadata
from .work import ByteBudget, WorkGate

DEFAULT_CACHE_BYTES = 64 * 1024 * 1024
THUMBNAIL_SIZE = (400, 300)
JPEG_QUALITY = 78
THUMBNAIL_RECIPE = ('jpeg-v1', THUMBNAIL_SIZE, JPEG_QUALITY)
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
        self.video_workers = WorkGate(1, 1)
        self.metadata = SharedCache(1024 * 1024)

    @property
    def bytes_used(self):
        return self.cache.weight

    @property
    def generation(self):
        return self.cache.generation

    @staticmethod
    def key(source):
        return source.cache_key, THUMBNAIL_RECIPE

    def etag(self, source):
        return 'W/"' + sha256(repr(self.key(source)).encode()).hexdigest() + '"'

    def cached_video_info(self, source):
        return self.metadata.peek(source.cache_key) if source.kind == 'video' else None

    def get(self, source, archives=None, archive_work=None, *, generation=None) -> bytes:
        """Render a resolved source; folder covers and direct media share this cache."""
        def load():
            if source.kind == 'video':
                with self.video_workers:
                    return render_video_thumbnail(source.file, THUMBNAIL_SIZE)
            size = source.size if source.member is not None else 0
            with self.workers, ARCHIVE_BUFFER_BUDGET.reserve(size):
                file = io.BytesIO(source.read_member(archives, archive_work)) if source.member else source.file
                return render_thumbnail(file)
        return self.cache.get(self.key(source), load, len, generation=generation)

    def video_info(self, source):
        def load():
            with self.video_workers:
                return video_metadata(source.file)
        return self.metadata.get(source.cache_key, load, lambda _: 128)

    def invalidate(self):
        self.cache.invalidate()
        self.metadata.invalidate()
