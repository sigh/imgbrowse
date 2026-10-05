"""Scoped operation lifetimes and bounded history for cursor revalidation."""

from collections import deque
from dataclasses import dataclass
from threading import Lock
from weakref import WeakSet


def within(path, scope):
    return not scope or path == scope or path.startswith(scope + '/')


def intersects(a, b):
    return within(a, b) or within(b, a)


@dataclass(eq=False)
class ScopeValidity:
    """An operation's scope remains registered only while its caller retains it."""

    owner: object
    path: str
    valid: bool = True

    def __call__(self):
        with self.owner.lock:
            return self.valid


class RefreshScopes:
    def __init__(self, history_size=256):
        self.sequence = 0
        self.history = deque(maxlen=history_size)
        self.active = WeakSet()
        self.lock = Lock()

    def invalidate(self, path):
        with self.lock:
            self.sequence += 1
            self.history.append((self.sequence, path))
            for operation in self.active:
                if intersects(operation.path, path):
                    operation.valid = False

    def watch(self, path):
        with self.lock:
            operation = ScopeValidity(self, path)
            self.active.add(operation)
            return operation

    def changes_since(self, sequence):
        """Scopes to revalidate; the sequence never determines cursor validity."""
        with self.lock:
            if self.history and sequence < self.history[0][0] - 1:
                return ('',)
            return tuple(scope for changed, scope in self.history if changed > sequence)
