"""Single HTTP byte ranges; unsupported or malformed ranges are ignored."""

import re


class UnsatisfiableRange(ValueError):
    """The requested bytes do not overlap the representation."""


def byte_range(header, size):
    if not header:
        return None
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', header.strip())
    if not match or not any(match.groups()):
        return None
    first, last = match.groups()
    if first:
        start = int(first)
        end = int(last) if last else size - 1
        if last and end < start:
            return None
        if start >= size:
            raise UnsatisfiableRange()
    else:
        length = int(last)
        if not length or not size:
            raise UnsatisfiableRange()
        start, end = max(0, size - length), size - 1
    return start, min(end, size - 1)
