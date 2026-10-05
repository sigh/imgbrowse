"""Prepare and render previews without HTTP or a second layer of caches."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from image_browser.media.sources import MediaSource
from image_browser.runtime.work import Invalidated, check_cancelled


@dataclass(frozen=True)
class PreparedPreview:
    source: MediaSource | None
    valid: Callable[[], bool]
    etag: str | None


class PreviewService:
    def __init__(self, gallery, thumbnails, archive_work):
        self.gallery = gallery
        self.thumbnails = thumbnails
        self.archive_work = archive_work

    def check(self, preview):
        check_cancelled()
        if not preview.valid():
            raise Invalidated('Refreshed during request')

    def prepare(self, path, kind=None):
        valid = self.gallery.refresh.watch(path)
        source = self.gallery.thumbnail_source(path, kind=kind)
        etag = self.thumbnails.etag(source) if source else None
        preview = PreparedPreview(source, valid, etag)
        self.check(preview)
        return preview

    def render(self, preview):
        self.check(preview)
        if preview.source is None:
            raise ValueError('An empty preview has no image to render')
        data = self.thumbnails.get(preview.source, self.gallery.archives, self.archive_work,
                                   valid=preview.valid)
        self.check(preview)
        return data

    def metadata(self, preview):
        source = preview.source
        if source is None:
            return {'media_kind': None, 'duration': None}
        info = self.thumbnails.cached_video_info(source) or {}
        return {'media_kind': source.kind, 'duration': info.get('duration')}
