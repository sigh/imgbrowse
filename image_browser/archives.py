"""Read ZIP/CBZ contents as virtual folders without extracting source files."""

import stat
import threading
import zipfile
from collections import OrderedDict
from pathlib import PurePosixPath

ARCHIVE_EXTENSIONS = {'.zip', '.cbz'}
MAX_IMAGE_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 200_000
ARCHIVE_CACHE_SIZE = 3


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
        with zipfile.ZipFile(file) as archive:
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
                elif PurePosixPath(name).suffix.lower() in {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}:
                    # Duplicates are ambiguous in ZIP files; keep the first visible entry.
                    if name not in self.images:
                        self.images[name] = info
                        self.direct_images.setdefault('/'.join(parts[:-1]), set()).add(parts[-1])

    def listing(self, inner, natural_key):
        if inner not in self.folders:
            raise FileNotFoundError('Archive folder not found')
        return {'folders': sorted(self.folders[inner], key=natural_key),
                'images': sorted(self.direct_images.get(inner, ()), key=natural_key)}

    def image(self, inner):
        try:
            info = self.images[inner]
        except KeyError as error:
            raise FileNotFoundError('Archive image not found') from error
        if info.file_size > MAX_IMAGE_BYTES:
            raise ValueError('Archive image is too large')
        return info


class ArchiveCache:
    """A few ZIP directory indexes, invalidated by archive file changes."""

    def __init__(self):
        self.entries = OrderedDict()
        self.lock = threading.Lock()

    def get(self, file):
        file_stat = file.stat()
        key = (str(file), file_stat.st_mtime_ns, file_stat.st_size)
        with self.lock:
            cached = self.entries.get(key)
            if cached is not None:
                self.entries.move_to_end(key)
                return cached
        try:
            index = ArchiveIndex(file)
        except zipfile.BadZipFile as error:
            raise ValueError('Invalid ZIP archive') from error
        with self.lock:
            self.entries[key] = index
            self.entries.move_to_end(key)
            while len(self.entries) > ARCHIVE_CACHE_SIZE:
                self.entries.popitem(last=False)
        return index
