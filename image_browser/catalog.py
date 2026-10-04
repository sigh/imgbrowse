"""Safe filesystem access and incremental, naturally ordered traversal."""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from time import monotonic
from uuid import uuid4

from .archives import ARCHIVE_EXTENSIONS, ArchiveCache, ArchiveIndex
from .cache import SharedCache
from .ordering import DEFAULT_ORDERING, archive_modified, natural_key
from .sources import MEDIA_EXTENSIONS, MediaSource
from .visibility import visible_name
from .work import Busy, Cancelled, Invalidated, WorkGate, check_cancelled

WALK_BUDGET = 24
PAGE_SIZE = 60
MAX_CURSOR_DEPTH = 512


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


class Gallery:
    def __init__(self, root, exclude=()):
        self.root = Path(root).resolve()
        self.excluded = frozenset(exclude)
        self.directory_work = WorkGate()
        self.listings = SharedCache(32 * 1024 * 1024)
        self.ordered = SharedCache(32 * 1024 * 1024)
        self.modified_dates = SharedCache(16 * 1024 * 1024)
        self.previews = SharedCache(4 * 1024 * 1024)
        self.sources = SharedCache(4 * 1024 * 1024, ttl=5)
        self.generation = 0
        self.archives = ArchiveCache(self.excluded)

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
        parts = self.validate(relative).parts
        # All virtual paths inside an archive depend on the same physical file.
        # Conservatively include suffix-like real directories too, without I/O.
        for index, part in enumerate(parts):
            if PurePosixPath(part).suffix.lower() in ARCHIVE_EXTENSIONS:
                relative = '/'.join(parts[:index + 1])
                break
        self.generation += 1
        within = lambda path: not relative or path == relative or path.startswith(relative + '/')
        related = lambda path: within(path) or not path or relative.startswith(path + '/')
        self.listings.invalidate(related)
        self.ordered.invalidate(lambda key: related(key[0]))
        self.modified_dates.invalidate(lambda key: related(key[0]))
        self.sources.invalidate(within)
        self.previews.invalidate(related)
        self.archives.invalidate()

    def validate(self, relative):
        if not isinstance(relative, str) or '\x00' in relative:
            raise ValueError('Invalid path')
        path = PurePosixPath(relative)
        if path.is_absolute() or any(not visible_name(part, self.excluded) for part in path.parts):
            raise ValueError('Path is outside the visible collection')
        return path

    def image_source(self, relative):
        source = self.source(relative)
        return source.file, source.member

    def source(self, relative, *, entry=None, valid=None):
        self.validate(relative)
        return self.sources.get(relative, lambda: entry.media_source() if entry else self._source(relative),
                                lambda _: 512, valid=valid)

    def _locate(self, relative):
        """Classify a path once, including archive boundaries and suffix-like folders."""
        parts = self.validate(relative).parts
        file = self.root
        for index, part in enumerate(parts):
            file = file / part
            entry = self._physical_entry(file)
            if entry.archive is not None:
                return ResolvedEntry(file, entry.stat, entry.archive, '/'.join(parts[index + 1:]))
            if index == len(parts) - 1:
                return entry
        return ResolvedEntry(file, file.stat())

    def _physical_entry(self, file):
        file_stat = file.lstat()
        if stat.S_ISLNK(file_stat.st_mode):
            raise PermissionError('Symbolic links are not included')
        archive = self.archives.get(file, file_stat) if (
            stat.S_ISREG(file_stat.st_mode) and file.suffix.lower() in ARCHIVE_EXTENSIONS) else None
        return ResolvedEntry(file, file_stat, archive)

    def _source(self, relative):
        with self.directory_work:
            return self._locate(relative).media_source()

    def listing(self, relative: str, *, entry=None, valid=None, ordering=DEFAULT_ORDERING) -> dict:
        return self.snapshot(relative, entry=entry, valid=valid, ordering=ordering)['listing']

    def snapshot(self, relative, *, entry=None, valid=None, ordering=DEFAULT_ORDERING):
        self.validate(relative)
        generation = self.generation
        valid = valid or (lambda: generation == self.generation)
        def load():
            listing = self._listing(relative, entry=entry)
            keys = {kind: [DEFAULT_ORDERING.key(name) for name in names] for kind, names in listing.items()}
            return {'listing': listing, 'keys': keys, 'dates': {}, 'revision': uuid4().hex}
        snapshot = self.listings.get(relative, load,
                                 lambda item: sum(256 + len(name) * 4 for names in item['listing'].values() for name in names) + 256,
                                 valid=valid)
        if not valid():
            raise Invalidated('Refreshed during request')
        if ordering == DEFAULT_ORDERING:
            return snapshot
        key = (relative, ordering, snapshot['revision'])
        result = self.ordered.get(key, lambda: self._ordered_snapshot(relative, snapshot, ordering, entry, valid),
                                lambda item: sum(320 + len(name) * 4 for names in item['listing'].values() for name in names) + 256,
                                valid=valid)
        if not valid():
            raise Invalidated('Refreshed during request')
        return result

    def _ordered_snapshot(self, relative, snapshot, ordering, entry, valid):
        listing = dict(snapshot['listing'])
        keys, dates = dict(snapshot['keys']), {}
        if ordering.sort == 'modified':
            dates = self.modified_dates.get((relative, snapshot['revision']),
                lambda: self._modified_dates(relative, listing, entry),
                lambda groups: sum(128 + len(name) * 4 for values in groups.values() for name in values) + 128,
                valid=valid)
        for kind in ('images', 'folders'):
            values = dates.get(kind, {})
            records = sorted(((name, ordering.key(name, values.get(name))) for name in listing[kind]),
                             key=lambda record: record[1])
            listing[kind] = [name for name, _ in records]
            keys[kind] = [key for _, key in records]
        return {'listing': listing, 'keys': keys, 'dates': dates, 'revision': snapshot['revision']}

    def _modified_dates(self, relative, listing, entry):
        with self.directory_work:
            entry = entry or self._locate(relative)
        dates = {}
        for kind in ('images', 'folders'):
            values = dates[kind] = {}
            for name in listing[kind]:
                check_cancelled()
                if entry.archive is not None:
                    inner = str(PurePosixPath(entry.inner) / name)
                    infos = entry.archive.folder_info if kind == 'folders' else entry.archive.files
                    values[name] = archive_modified(infos.get(inner))
                else:
                    try:
                        with self.directory_work:
                            attributes = (entry.file / name).lstat()
                        values[name] = None if stat.S_ISLNK(attributes.st_mode) else attributes.st_mtime_ns
                    except (Busy, Cancelled):
                        raise
                    except OSError:
                        check_cancelled()
                        values[name] = None
        return dates

    def _listing(self, relative: str, *, entry=None) -> dict:
        """Read one directory; never inspect its descendants."""
        with self.directory_work:
            entry = entry or self._locate(relative)
            if entry.archive is not None:
                return entry.archive.listing(entry.inner, natural_key)
            return self._scan_directory(entry.file)

    def _scan_directory(self, directory):
        folders, images, other_files = [], [], []
        with os.scandir(directory) as entries:
            for index, entry in enumerate(entries):
                if index % 128 == 0:
                    check_cancelled()
                if not visible_name(entry.name, self.excluded) or entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    folders.append(entry.name)
                    continue
                suffix = Path(entry.name).suffix.lower()
                if entry.is_file(follow_symlinks=False):
                    target = folders if suffix in ARCHIVE_EXTENSIONS else images if suffix in MEDIA_EXTENSIONS else other_files
                    target.append(entry.name)
        return {
            'folders': sorted(folders, key=natural_key),
            'images': sorted(images, key=natural_key),
            'other_files': sorted(other_files, key=natural_key),
        }

    def representative(self, relative, *, entry=None, valid=None):
        """Return the first branch's media path, never traversal instructions."""
        self.validate(relative)
        generation = self.generation
        valid = valid or (lambda: generation == self.generation)
        return self.previews.get(relative, lambda: self._representative(relative, entry, valid),
                                 lambda value: 256 + len(str(value)) * 2, valid=valid)

    def _representative(self, relative, entry, valid):
        if entry is None:
            with self.directory_work:
                entry = self._locate(relative)
        for _ in range(MAX_CURSOR_DEPTH):
            check_cancelled()
            listing = self.listing(relative, entry=entry, valid=valid)
            check_cancelled()
            if listing['images']:
                return str(PurePosixPath(relative) / listing['images'][0])
            if not listing['folders']:
                return None
            child = listing['folders'][0]
            relative = str(PurePosixPath(relative) / child)
            with self.directory_work:
                entry = self._child_entry(entry, child)
        raise ValueError('Folder nesting exceeds the preview depth limit')

    def _child_entry(self, entry, name):
        """Continue a validated branch without restatting every ancestor."""
        if entry.archive is not None:
            return ResolvedEntry(entry.file, entry.stat, entry.archive, str(PurePosixPath(entry.inner) / name))
        return self._physical_entry(entry.file / name)

    def thumbnail_source(self, relative):
        """Resolve media or a container cover to a single versioned source."""
        generation = self.generation
        valid = lambda: generation == self.generation
        self.validate(relative)
        # Reuse the same short-lived source validation as original-media requests.
        cached = self.sources.peek(relative)
        if cached is not None:
            return self.source(relative, valid=valid)
        with self.directory_work:
            entry = self._locate(relative)
        if not entry.is_container:
            return self.source(relative, entry=entry, valid=valid)
        selected = self.representative(relative, entry=entry, valid=valid)
        return self.source(selected, valid=valid) if selected is not None else None

    def walk(self, root='', anchor=None, reverse=False, cursor=None, limit=PAGE_SIZE, ordering=DEFAULT_ORDERING):
        """Page through a depth-first sequence; each request visits bounded folders.

        An anchor seeds the stack from its ancestors, so opening a deep image
        never requires enumerating the earlier portion of the collection.
        Cursors hold names rather than array offsets and contain no server state.
        """
        self.validate(root)
        generation = self.generation
        valid = lambda: generation == self.generation
        if type(limit) is not int or not 1 <= limit <= PAGE_SIZE:
            raise ValueError('Invalid page size')
        if type(reverse) is not bool:
            raise ValueError('Invalid traversal direction')
        phases = ['folders', 'images'] if reverse else ['images', 'folders']
        if isinstance(cursor, dict):
            if (cursor.get('version') != 1 or cursor.get('root') != root
                    or cursor.get('ordering') != ordering.params() or cursor.get('reverse') is not reverse
                    or cursor.get('generation') != self.generation):
                raise ValueError('Continuation no longer matches this collection or sort order; refresh the view')
            cursor = cursor.get('frames')
            if cursor is None:
                raise ValueError('Invalid continuation')
        elif cursor is not None and ordering != DEFAULT_ORDERING:
            raise ValueError('Invalid ordered continuation')
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
                    listings[path] = self.listing(path, ordering=ordering, valid=valid)
                except (OSError, ValueError) as error:
                    check_cancelled()
                    listings[path] = {'folders': [], 'images': []}
                    warnings.append({'path': path, 'message': str(error)})
            phase = phases[frame['phase']]
            names = listings[path][phase]
            if (path, phase) not in keys:
                keys[path, phase] = self.snapshot(path, ordering=ordering, valid=valid) if names else None
            after = frame['after']
            snapshot = keys[path, phase]
            values = snapshot['dates'].get(phase, {}) if snapshot else {}
            if snapshot and frame.get('revision', snapshot['revision']) != snapshot['revision']:
                raise ValueError('Folder listing changed during traversal; refresh the view')
            if snapshot:
                frame['revision'] = snapshot['revision']
            position = frame.get('position')
            if after is not None and position is None:
                if ordering.sort == 'modified' and after not in values:
                    raise ValueError('Selected item is no longer listed; refresh or reopen the folder')
                position = ordering.position(after, values.get(after))
            index = ordering.seek(snapshot['keys'][phase] if snapshot else [], position, reverse)
            if not 0 <= index < len(names):
                frame['phase'] += 1
                frame['after'] = None
                frame.pop('position', None)
                continue
            name = names[index]
            frame['after'] = name
            frame['position'] = ordering.position(name, values.get(name))
            child = str(PurePosixPath(path) / name)
            if phase == 'images':
                items.append(child)
            else:
                stack.append({'path': child, 'phase': 0, 'after': None})
        if not valid():
            raise Invalidated('Refreshed during traversal')
        continuation = {'version': 1, 'root': root, 'ordering': ordering.params(), 'reverse': reverse,
                        'generation': generation, 'frames': stack} if stack else None
        result = {'images': items, 'cursor': continuation, 'warnings': warnings}
        # Share the selected collection's listing already read by traversal.
        # Do not scan another directory just to supply tree metadata.
        if root in listings and not any(warning['path'] == root for warning in warnings):
            result['folders'] = self.snapshot(root, valid=valid)['listing']['folders']
        return result

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
            after = frame['after']
            if after is not None and (not visible_name(after, self.excluded) or '/' in after):
                raise ValueError('Invalid continuation name')
            position = frame.get('position')
            if position is not None:
                if (not isinstance(position, dict) or set(position) != {'name', 'modified'}
                        or position['name'] != after):
                    raise ValueError('Invalid continuation position')
                value = position['modified']
                if value is not None and (not isinstance(value, str) or not value.lstrip('-').isdigit() or len(value) > 30):
                    raise ValueError('Invalid continuation date')
            stack.append(dict(frame))
        return stack


def relative_name(path: PurePosixPath) -> str:
    return '' if path == PurePosixPath('.') else str(path)
