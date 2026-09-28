"""Memory-bounded reuse, shared pending loads, and explicit invalidation."""

import threading
from collections import OrderedDict
from concurrent.futures import Future, TimeoutError
from time import monotonic

from .work import Cancelled, cancellation, check_cancelled, current_priority, request_work


class SharedCache:
    def __init__(self, max_weight, ttl=300, max_entries=4096):
        self.max_weight = max_weight
        self.ttl = ttl
        self.max_entries = max_entries
        self.entries = OrderedDict()
        self.pending = {}
        self.weight = 0
        self.generation = 0
        self.lock = threading.Lock()
        self.hits = self.loads = 0

    def get(self, key, load, weight=lambda value: 1):
        check_cancelled()
        with self.lock:
            entry = self.entries.get(key)
            if entry and entry[0] > monotonic():
                self.entries.move_to_end(key)
                self.hits += 1
                if isinstance(entry[1], Exception):
                    raise type(entry[1])(str(entry[1])) from None
                return entry[1]
            if entry:
                self.weight -= self.entries.pop(key)[2]
            token = (self.generation, key)
            pending = self.pending.get(token)
            owner = pending is None
            if owner:
                pending = self.pending[token] = (Future(), [])
                self.loads += 1
            future, consumers = pending
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
                    return self.get(key, load, weight)
        try:
            def abandoned():
                with self.lock:
                    callbacks = list(consumers)
                return all(callback() for callback in callbacks)
            with request_work(current_priority(), abandoned):
                value = load()
            cost = max(1, weight(value))
            self._store(token, value, cost, self.ttl)
            future.set_result(value)
            return value
        except Exception as error:
            if isinstance(error, (OSError, ValueError)) and not isinstance(error, Cancelled):
                self._store(token, type(error)(str(error)), 256, 2)
            # Remove before waking consumers, allowing retry after cancellation.
            with self.lock:
                self.pending.pop(token, None)
            future.set_exception(error)
            raise
        finally:
            with self.lock:
                self.pending.pop(token, None)

    def _store(self, token, value, cost, ttl):
        generation, key = token
        with self.lock:
            if generation != self.generation or cost > self.max_weight:
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
            self.generation += 1
            for key in list(self.entries):
                if predicate(key):
                    self.weight -= self.entries.pop(key)[2]
