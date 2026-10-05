"""Shared basic facts for sorting, Browse, and Info; no presentation state."""

import stat

from image_browser.catalog.errors import StaleView
from image_browser.catalog.model import ArchiveEntry, EntryFacts, Timestamp
from image_browser.runtime.cache import SharedCache
from image_browser.runtime.work import Busy, Cancelled, Invalidated, check_cancelled


class FactRepository:
    def __init__(self, resolve, work, changed=lambda entry, facts: False):
        self.resolve = resolve
        self.work = work
        self.changed = changed
        self.cache = SharedCache(16 * 1024 * 1024)

    def get(self, entry, *, valid=None, expected_version=None):
        check_cancelled()
        source = entry.source
        key = (entry.path, entry.type, source)
        load = lambda: self.read(entry)
        weight = lambda _: 384 + len(entry.path) * 4 + len(getattr(source, 'inner', '')) * 4
        cached = self.cache.peek(key)
        if expected_version is not None and cached is not None and cached.source_version != expected_version:
            self.cache.invalidate(lambda candidate: candidate == key)
        result = self.cache.get(key, load, weight, valid=valid)
        if expected_version is not None and result.source_version != expected_version:
            # Info may join a Browse read started before its source validation.
            # Re-read once instead of publishing that older shared result. The
            # source can change again, so the fresh read owns its actual version.
            self.cache.invalidate(lambda candidate: candidate == key)
            result = self.cache.get(key, load, weight, valid=valid)
        if valid is not None and not valid():
            raise Invalidated('Refreshed during fact request')
        if self.changed(entry, result):
            raise StaleView('Modified facts changed; reload the ordered view')
        return result

    def read(self, entry):
        check_cancelled()
        source = entry.source
        if isinstance(source, ArchiveEntry):
            return EntryFacts(source.modified, source.archive_version + (source.inner, source.crc),
                              source.size, source.compressed_size)
        try:
            with self.work:
                # Resolve again before reading: an intermediate directory may have
                # been replaced with a symlink since enumeration.
                file = self.resolve(entry.path)
                attributes = file.lstat()
            check_cancelled()
        except (Busy, Cancelled):
            raise
        except (FileNotFoundError, PermissionError, NotADirectoryError, ValueError) as error:
            check_cancelled()
            return EntryFacts(None, None, unavailable=str(error))
        if stat.S_ISLNK(attributes.st_mode):
            return EntryFacts(None, None, unavailable='Symbolic links are not included')
        version = (attributes.st_dev, attributes.st_ino, attributes.st_mtime_ns, attributes.st_size)
        return EntryFacts(Timestamp.instant(attributes.st_mtime_ns), version, attributes.st_size)

    def invalidate(self, predicate):
        self.cache.invalidate(lambda key: predicate(key[0]))
