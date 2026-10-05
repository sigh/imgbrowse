"""Memory-bounded reuse, shared pending loads, and explicit invalidation."""

import threading
from collections import OrderedDict
from concurrent.futures import Future, TimeoutError
from dataclasses import dataclass, field
from time import monotonic

from image_browser.runtime.work import (
    Cancelled,
    Invalidated,
    cancellation,
    check_cancelled,
    current_priority,
    request_work,
)


@dataclass(eq=False)
class PendingLoad:
    future: Future = field(default_factory=lambda: Future())
    consumers: list = field(default_factory=list)


class SharedCache:
    def __init__(self, max_weight, ttl=300, max_entries=4096, *, cache_errors=lambda error: False):
        self.max_weight = max_weight
        self.ttl = ttl
        self.max_entries = max_entries
        self.cache_errors = cache_errors
        self.entries = OrderedDict()
        self.pending = {}
        self.weight = 0
        self.lock = threading.Lock()
        self.hits = self.loads = 0

    def peek(self, key):
        """Return a completed, unexpired value without starting or waiting for work."""
        with self.lock:
            entry = self.entries.get(key)
            if entry and entry[0] > monotonic() and not isinstance(entry[1], Exception):
                return entry[1]
        return None

    def completed(self, predicate=lambda key: True):
        """Inspect retained values without exposing ownership or cache storage."""
        with self.lock:
            now = monotonic()
            return tuple(entry[1] for key, entry in self.entries.items()
                         if predicate(key) and entry[0] > now and not isinstance(entry[1], Exception))

    def get(self, key, load, weight=lambda value: 1, *, valid=None):
        """Share a load; optional scope checks run under the lock and must not block."""
        check_cancelled()
        with self.lock:
            if valid is not None and not valid():
                raise Invalidated('Refreshed during request')
            entry = self.entries.get(key)
            if entry and entry[0] > monotonic():
                self.entries.move_to_end(key)
                self.hits += 1
                if isinstance(entry[1], Exception):
                    raise type(entry[1])(str(entry[1])) from None
                return entry[1]
            if entry:
                self.weight -= self.entries.pop(key)[2]
            pending = self.pending.get(key)
            owner = pending is None
            if owner:
                pending = self.pending[key] = PendingLoad()
                self.loads += 1
            future, consumers = pending.future, pending.consumers
            consumers.append(cancellation())
        if not owner:
            while True:
                check_cancelled()
                try:
                    return future.result(timeout=.05)
                except TimeoutError:
                    if future.done():
                        return future.result()
                    continue
                except Cancelled:
                    # The producer left before starting its work; a live consumer retries.
                    return self.get(key, load, weight, valid=valid)
        try:
            def abandoned():
                with self.lock:
                    callbacks = list(consumers)
                return all(callback() for callback in callbacks)
            with request_work(current_priority(), abandoned):
                value = load()
                check_cancelled()
            cost = max(1, weight(value))
            self._store(key, pending, value, cost, self.ttl)
            future.set_result(value)
            return value
        except Exception as error:
            if self.cache_errors(error):
                self._store(key, pending, type(error)(str(error)), 256, 2)
            # Remove before waking consumers, allowing retry after cancellation.
            self._release(key, pending)
            future.set_exception(error)
            raise
        finally:
            self._release(key, pending)

    def _release(self, key, pending):
        with self.lock:
            # A consumer can already have started a replacement after cancellation.
            if self.pending.get(key) is pending:
                del self.pending[key]

    def _store(self, key, pending, value, cost, ttl):
        with self.lock:
            if self.pending.get(key) is not pending or cost > self.max_weight:
                return
            previous = self.entries.pop(key, None)
            if previous:
                self.weight -= previous[2]
            self.entries[key] = (monotonic() + ttl, value, cost)
            self.weight += cost
            while self.weight > self.max_weight or len(self.entries) > self.max_entries:
                _, entry = self.entries.popitem(last=False)
                self.weight -= entry[2]

    def invalidate(self, predicate=lambda key: True):
        with self.lock:
            for key in list(self.pending):
                if predicate(key):
                    del self.pending[key]
            for key in list(self.entries):
                if predicate(key):
                    self.weight -= self.entries.pop(key)[2]
