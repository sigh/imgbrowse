"""Resolve and enumerate one validated physical or virtual collection location."""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from image_browser.catalog.errors import InvalidSelection
from image_browser.catalog.model import (
    ENTRY_TYPES,
    ArchiveEntry,
    CatalogEntry,
    DiskEntry,
    EntryId,
    Timestamp,
)
from image_browser.media.sources import IMAGE_EXTENSIONS, MEDIA_EXTENSIONS, MediaSource
from image_browser.runtime.cache import SharedCache
from image_browser.runtime.refresh import within
from image_browser.runtime.work import check_cancelled
from image_browser.storage.archives import ARCHIVE_EXTENSIONS, ArchiveIndex
from image_browser.storage.policy import cache_storage_error
from image_browser.storage.visibility import visible_name


@dataclass(frozen=True)
class ResolvedEntry:
    """Validated filesystem location, optionally within an open archive index."""

    file: Path
    stat: os.stat_result
    archive: ArchiveIndex | None = None
    inner: str = ''

    @property
    def is_container(self):
        return self.inner in self.archive.folders if self.archive else stat.S_ISDIR(self.stat.st_mode)

    def file_source(self):
        if self.archive is not None:
            return MediaSource(self.file, self.stat, self.archive.member(self.inner))
        if not stat.S_ISREG(self.stat.st_mode):
            raise ValueError('Not a regular file')
        return MediaSource(self.file, self.stat)

    def media_source(self):
        source = self.file_source()
        if source.kind == 'file':
            raise ValueError('Unsupported media file')
        return source


