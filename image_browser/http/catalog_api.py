"""Validate and serialize the folder index and bounded fact API contracts."""

from image_browser.catalog.errors import StaleView
from image_browser.catalog.limits import PAGE_SIZE
from image_browser.catalog.model import ENTRY_TYPES, EntryId
from image_browser.catalog.ordering import DEFAULT_ORDERING
from image_browser.http.errors import error_details
from image_browser.runtime.work import Cancelled, Invalidated, check_cancelled


class CatalogApi:
    def __init__(self, gallery):
        self.gallery = gallery

    def folder_index(self, relative, *, ordering=DEFAULT_ORDERING):
        snapshot = self.gallery.snapshot(relative, ordering=ordering)
        return {'revision': snapshot.index.revision, 'view_revision': snapshot.view.revision,
                'items': [{**EntryId(name, ENTRY_TYPES[kind]).serialize(),
                           **({'modified_key':str(snapshot.view.dates[kind][name])
                               if snapshot.view.dates[kind][name] is not None else None}
                              if kind in snapshot.view.dates else {})}
                          for kind, names in snapshot.view.groups.items() for name in names],
                'natural_folders': list(snapshot.index.groups['folders'])}

    def entry_page(self, relative, identities, *, revision=None):
        if not isinstance(identities, list) or len(identities) > PAGE_SIZE:
            raise ValueError('Expected at most 60 direct child identities')
        if revision is not None and not isinstance(revision, str):
            raise ValueError('Invalid membership revision')
        ids = []
        for identity in identities:
            if not isinstance(identity, dict) or set(identity) != {'name', 'type'}:
                raise ValueError('Expected a direct child name and item type')
            ids.append(EntryId(**identity))
        self.gallery.validate(relative)
        valid = self.gallery.refresh.watch(relative)
        index = self.gallery.catalog.index(relative, valid=valid)
        if revision is not None and revision != index.revision:
            raise StaleView('Folder listing changed; refresh this folder')
        if any(identity not in index.entries for identity in ids):
            raise ValueError('Child is not in this folder listing')
        entries = []
        for identity in ids:
            try:
                facts = self.gallery.catalog.facts.get(index.entries[identity], valid=valid)
                entries.append({**identity.serialize(), 'status': 'ready', **facts.serialize()})
            except (Cancelled, Invalidated):
                raise
            except OSError as error:
                entries.append({**identity.serialize(), 'status': 'error', **error_details(error)[1]})
        check_cancelled()
        if not valid():
            raise Invalidated('Refreshed during fact request')
        return {'revision': index.revision, 'entries': entries}
