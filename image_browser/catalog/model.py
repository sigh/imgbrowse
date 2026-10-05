"""Immutable catalog identities and facts, independent of caches and HTTP.

A child is identified by its name and role within its parent. ZIPs may contain
both a file and a directory at the same path. Calendar dates have no timezone;
their comparison key must never be interpreted as an epoch timestamp.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from image_browser.catalog.ordering import Ordering


ENTRY_TYPES = {'folders': 'folder', 'images': 'image', 'other_files': 'file'}
ENTRY_KINDS = frozenset(ENTRY_TYPES.values())


def fingerprint(value):
    encoded = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class Timestamp:
    kind: str
    value: str
    key: int

    @classmethod
    def instant(cls, nanoseconds):
        seconds, fraction = divmod(nanoseconds, 1_000_000_000)
        date = datetime.fromtimestamp(seconds, timezone.utc)
        value = date.strftime('%Y-%m-%dT%H:%M:%S')
        if fraction:
            value += '.' + f'{fraction:09d}'.rstrip('0')
        return cls('instant', value + '+00:00', nanoseconds)

    @classmethod
    def calendar(cls, parts):
        try:
            # ZIP dates are calendar values with no timezone, not instants.
            date = datetime(*parts)  # noqa: DTZ001
        except (ValueError, TypeError, OverflowError):
            return None
        value = date.isoformat()
        key = int(f'{date.year:04d}{date.month:02d}{date.day:02d}'
                  f'{date.hour:02d}{date.minute:02d}{date.second:02d}')
        return cls('calendar', value, key)

    def serialize(self):
        # Decimal strings preserve nanoseconds through JavaScript JSON round trips.
        return {'kind': self.kind, 'value': self.value, 'key': str(self.key)}


@dataclass(frozen=True)
class EntryId:
    name: str
    type: str

    def __post_init__(self):
        if (not isinstance(self.name, str) or not self.name or '/' in self.name
                or '\x00' in self.name or self.name in ('.', '..')
                or not isinstance(self.type, str) or self.type not in ENTRY_KINDS):
            raise ValueError('Expected a direct child name and item type')

    def serialize(self):
        return {'name': self.name, 'type': self.type}


@dataclass(frozen=True)
class DiskEntry:
    file: Path


@dataclass(frozen=True)
class ArchiveEntry:
    file: Path
    archive_version: tuple
    inner: str
    modified: Timestamp | None
    size: int | None
    compressed_size: int | None
    crc: int | None


@dataclass(frozen=True)
class CatalogEntry:
    identity: EntryId
    path: str
    source: DiskEntry | ArchiveEntry

    @property
    def name(self):
        return self.identity.name

    @property
    def type(self):
        return self.identity.type

    def serialize(self):
        return self.identity.serialize()


@dataclass(frozen=True)
class EntryFacts:
    modified: Timestamp | None
    source_version: tuple | None
    size: int | None = None
    compressed_size: int | None = None
    unavailable: str | None = None

    def serialize(self):
        return {'facts_revision': fingerprint((self.source_version, self.modified.serialize() if self.modified else None, self.size, self.compressed_size, self.unavailable)),
                'modified': self.modified.serialize() if self.modified else None,
                'source_version': list(map(str, self.source_version)) if self.source_version else None,
                **({'size': self.size} if self.size is not None else {}),
                **({'compressed_size': self.compressed_size} if self.compressed_size is not None else {}),
                **({'unavailable': self.unavailable} if self.unavailable else {})}


@dataclass(frozen=True)
class FolderIndex:
    path: str
    entries: Mapping[EntryId, CatalogEntry]
    groups: Mapping[str, tuple[str, ...]]
    revision: str

    @classmethod
    def create(cls, path, children, natural_key):
        entries = {entry.identity: entry for entry in children}
        groups = {kind: tuple(sorted((identity.name for identity in entries if identity.type == type), key=natural_key))
                  for kind, type in ENTRY_TYPES.items()}
        revision = fingerprint([(kind, names) for kind, names in groups.items()])
        return cls(path, MappingProxyType(entries), MappingProxyType(groups), revision)


@dataclass(frozen=True)
class OrderedView:
    """Only identities and comparison values; source descriptors stay in the index."""

    index_revision: str
    ordering: Ordering
    groups: Mapping[str, tuple[str, ...]]
    keys: Mapping[str, tuple]
    dates: Mapping[str, Mapping[str, int | None]]
    revision: str