class CollectionStorage:
    def __init__(self, root, exclude, work, archives):
        self.root = Path(root).resolve()
        self.excluded = frozenset(exclude)
        self.work = work
        self.archives = archives
        self.sources = SharedCache(4 * 1024 * 1024, ttl=5, cache_errors=cache_storage_error)

    def validate(self, relative):
        if not isinstance(relative, str) or '\x00' in relative:
            raise ValueError('Invalid path')
        path = PurePosixPath(relative)
        if path.is_absolute() or any(not visible_name(part, self.excluded) for part in path.parts):
            raise ValueError('Path is outside the visible collection')
        return path

    def resolve(self, relative: str) -> Path:
        path = self.validate(relative)
        candidate = self.root
        for part in path.parts:
            candidate = candidate / part
            if candidate.is_symlink():
                raise ValueError('Symbolic links are not included')
        return candidate

    def archive_parts(self, relative):
        """Return an archive file and its internal path, when the path enters one."""
        parts = self.validate(relative).parts
        for index, part in enumerate(parts):
            if Path(part).suffix.lower() in ARCHIVE_EXTENSIONS:
                archive = self.resolve('/'.join(parts[:index + 1]))
                if archive.is_dir():
                    continue  # A real directory may also have a .zip or .cbz suffix.
                if not archive.is_file():
                    raise FileNotFoundError('Archive not found')
                return archive, '/'.join(parts[index + 1:])
        return None

    def location(self, relative):
        """Resolve a browser path to its physical source without opening an archive."""
        parts = self.archive_parts(relative)
        file, member = parts if parts else (self.resolve(relative), None)
        return {'filesystem_path': str(file), 'archive_member': member}

    def locate(self, relative):
        """Classify a path once, including archive boundaries and suffix-like folders."""
        parts = self.validate(relative).parts
        file = self.root
        for index, part in enumerate(parts):
            file = file / part
            entry = self.physical_entry(file)
            if entry.archive is not None:
                return ResolvedEntry(file, entry.stat, entry.archive, '/'.join(parts[index + 1:]))
            if index == len(parts) - 1:
                return entry
        return self.physical_entry(file)

    def physical_entry(self, file):
        file_stat = file.lstat()
        if stat.S_ISLNK(file_stat.st_mode):
            raise PermissionError('Symbolic links are not included')
        archive = self.archives.get(file, file_stat) if (
            stat.S_ISREG(file_stat.st_mode) and file.suffix.lower() in ARCHIVE_EXTENSIONS) else None
        return ResolvedEntry(file, file_stat, archive)

    def describe(self, relative, *, entry=None, kind=None):
        """Describe a selected item using the same model as its parent's index."""
        if kind is not None and kind not in ENTRY_TYPES.values():
            raise InvalidSelection('Invalid item type')
        self.validate(relative)
        if entry is None:
            with self.work:
                entry = self.locate(relative)
        name = PurePosixPath(relative).name if relative else self.root.name or 'Collection'
        if entry.archive is not None and entry.inner:
            folder = kind == 'folder' or kind is None and entry.is_container
            if folder:
                if entry.inner not in entry.archive.folders:
                    raise FileNotFoundError('Archive folder not found')
                type = 'folder'
                info = entry.archive.folder_info.get(entry.inner)
            else:
                info = entry.archive.member(entry.inner)
                type = 'image' if PurePosixPath(entry.inner).suffix.lower() in IMAGE_EXTENSIONS else 'file'
            source = ArchiveEntry(entry.file,
                (entry.stat.st_dev, entry.stat.st_ino, entry.stat.st_mtime_ns, entry.stat.st_size), entry.inner,
                Timestamp.calendar(info.date_time) if info else None,
                info.file_size if info else None, info.compress_size if info else None, info.CRC if info else None)
        else:
            type = 'folder' if entry.is_container else 'image' if entry.file.suffix.lower() in MEDIA_EXTENSIONS else 'file'
            source = DiskEntry(entry.file)
        if kind is not None and kind != type:
            raise InvalidSelection('Selected item does not have this type')
        return CatalogEntry(EntryId(name, type), relative, source)

    def children(self, relative: str, *, entry=None) -> list[CatalogEntry]:
        """Read one directory; never inspect its descendants."""
        with self.work:
            entry = entry or self.locate(relative)
            if entry.archive is not None:
                version = (entry.stat.st_dev, entry.stat.st_ino, entry.stat.st_mtime_ns, entry.stat.st_size)
                result = []
                for name, folder, info in entry.archive.children(entry.inner):
                    inner = str(PurePosixPath(entry.inner) / name)
                    type = 'folder' if folder else 'image' if PurePosixPath(name).suffix.lower() in IMAGE_EXTENSIONS else 'file'
                    source = ArchiveEntry(entry.file, version, inner,
                        Timestamp.calendar(info.date_time) if info else None,
                        info.file_size if info else None, info.compress_size if info else None,
                        info.CRC if info else None)
                    result.append(CatalogEntry(EntryId(name, type), str(PurePosixPath(relative) / name), source))
                return result
            return self.scan_directory(entry.file, relative)

    def scan_directory(self, directory, relative=''):
        result = []
        with os.scandir(directory) as entries:
            for index, entry in enumerate(entries):
                if index % 128 == 0:
                    check_cancelled()
                if not visible_name(entry.name, self.excluded) or entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    type = 'folder'
                elif entry.is_file(follow_symlinks=False):
                    suffix = Path(entry.name).suffix.lower()
                    type = 'folder' if suffix in ARCHIVE_EXTENSIONS else 'image' if suffix in MEDIA_EXTENSIONS else 'file'
                else:
                    continue
                result.append(CatalogEntry(EntryId(entry.name, type), str(PurePosixPath(relative) / entry.name),
                                           DiskEntry(directory / entry.name)))
        return result

    def child_entry(self, entry, name):
        """Continue a validated branch without restatting every ancestor."""
        if entry.archive is not None:
            return ResolvedEntry(entry.file, entry.stat, entry.archive, str(PurePosixPath(entry.inner) / name))
        return self.physical_entry(entry.file / name)

    def _load_source(self, relative):
        with self.work:
            return self.locate(relative).media_source()

    def source(self, relative, *, entry=None, valid=None):
        self.validate(relative)
        return self.sources.get(relative, lambda: entry.media_source() if entry else self._load_source(relative),
                                lambda _: 512, valid=valid)

    def normalize_scope(self, relative):
        parts = self.validate(relative).parts
        # Virtual archive paths share one physical source. No I/O is needed here.
        for index, part in enumerate(parts):
            if PurePosixPath(part).suffix.lower() in ARCHIVE_EXTENSIONS:
                return '/'.join(parts[:index + 1])
        return relative

    def invalidate(self, relative):
        self.sources.invalidate(lambda path: within(path, relative))
        physical = str(self.root / relative)
        self.archives.invalidate(lambda file: file == physical or file.startswith(physical.rstrip('/') + '/'))
