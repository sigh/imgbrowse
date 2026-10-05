"""Membership and ordering projections over immutable entries and shared facts."""

from dataclasses import dataclass
from pathlib import PurePosixPath
from types import MappingProxyType

from image_browser.catalog.facts import FactRepository
from image_browser.catalog.model import (
    ENTRY_TYPES,
    EntryId,
    FolderIndex,
    OrderedView,
    fingerprint,
)
from image_browser.catalog.ordering import DEFAULT_ORDERING, natural_key
from image_browser.catalog.preparation import OrderPreparations
from image_browser.runtime.cache import SharedCache
from image_browser.runtime.work import Invalidated, check_cancelled


@dataclass(frozen=True)
class CatalogSnapshot:
    """An operation owns its index and view even when neither fits in the cache."""

    index: FolderIndex
    view: OrderedView


class CatalogRepository:
    def __init__(self, enumerate_children, resolve, work, refresh):
        self.enumerate_children = enumerate_children
        self.refresh = refresh
        self.indexes = SharedCache(32 * 1024 * 1024)
        self.views = SharedCache(32 * 1024 * 1024)
        self.sort_values = SharedCache(16 * 1024 * 1024)
        self.facts = FactRepository(resolve, work, self.facts_changed)
        self.preparations = OrderPreparations(self)

    def index(self, path, *, entry=None, valid=None):
        valid = valid or self.refresh.watch(path)
        result = self.indexes.get(path,
            lambda: FolderIndex.create(path, self.enumerate_children(path, entry=entry), natural_key),
            lambda index: 256 + sum(320 + len(child.name) * 4 + len(child.path) * 2
                                   for child in index.entries.values()), valid=valid)
        if not valid():
            raise Invalidated('Refreshed during index request')
        return result

    def snapshot(self, path, *, entry=None, valid=None, ordering=DEFAULT_ORDERING):
        valid = valid or self.refresh.watch(path)
        index = self.index(path, entry=entry, valid=valid)
        key = (path, ordering, index.revision)
        # Each HTTP consumer owns a preparation lease, even when view loads are shared.
        if (ordering.sort == 'modified' and self.views.peek(key) is None
                and self.sort_values.peek((path, index.revision)) is None
                and self.preparations.asynchronous):
            self.preparations.ready(index, valid)
        view = self.views.get(key, lambda: self.ordered_view(index, ordering, valid),
            lambda result: 256 + sum(160 + len(name) * 4 for names in result.groups.values() for name in names),
            valid=valid)
        if not valid():
            raise Invalidated('Refreshed during ordering request')
        return CatalogSnapshot(index, view)

    def ordered_view(self, index, ordering, valid):
        dates = {}
        if ordering.sort == 'modified':
            dates = self.sort_values.peek((index.path, index.revision))
            if dates is None:
                dates = self.preparations.ready(index, valid)
            if dates is None:
                dates = self.sort_values.get((index.path, index.revision),
                    lambda: self.modified_values(index, valid),
                    lambda groups: 256 + sum(96 + len(name) * 4 for values in groups.values() for name in values),
                    valid=valid)
        groups, keys = {}, {}
        for kind, names in index.groups.items():
            check_cancelled()
            # Other files retain natural order; they are outside media traversal.
            policy = DEFAULT_ORDERING if kind == 'other_files' else ordering
            values = dates.get(kind, {})
            records = [(name, policy.key(name, values.get(name))) for name in names]
            if policy.sort == 'modified':
                records.sort(key=lambda pair: pair[1])
            elif policy.order == 'desc':
                records.reverse()
            groups[kind] = tuple(name for name, _ in records)
            keys[kind] = tuple(key for _, key in records)
        revision = fingerprint((index.revision, ordering.params(),
            [(kind, [(name, dates.get(kind, {}).get(name)) for name in names]) for kind, names in groups.items()]))
        return OrderedView(index.revision, ordering, MappingProxyType(groups), MappingProxyType(keys),
                           MappingProxyType(dates), revision)

    def modified_values(self, index, valid, progress=lambda: None):
        groups = {}
        for kind in ('images', 'folders'):
            values = {}
            for name in index.groups[kind]:
                facts = self.facts.get(index.entries[EntryId(name, ENTRY_TYPES[kind])], valid=valid)
                values[name] = facts.modified.key if facts.modified else None
                progress()
            groups[kind] = MappingProxyType(values)
        return groups

    def facts_changed(self, entry, facts):
        parent = str(PurePosixPath(entry.path).parent)
        if parent == '.':
            parent = ''
        group = next(kind for kind, type in ENTRY_TYPES.items() if type == entry.type)
        current = facts.modified.key if facts.modified else None
        # Early invalidation is an optimization. Clients also receive the view's
        # comparison keys, so agreement never depends on these values remaining cached.
        projections = [view.dates for view in self.views.completed(lambda key: key[0] == parent)]
        projections.extend(self.sort_values.completed(lambda key: key[0] == parent))
        projections.extend(self.preparations.completed(parent))
        if any(entry.name in dates.get(group, {}) and dates[group][entry.name] != current for dates in projections):
            self.refresh.invalidate(entry.path)
            self.indexes.invalidate(lambda path: path == parent)
            self.views.invalidate(lambda key: key[0] == parent and key[1].sort == 'modified')
            self.sort_values.invalidate(lambda key: key[0] == parent)
            self.preparations.invalidate(parent, exact=True)
            return True
        return False

    def invalidate(self, related):
        self.indexes.invalidate(related)
        self.views.invalidate(lambda key: related(key[0]))
        self.sort_values.invalidate(lambda key: related(key[0]))
        self.facts.invalidate(related)
