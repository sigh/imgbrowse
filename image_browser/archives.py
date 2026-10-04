"""Read ZIP/CBZ contents as virtual folders without extracting source files."""

import stat
import threading
import zipfile
from contextlib import contextmanager
from pathlib import PurePosixPath

from .cache import SharedCache
from .sources import IMAGE_EXTENSIONS
from .visibility import visible_name

ARCHIVE_EXTENSIONS = {'.zip', '.cbz'}
MAX_IMAGE_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 200_000


def visible_member(name, excluded=()):
    """Use only unambiguous, visible, relative member names."""
    if not name or name.startswith('/') or '\\' in name or '\x00' in name:
        return False
    parts = name.rstrip('/').split('/')
    return all(visible_name(part, excluded) for part in parts)


class ArchiveIndex:
    def __init__(self, file, exclude=()):
        self.folders = {'': set()}
        self.files = {}
        self.direct_files = {}
        self.reader = zipfile.ZipFile(file)
        self.lock = threading.Lock()
        self.sorted_listings = {}
        archive = self.reader
        if len(archive.infolist()) > MAX_ARCHIVE_ENTRIES:
            raise ValueError('Archive has too many entries')
        for info in archive.infolist():
            name = info.filename.rstrip('/')
            if not visible_member(name, exclude):
                continue
            if stat.S_ISLNK(info.external_attr >> 16):
                continue
            parts = name.split('/')
            for depth in range(1, len(parts)):
                parent = '/'.join(parts[:depth - 1])
                self.folders.setdefault(parent, set()).add(parts[depth - 1])
                self.folders.setdefault('/'.join(parts[:depth]), set())
            if info.is_dir():
                parent = '/'.join(parts[:-1])
                self.folders.setdefault(parent, set()).add(parts[-1])
                self.folders.setdefault(name, set())
            else:
                # Duplicates are ambiguous in ZIP files; keep the first visible entry.
                if name not in self.files:
                    self.files[name] = info
                    self.direct_files.setdefault('/'.join(parts[:-1]), set()).add(parts[-1])

    def listing(self, inner, natural_key):
        if inner not in self.folders:
            raise FileNotFoundError('Archive folder not found')
        with self.lock:
            if inner not in self.sorted_listings:
                names = sorted(self.direct_files.get(inner, ()), key=natural_key)
                self.sorted_listings[inner] = {
                    'folders': sorted(self.folders[inner], key=natural_key),
                    'images': [name for name in names if PurePosixPath(name).suffix.lower() in IMAGE_EXTENSIONS],
                    'other_files': [name for name in names if PurePosixPath(name).suffix.lower() not in IMAGE_EXTENSIONS]}
            return self.sorted_listings[inner]

    @contextmanager
    def open(self, member):
        with self.lock, self.reader.open(member) as source:
            yield source

    def read(self, member):
        with self.open(member) as source:
            return source.read(member.file_size + 1)

    def __del__(self):
        if hasattr(self, 'reader'):
            self.reader.close()

    def member(self, inner):
        try:
            info = self.files[inner]
        except KeyError as error:
            raise FileNotFoundError('Archive file not found') from error
        if PurePosixPath(inner).suffix.lower() in IMAGE_EXTENSIONS and info.file_size > MAX_IMAGE_BYTES:
            raise ValueError('Archive image is too large')
        return info


class ArchiveCache:
    """Bound cached readers by estimated metadata bytes and open-file count.

    Active callers retain their reader during eviction; it closes when its last
    reference is released. Shared loads prevent duplicate opens of one version.
    """

    def __init__(self, exclude=()):
        self.excluded = frozenset(exclude)
        self.cache = SharedCache(64 * 1024 * 1024, max_entries=16)

    def get(self, file, file_stat=None):
        file_stat = file_stat or file.stat()
        key = (str(file), file_stat.st_mtime_ns, file_stat.st_size)
        def load():
            try:
                return ArchiveIndex(file, self.excluded)
            except zipfile.BadZipFile as error:
                raise ValueError('Invalid ZIP archive') from error
        return self.cache.get(key, load,
                              lambda index: sum(512 + len(info.filename) * 4 for info in index.reader.infolist()))

    def invalidate(self):
        self.cache.invalidate()
