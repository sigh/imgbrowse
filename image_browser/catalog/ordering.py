"""Sort policy shared by directory listings and incremental traversal."""

import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from functools import cached_property, cmp_to_key


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
        if self.sort not in ('natural', 'modified') or self.order not in ('asc', 'desc'):
            raise ValueError('Invalid sort order')

    def compare(self, a, b):
        name_a, date_a = a
        name_b, date_b = b
        names = compare(name_a, name_b)
        if self.sort == 'natural':
            return -names if self.order == 'desc' else names
        available = compare(date_a is None, date_b is None)
        if available:
            return available
        dates = compare(date_a, date_b) if date_a is not None else 0
        return (-dates if self.order == 'desc' else dates) or names

    @cached_property
    def key_type(self):
        return cmp_to_key(self.compare)

    def key(self, name, modified=None):
        return self.key_type((natural_key(name), modified))

    def position(self, name, modified=None):
        # Decimal strings preserve nanoseconds through JavaScript JSON round trips.
        return {'name': name, 'modified': None if modified is None else str(modified)}

    def seek(self, keys, position, reverse=False):
        if position is None:
            return len(keys) - 1 if reverse else 0
        date = position['modified']
        key = self.key(position['name'], None if date is None else int(date))
        return bisect_left(keys, key) - 1 if reverse else bisect_right(keys, key)

    def params(self):
        return {'sort': self.sort, 'order': self.order}

    @classmethod
    def from_params(cls, params):
        return cls(params.get('sort', 'natural'), params.get('order', 'asc'))


DEFAULT_ORDERING = Ordering()
