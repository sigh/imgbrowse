"""Safe filesystem access and incremental, naturally ordered traversal."""

import os
import re
import stat
from bisect import bisect_left, bisect_right
from time import monotonic
from pathlib import Path, PurePosixPath

from .cache import SharedCache
from .work import WorkGate, check_cancelled

from .archives import ARCHIVE_EXTENSIONS, ArchiveCache
from .sources import MEDIA_EXTENSIONS, MediaSource

WALK_BUDGET = 24
PAGE_SIZE = 60
MAX_CURSOR_DEPTH = 512


def natural_key(name):
    parts = tuple(
        (1, int(part)) if part.isdigit() else (0, part.casefold())
        for part in re.split(r'(\d+)', name)
    )
    return parts, name


class Gallery:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.directory_work = WorkGate()
        self.listings = SharedCache(32 * 1024 * 1024)
        self.previews = SharedCache(4 * 1024 * 1024)
        self.sources = SharedCache(4 * 1024 * 1024, ttl=5)
        self.generation = 0
        self.archives = ArchiveCache()

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

    def invalidate(self, relative=''):
        """Refresh discovered state only; never enumerate descendants to invalidate."""
        self.validate(relative)
        self.generation += 1
        within = lambda path: not relative or path == relative or path.startswith(relative + '/')
        self.listings.invalidate(within)
        self.sources.invalidate(within)
        self.previews.invalidate(lambda path: within(path) or not path or relative.startswith(path + '/'))
        self.archives.invalidate()

    @staticmethod
    def validate(relative):
        if not isinstance(relative, str) or '\x00' in relative:
            raise ValueError('Invalid path')
        path = PurePosixPath(relative)
        if path.is_absolute() or any(part.startswith('.') for part in path.parts):
            raise ValueError('Path is outside the visible collection')
        return path

    def image_source(self, relative):
        source = self.source(relative)
        return source.file, source.member

    def source(self, relative):
        self.validate(relative)
        return self.sources.get(relative, lambda: self._source(relative), lambda _: 512)

    def _source(self, relative):
        with self.directory_work:
            parts = self.archive_parts(relative)
            if parts:
                file, inner = parts
                file_stat = file.stat()
                archive = self.archives.get(file, file_stat)
                member = archive.image(inner)
                return MediaSource(file, file_stat, member)
            file = self.resolve(relative)
            file_stat = file.stat()
            if file.suffix.lower() not in MEDIA_EXTENSIONS or not stat.S_ISREG(file_stat.st_mode):
                raise FileNotFoundError('Unsupported media file')
            return MediaSource(file, file_stat)

    def listing(self, relative: str) -> dict:
        return self.snapshot(relative)['listing']

    def snapshot(self, relative):
        self.validate(relative)
        def load():
            listing = self._listing(relative)
            keys = {kind: [natural_key(name) for name in names] for kind, names in listing.items()}
            return {'listing': listing, 'keys': keys}
        return self.listings.get(relative, load,
                                 lambda item: sum(256 + len(name) * 4 for names in item['listing'].values() for name in names) + 256)

    def _listing(self, relative: str) -> dict:
        """Read one directory; never inspect its descendants."""
        archive = self.archive_parts(relative)
        if archive:
            file, inner = archive
            with self.directory_work:
                return self.archives.get(file).listing(inner, natural_key)
        directory = self.resolve(relative)
        folders, images = [], []
        with self.directory_work, os.scandir(directory) as entries:
            for index, entry in enumerate(entries):
                if index % 128 == 0:
                    check_cancelled()
                if entry.name.startswith('.') or entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False) or (
                    Path(entry.name).suffix.lower() in ARCHIVE_EXTENSIONS
                    and entry.is_file(follow_symlinks=False)
                ):
                    folders.append(entry.name)
                elif (
                    Path(entry.name).suffix.lower() in MEDIA_EXTENSIONS
                    and entry.is_file(follow_symlinks=False)
                ):
                    images.append(entry.name)
        return {
            'folders': sorted(folders, key=natural_key),
            'images': sorted(images, key=natural_key),
        }

    def preview(self, relative):
        self.validate(relative)
        return self.previews.get(relative, lambda: self._preview(relative),
                                 lambda value: 256 + len(str(value)) * 2)

    def _preview(self, relative):
        """Follow one branch only; return a continuation after bounded work."""
        started = monotonic()
        for step in range(WALK_BUDGET):
            check_cancelled()
            if step and monotonic() - started > .15:
                break
            listing = self.listing(relative)
            if listing['images']:
                return {'image': str(PurePosixPath(relative) / listing['images'][0])}
            if not listing['folders']:
                return {'image': None}
            relative = str(PurePosixPath(relative) / listing['folders'][0])
        return {'image': None, 'continue': relative}

    def walk(self, root='', anchor=None, reverse=False, cursor=None, limit=PAGE_SIZE):
        """Page through a depth-first sequence; each request visits bounded folders.

        An anchor seeds the stack from its ancestors, so opening a deep image
        never requires enumerating the earlier portion of the collection.
        Cursors hold names rather than array offsets and contain no server state.
        """
        self.validate(root)
        if type(limit) is not int or not 1 <= limit <= PAGE_SIZE:
            raise ValueError('Invalid page size')
        if type(reverse) is not bool:
            raise ValueError('Invalid traversal direction')
        phases = ['folders', 'images'] if reverse else ['images', 'folders']
        stack = self._walk_stack(root, anchor, cursor, phases)
        items, warnings, listings, keys = [], [], {}, {}
        started = monotonic()
        while stack and len(items) < limit:
            check_cancelled()
            frame = stack[-1]
            path = frame['path']
            if frame['phase'] >= 2:
                stack.pop()
                continue
            if path not in listings:
                if len(listings) >= WALK_BUDGET or (listings and monotonic() - started > .15):
                    break
                try:
                    listings[path] = self.listing(path)
                except (OSError, ValueError) as error:
                    check_cancelled()
                    listings[path] = {'folders': [], 'images': []}
                    warnings.append({'path': path, 'message': str(error)})
            phase = phases[frame['phase']]
            names = listings[path][phase]
            if (path, phase) not in keys:
                keys[path, phase] = self.snapshot(path)['keys'][phase] if names else []
            after = frame['after']
            index = next_index(keys[path, phase], after, reverse)
            if not 0 <= index < len(names):
                frame['phase'] += 1
                frame['after'] = None
                continue
            name = names[index]
            frame['after'] = name
            child = str(PurePosixPath(path) / name)
            if phase == 'images':
                items.append(child)
            else:
                stack.append({'path': child, 'phase': 0, 'after': None})
        return {'images': items, 'cursor': stack or None, 'warnings': warnings}

    def _walk_stack(self, root, anchor, cursor, phases):
        """Validate a continuation, or seed traversal directly at an image."""
        root_path = PurePosixPath(root)
        if cursor is not None:
            return self._validate_cursor(root_path, cursor)
        if anchor is None:
            return [{'path': root, 'phase': 0, 'after': None}]

        self.validate(anchor)
        relative = PurePosixPath(anchor).relative_to(root_path)
        if not relative.parts:
            raise ValueError('An image anchor must be inside the selected folder')
        stack = []
        parent = root_path
        for name in relative.parts[:-1]:
            stack.append({
                'path': relative_name(parent),
                'phase': phases.index('folders'),
                'after': name,
            })
            parent /= name
        stack.append({
            'path': relative_name(parent),
            'phase': phases.index('images'),
            'after': relative.name,
        })
        return stack

    def _validate_cursor(self, root, cursor):
        if not isinstance(cursor, list) or len(cursor) > MAX_CURSOR_DEPTH:
            raise ValueError('Invalid continuation')
        stack = []
        for frame in cursor:
            if not isinstance(frame, dict) or not {'path', 'phase', 'after'} <= frame.keys():
                raise ValueError('Invalid continuation frame')
            self.validate(frame['path'])
            PurePosixPath(frame['path']).relative_to(root)
            if type(frame['phase']) is not int or frame['phase'] not in (0, 1, 2):
                raise ValueError('Invalid continuation phase')
            if not isinstance(frame['after'], (str, type(None))):
                # All invalid cursor values share the API's ValueError contract.
                raise ValueError('Invalid continuation position')  # noqa: TRY004
            stack.append(dict(frame))
        return stack


def relative_name(path: PurePosixPath) -> str:
    return '' if path == PurePosixPath('.') else str(path)


def next_index(keys, after, reverse):
    """Seek by name rather than offset, tolerating deleted anchor images."""
    if after is None:
        return len(keys) - 1 if reverse else 0
    if reverse:
        return bisect_left(keys, natural_key(after)) - 1
    return bisect_right(keys, natural_key(after))
