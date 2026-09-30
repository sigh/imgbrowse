"""Read ZIP/CBZ contents as virtual folders without extracting source files."""

import stat
import threading
import zipfile
from contextlib import contextmanager
from pathlib import PurePosixPath

from .cache import SharedCache
from .sources import IMAGE_EXTENSIONS

ARCHIVE_EXTENSIONS = {'.zip', '.cbz'}
MAX_IMAGE_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 200_000


def visible_member(name):
    """Use only unambiguous, visible, relative member names."""
    if not name or name.startswith('/') or '\\' in name or '\x00' in name:
        return False
    parts = name.rstrip('/').split('/')
    return all(part and not part.startswith('.') for part in parts)


class ArchiveIndex:
    def __init__(self, file):
        self.folders = {'': set()}
        self.images = {}
        self.direct_images = {}
        self.reader = zipfile.ZipFile(file)
        self.lock = threading.Lock()
        self.sorted_listings = {}
        archive = self.reader
        if len(archive.infolist()) > MAX_ARCHIVE_ENTRIES:
            raise ValueError('Archive has too many entries')
        for info in archive.infolist():
            name = info.filename.rstrip('/')
            if not visible_member(name):
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
            elif PurePosixPath(name).suffix.lower() in IMAGE_EXTENSIONS:
                # Duplicates are ambiguous in ZIP files; keep the first visible entry.
                if name not in self.images:
                    self.images[name] = info
                    self.direct_images.setdefault('/'.join(parts[:-1]), set()).add(parts[-1])

    def listing(self, inner, natural_key):
        if inner not in self.folders:
            raise FileNotFoundError('Archive folder not found')
        with self.lock:
            if inner not in self.sorted_listings:
                self.sorted_listings[inner] = {
                    'folders': sorted(self.folders[inner], key=natural_key),
                    'images': sorted(self.direct_images.get(inner, ()), key=natural_key)}
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

    def image(self, inner):
        try:
            info = self.images[inner]
        except KeyError as error:
            raise FileNotFoundError('Archive image not found') from error
        if info.file_size > MAX_IMAGE_BYTES:
            raise ValueError('Archive image is too large')
        return info


class ArchiveCache:
    """Bound cached readers by estimated metadata bytes and open-file count.

    Active callers retain their reader during eviction; it closes when its last
    reference is released. Shared loads prevent duplicate opens of one version.
    """

    def __init__(self):
        self.cache = SharedCache(64 * 1024 * 1024, max_entries=16)

    def get(self, file, file_stat=None):
        file_stat = file_stat or file.stat()
        key = (str(file), file_stat.st_mtime_ns, file_stat.st_size)
        def load():
            try:
                return ArchiveIndex(file)
            except zipfile.BadZipFile as error:
                raise ValueError('Invalid ZIP archive') from error
        return self.cache.get(key, load,
                              lambda index: sum(512 + len(info.filename) * 4 for info in index.reader.infolist()))

    def invalidate(self):
        self.cache.invalidate()
