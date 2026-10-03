"""Shared name visibility for filesystem entries and archive members."""


def visible_name(name, excluded=()):
    return bool(name) and not name.startswith('.') and name not in excluded
