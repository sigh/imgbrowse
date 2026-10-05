"""Bounded depth-first traversal over operation-owned catalog snapshots."""

from pathlib import PurePosixPath
from time import monotonic

from image_browser.catalog.errors import OrderTooLarge, StaleView
from image_browser.catalog.limits import MAX_CURSOR_DEPTH, PAGE_SIZE, WALK_BUDGET
from image_browser.catalog.model import EntryId
from image_browser.catalog.ordering import DEFAULT_ORDERING
from image_browser.runtime.refresh import intersects
from image_browser.runtime.work import Busy, Cancelled, Invalidated, check_cancelled
from image_browser.storage.visibility import visible_name


class Traversal:
    def __init__(self, catalog, storage, refresh):
        self.catalog = catalog
        self.storage = storage
        self.refresh = refresh

    def walk(self, root='', anchor=None, reverse=False, cursor=None, limit=PAGE_SIZE, ordering=DEFAULT_ORDERING):
        """Page through a depth-first sequence; each request visits bounded folders.

        An anchor seeds the stack from its ancestors, so opening a deep image
        never requires enumerating the earlier portion of the collection.
        Cursors hold names rather than array offsets and contain no server state.
        """
        self.storage.validate(root)
        valid = self.refresh.watch(root)
        if type(limit) is not int or not 1 <= limit <= PAGE_SIZE:
            raise ValueError('Invalid page size')
        if type(reverse) is not bool:
            raise ValueError('Invalid traversal direction')
        phases = ['folders', 'images'] if reverse else ['images', 'folders']
        refresh_sequence = self.refresh.sequence
        previous_sequence = refresh_sequence
        if isinstance(cursor, dict):
            previous_sequence = cursor.get('refresh_sequence', refresh_sequence)
            if type(previous_sequence) is not int or not 0 <= previous_sequence <= refresh_sequence:
                raise ValueError('Invalid continuation refresh context')
            if (cursor.get('version') != 1 or cursor.get('root') != root
                    or cursor.get('ordering') != ordering.params() or cursor.get('reverse') is not reverse):
                raise ValueError('Continuation no longer matches this collection or sort order; refresh the view')
            cursor = cursor.get('frames')
            if cursor is None:
                raise ValueError('Invalid continuation')
        elif cursor is not None:
            raise ValueError('Invalid ordered continuation')
        stack = self._walk_stack(root, anchor, cursor, phases)
        items, warnings, snapshots = [], [], {}
        anchor_missing = False
        started = monotonic()
        # An active ancestor must be checked before emitting descendant items
        # when a related refresh could have changed its membership or order.
        # Eviction and unrelated refreshes require no extra validation work.
        changes = self.refresh.changes_since(previous_sequence)
        for ancestor in stack:
            path = ancestor['path']
            if ancestor.get('revision') and any(intersects(path, scope) for scope in changes):
                snapshot = self.catalog.snapshot(path, ordering=ordering, valid=valid)
                if snapshot.view.revision != ancestor['revision']:
                    raise StaleView('Folder listing changed during traversal; reopen around the selected item')
                snapshots[path] = snapshot

        while stack and len(items) < limit:
            check_cancelled()
            frame = stack[-1]
            path = frame['path']
            if frame['phase'] >= 2:
                stack.pop()
                continue
            if path not in snapshots:
                if len(snapshots) >= WALK_BUDGET or (snapshots and monotonic() - started > .15):
                    break
                try:
                    snapshots[path] = self.catalog.snapshot(path, ordering=ordering, valid=valid)
                except (Busy, Cancelled, Invalidated, StaleView, OrderTooLarge):
                    raise
                except (OSError, ValueError) as error:
                    check_cancelled()
                    snapshots[path] = None
                    warnings.append({'path': path, 'message': str(error)})
            phase = phases[frame['phase']]
            snapshot = snapshots[path].view if snapshots[path] else None
            names = snapshot.groups[phase] if snapshot else ()
            after = frame['after']
            values = snapshot.dates.get(phase, {}) if snapshot else {}
            if snapshot and frame.get('revision', snapshot.revision) != snapshot.revision:
                raise StaleView('Folder listing changed during traversal; refresh the view')
            if snapshot:
                frame['revision'] = snapshot.revision
            position = frame.get('position')
            if after is not None and position is None:
                if ordering.sort == 'modified' and after not in values:
                    raise ValueError('Selected item is no longer listed; refresh or reopen the folder')
                if (snapshot and phase == 'images' and anchor is not None
                        and path == relative_name(PurePosixPath(anchor).parent)
                        and after == PurePosixPath(anchor).name
                        and EntryId(after, 'image') not in snapshots[path].index.entries):
                    anchor_missing = True
                position = ordering.position(after, values.get(after))
            index = ordering.seek(snapshot.keys[phase] if snapshot else [], position, reverse)
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
                        'frames': stack, 'refresh_sequence': refresh_sequence} if stack else None
        result = {'images': items, 'cursor': continuation, 'warnings': warnings,
                  'revisions': {path: snapshot.view.revision for path, snapshot in snapshots.items() if snapshot is not None}}
        if anchor_missing:
            result['anchor_missing'] = True
        # Share the selected collection's listing already read by traversal.
        # Do not scan another directory just to supply tree metadata.
        if root in snapshots and snapshots[root] is not None:
            result['folders'] = list(snapshots[root].index.groups['folders'])
        return result

    def _walk_stack(self, root, anchor, cursor, phases):
        """Validate a continuation, or seed traversal directly at an image."""
        root_path = PurePosixPath(root)
        if cursor is not None:
            return self._validate_cursor(root_path, cursor)
        if anchor is None:
            return [{'path': root, 'phase': 0, 'after': None}]

        self.storage.validate(anchor)
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
            self.storage.validate(frame['path'])
            PurePosixPath(frame['path']).relative_to(root)
            if type(frame['phase']) is not int or frame['phase'] not in (0, 1, 2):
                raise ValueError('Invalid continuation phase')
            if not isinstance(frame['after'], (str, type(None))):
                # All invalid cursor values share the API's ValueError contract.
                raise ValueError('Invalid continuation position')  # noqa: TRY004
            after = frame['after']
            if after is not None and (not visible_name(after, self.storage.excluded) or '/' in after):
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
