"""Select natural-order collection covers without decoding media."""

from pathlib import PurePosixPath

from image_browser.catalog.errors import InvalidSelection
from image_browser.catalog.limits import MAX_CURSOR_DEPTH
from image_browser.catalog.model import ENTRY_TYPES
from image_browser.runtime.cache import SharedCache
from image_browser.runtime.work import check_cancelled


class CoverSelector:
    def __init__(self, storage, catalog, refresh):
        self.storage = storage
        self.catalog = catalog
        self.refresh = refresh
        self.cache = SharedCache(4 * 1024 * 1024)

    def invalidate(self, related):
        self.cache.invalidate(related)

    def representative(self, relative, *, entry=None, valid=None):
        """Return the first branch's media path, never traversal instructions."""
        self.storage.validate(relative)
        valid = valid or self.refresh.watch(relative)
        return self.cache.get(relative, lambda: self._select(relative, entry, valid),
                                 lambda value: 256 + len(str(value)) * 2, valid=valid)

    def _select(self, relative, entry, valid):
        if entry is None:
            with self.storage.work:
                entry = self.storage.locate(relative)
        for _ in range(MAX_CURSOR_DEPTH):
            check_cancelled()
            listing = self.catalog.snapshot(relative, entry=entry, valid=valid).view.groups
            check_cancelled()
            if listing['images']:
                return str(PurePosixPath(relative) / listing['images'][0])
            if not listing['folders']:
                return None
            child = listing['folders'][0]
            relative = str(PurePosixPath(relative) / child)
            with self.storage.work:
                entry = self.storage.child_entry(entry, child)
        raise ValueError('Folder nesting exceeds the preview depth limit')

    def thumbnail_source(self, relative, *, kind=None):
        """Resolve media or a container cover to a single versioned source."""
        valid = self.refresh.watch(relative)
        self.storage.validate(relative)
        if kind is not None and kind not in ENTRY_TYPES.values():
            raise InvalidSelection('Invalid item type')
        if kind in ('image', 'file'):
            with self.storage.work:
                entry = self.storage.locate(relative)
                self.storage.describe(relative, entry=entry, kind=kind)
            return self.storage.source(relative, entry=entry, valid=valid)
        # Reuse the same short-lived source validation as original-media requests.
        cached = self.storage.sources.peek(relative)
        if cached is not None and kind != 'folder' and cached.member is None:
            return self.storage.source(relative, valid=valid)
        with self.storage.work:
            entry = self.storage.locate(relative)
            if kind == 'folder':
                self.storage.describe(relative, entry=entry, kind=kind)
        if not entry.is_container:
            return self.storage.source(relative, entry=entry, valid=valid)
        selected = self.representative(relative, entry=entry, valid=valid)
        return self.storage.source(selected, valid=valid) if selected is not None else None
