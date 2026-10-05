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
from image_browser.catalog.ordering import (
    DEFAULT_ORDERING,
    SORT_CRITERIA,
    Ordering,
    natural_key,
)
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
        if (ordering.requires_facts and self.views.peek(key) is None
                and self.sort_values.peek((path, index.revision, ordering.sort)) is None
                and self.preparations.asynchronous):
            self.preparations.ready(index, ordering, valid)
        view = self.views.get(key, lambda: self.ordered_view(index, ordering, valid),
            lambda result: 256 + sum(160 + len(name) * 4 for names in result.groups.values() for name in names),
            valid=valid)
        if not valid():
            raise Invalidated('Refreshed during ordering request')
        return CatalogSnapshot(index, view)

    def ordered_view(self, index, ordering, valid):
        values = {}
        if ordering.requires_facts:
            def load_values():
                prepared = self.preparations.ready(index, ordering, valid)
                return self.comparison_values(index, ordering, valid) if prepared is None else prepared
            values = self.sort_values.get((index.path, index.revision, ordering.sort), load_values,
                lambda groups: 256 + sum(96 + len(name) * 4 for values in groups.values() for name in values),
                valid=valid)
        groups, keys = {}, {}
        for kind, names in index.groups.items():
            check_cancelled()
            policy = ordering.for_group(kind)
            group_values = values.get(kind, {})
            records = [(name, policy.key(name, group_values.get(name))) for name in names]
            if policy.requires_facts:
                records.sort(key=lambda pair: pair[1])
            elif policy.order == 'desc':
                records.reverse()
            groups[kind] = tuple(name for name, _ in records)
            keys[kind] = tuple(key for _, key in records)
        revision = fingerprint((index.revision, ordering.params(),
            [(kind, [(name, values.get(kind, {}).get(name)) for name in names]) for kind, names in groups.items()]))
        return OrderedView(index.revision, ordering, MappingProxyType(groups), MappingProxyType(keys),
                           MappingProxyType(values), revision)

    def comparison_values(self, index, ordering, valid, progress=lambda: None):
        groups = {}
        for kind in ordering.fact_groups:
            values = {}
            for name in index.groups[kind]:
                facts = self.facts.get(index.entries[EntryId(name, ENTRY_TYPES[kind])], valid=valid)
                values[name] = ordering.value(facts)
                progress()
            groups[kind] = MappingProxyType(values)
        return groups

    def facts_changed(self, entry, facts):
        parent = str(PurePosixPath(entry.path).parent)
        if parent == '.':
            parent = ''
        group = next(kind for kind, type in ENTRY_TYPES.items() if type == entry.type)
        # Early invalidation is an optimization. Clients also receive the view's
        # comparison keys, so agreement never depends on these values remaining cached.
        projections = [(view.ordering, view.values) for view in self.views.completed(lambda key: key[0] == parent)]
        for criterion in SORT_CRITERIA:
            policy = Ordering(criterion)
            projections.extend((policy, values) for values in self.sort_values.completed(
                lambda key, criterion=criterion: key[0] == parent and key[2] == criterion))
            projections.extend((policy, values) for values in self.preparations.completed(parent, criterion))
        if any(entry.name in values.get(group, {}) and values[group][entry.name] != policy.value(facts)
               for policy, values in projections):
            self.refresh.record_change(entry.path)
            self.indexes.invalidate(lambda path: path == parent)
            self.views.invalidate(lambda key: key[0] == parent and key[1].requires_facts)
            self.sort_values.invalidate(lambda key: key[0] == parent)
            self.preparations.invalidate(parent, exact=True)

    def invalidate(self, related):
        self.indexes.invalidate(related)
        self.views.invalidate(lambda key: related(key[0]))
        self.sort_values.invalidate(lambda key: related(key[0]))
        self.facts.invalidate(related)
