"""Compose storage, catalog queries, traversal, and media services."""

from image_browser.catalog.limits import PAGE_SIZE
from image_browser.catalog.ordering import DEFAULT_ORDERING
from image_browser.catalog.repository import CatalogRepository
from image_browser.catalog.traversal import Traversal
from image_browser.media.covers import CoverSelector
from image_browser.media.previews import PreviewService
from image_browser.media.thumbnails import ThumbnailCache
from image_browser.runtime.refresh import RefreshScopes, intersects
from image_browser.runtime.work import WorkGate
from image_browser.storage.archives import ArchiveCache
from image_browser.storage.collection import CollectionStorage


class Gallery:
    def __init__(self, root, exclude=()):
        self.directory_work = WorkGate()
        self.refresh = RefreshScopes()
        self.archives = ArchiveCache(exclude)
        self.storage = CollectionStorage(root, exclude, self.directory_work, self.archives)
        self.catalog = CatalogRepository(lambda path, entry=None: self.storage.children(path, entry=entry),
                                         self.storage.resolve, self.directory_work, self.refresh)
        self.traversal = Traversal(self.catalog, self.storage, self.refresh)
        self.covers = CoverSelector(self.storage, self.catalog, self.refresh)
        self.thumbnails = ThumbnailCache()
        self.archive_work = WorkGate(2, 1)
        self.image_work = WorkGate(4, 1)
        self.video_work = WorkGate(2, 1)
        self.preview_service = PreviewService(self, self.thumbnails, self.archive_work)

    @property
    def root(self):
        return self.storage.root

    def validate(self, relative):
        return self.storage.validate(relative)

    def resolve(self, relative):
        return self.storage.resolve(relative)

    def location(self, relative):
        return self.storage.location(relative)

    def source(self, relative, *, entry=None, valid=None):
        return self.storage.source(relative, entry=entry, valid=valid)

    def image_source(self, relative):
        source = self.source(relative)
        return source.file, source.member

    def snapshot(self, relative, *, entry=None, valid=None, ordering=DEFAULT_ORDERING):
        self.validate(relative)
        return self.catalog.snapshot(relative, entry=entry, valid=valid, ordering=ordering)

    def listing(self, relative, *, entry=None, valid=None, ordering=DEFAULT_ORDERING):
        view = self.snapshot(relative, entry=entry, valid=valid, ordering=ordering).view
        return {kind:list(names) for kind, names in view.groups.items()}

    def representative(self, relative, *, entry=None, valid=None):
        return self.covers.representative(relative, entry=entry, valid=valid)

    def thumbnail_source(self, relative, *, kind=None):
        return self.covers.thumbnail_source(relative, kind=kind)

    def walk(self, root='', anchor=None, reverse=False, cursor=None, limit=PAGE_SIZE, ordering=DEFAULT_ORDERING):
        return self.traversal.walk(root, anchor, reverse, cursor, limit, ordering)

    def invalidate(self, relative=''):
        relative = self.storage.normalize_scope(relative)
        self.refresh.invalidate(relative)
        self.catalog.preparations.invalidate(relative)
        related = lambda path: intersects(path, relative)
        self.catalog.invalidate(related)
        self.storage.invalidate(relative)
        self.covers.invalidate(related)
        physical = str(self.root / relative)
        self.thumbnails.invalidate(lambda file: file == physical or file.startswith(physical.rstrip('/') + '/'))
        return relative
