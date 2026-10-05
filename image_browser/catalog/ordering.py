"""Sort policy shared by directory listings and incremental traversal."""

import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from functools import cached_property, cmp_to_key

from image_browser.catalog.model import ENTRY_TYPES

SORT_CRITERIA = ('natural', 'modified', 'size')


def natural_key(name):
    parts = tuple((1, int(part)) if part.isdigit() else (0, part.casefold())
                  for part in re.split(r'(\d+)', name))
    return parts, name


def compare(a, b):
    return (a > b) - (a < b)


@dataclass(frozen=True)
class Ordering:
    sort: str = 'natural'
    order: str = 'asc'

    def __post_init__(self):
        if self.sort not in SORT_CRITERIA or self.order not in ('asc', 'desc'):
            raise ValueError('Invalid sort order')

    @property
    def requires_facts(self):
        return self.sort != 'natural'

    def for_group(self, kind):
        if (kind == 'folders' and self.sort == 'size'
                or kind == 'other_files' and self.sort != 'size'):
            return DEFAULT_ORDERING
        return self

    @property
    def fact_groups(self):
        return tuple(kind for kind in ENTRY_TYPES if self.for_group(kind).requires_facts)

    def value(self, facts):
        if self.sort == 'modified':
            return facts.modified.key if facts.modified else None
        if self.sort == 'size':
            return facts.size
        return None

    def compare(self, a, b):
        name_a, value_a = a
        name_b, value_b = b
        names = compare(name_a, name_b)
        if self.sort == 'natural':
            return -names if self.order == 'desc' else names
        available = compare(value_a is None, value_b is None)
        if available:
            return available
        values = compare(value_a, value_b) if value_a is not None else 0
        return (-values if self.order == 'desc' else values) or names

    @cached_property
    def key_type(self):
        return cmp_to_key(self.compare)

    def key(self, name, value=None):
        return self.key_type((natural_key(name), value))

    def position(self, name, value=None):
        # Preserve exact comparison integers through JavaScript JSON round trips.
        return {'name': name, 'value': None if value is None else str(value)}

    def decode_position(self, position):
        if (not isinstance(position, dict) or set(position) != {'name', 'value'}
                or not isinstance(position['name'], str)):
            raise ValueError('Invalid continuation position')
        value = position['value']
        if value is not None:
            if (not self.requires_facts or not isinstance(value, str)
                    or not re.fullmatch(r'-?[0-9]{1,30}', value)
                    or self.sort == 'size' and value.startswith('-')):
                raise ValueError('Invalid continuation value')
            value = int(value)
        return position['name'], value

    def seek(self, keys, position, reverse=False):
        if position is None:
            return len(keys) - 1 if reverse else 0
        key = self.key(*self.decode_position(position))
        return bisect_left(keys, key) - 1 if reverse else bisect_right(keys, key)

    def params(self):
        return {'sort': self.sort, 'order': self.order}

    @classmethod
    def from_params(cls, params):
        return cls(params.get('sort', 'natural'), params.get('order', 'asc'))


DEFAULT_ORDERING = Ordering()
