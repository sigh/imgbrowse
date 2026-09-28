"""Bounded storage work with demand priority and cooperative cancellation."""

import threading
from contextlib import contextmanager
from time import monotonic

_local = threading.local()


class Cancelled(OSError):
    """The request no longer needs its queued work."""


def cancellation():
    return getattr(_local, 'cancel', lambda: False)


def current_priority():
    return getattr(_local, 'priority', 1)


def cancelled():
    return cancellation()()


def check_cancelled():
    if cancelled():
        raise Cancelled('Request cancelled')


@contextmanager
def request_work(priority=1, cancel=lambda: False):
    previous = getattr(_local, 'priority', 1), getattr(_local, 'cancel', lambda: False)
    _local.priority, _local.cancel = priority, cancel
    try:
        yield
    finally:
        _local.priority, _local.cancel = previous


class WorkGate:
    """Keep capacity available for demand while limiting speculative NAS work."""

    def __init__(self, capacity=8, background=4):
        self.capacity = capacity
        self.background = min(background, capacity)
        self.active = 0
        self.active_background = 0
        self.waiting = []
        self.condition = threading.Condition()
        self.owners = threading.local()

    def __enter__(self):
        priority = getattr(_local, 'priority', 1)
        ticket = (priority, monotonic(), object())
        with self.condition:
            if len(self.waiting) >= 128:
                raise OSError('Storage is busy; retry shortly')
            self.waiting.append(ticket)
            try:
                while True:
                    check_cancelled()
                    eligible = self.active < self.capacity and (priority < 2 or self.active_background < self.background)
                    first = min(self.waiting, key=lambda item: item[:2]) == ticket
                    if eligible and first:
                        self.active += 1
                        self.active_background += priority >= 2
                        self.owners.background = priority >= 2
                        return self
                    self.condition.wait(.05)
            finally:
                self.waiting.remove(ticket)
                self.condition.notify_all()

    def __exit__(self, *_):
        with self.condition:
            self.active -= 1
            self.active_background -= self.owners.background
            self.condition.notify_all()


class ByteBudget:
    """Limit simultaneous image buffers; a single oversize decode runs alone."""

    def __init__(self, capacity):
        self.capacity = capacity
        self.used = 0
        self.condition = threading.Condition()

    @contextmanager
    def reserve(self, amount):
        amount = min(self.capacity, max(1, amount))
        with self.condition:
            while self.used + amount > self.capacity:
                check_cancelled()
                self.condition.wait(.05)
            self.used += amount
        try:
            yield
        finally:
            with self.condition:
                self.used -= amount
                self.condition.notify_all()
