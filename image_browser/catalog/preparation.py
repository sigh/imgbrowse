"""Bounded, leased background preparation for fact-based ordering.

Live jobs own their index and comparison values independently of LRU retention.
Only a completed set of facts can be used to publish an ordered view.
"""

from __future__ import annotations

import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from time import monotonic

from image_browser.catalog.errors import OrderTooLarge
from image_browser.runtime.refresh import intersects
from image_browser.runtime.work import Busy, Cancelled, Invalidated, request_work


class Preparing(Exception):
    def __init__(self, progress):
        super().__init__('Preparing order')
        self.progress = progress


@dataclass
class Preparation:
    index: object
    ordering: object
    weight: int
    valid: object
    leases: dict = field(default_factory=dict)
    completed: int = 0
    values: object = None
    error: Exception | None = None
    touched: float = field(default_factory=monotonic)
    stop: threading.Event = field(default_factory=threading.Event)


class OrderPreparations:
    MAX_JOBS = 2
    MAX_BYTES = 128 * 1024 * 1024
    LEASE_SECONDS = 15
    RETAIN_SECONDS = 60

    def __init__(self, repository):
        self.repository = repository
        self.jobs = {}
        self.running = {}
        self.lock = threading.RLock()
        self.local = threading.local()

    @property
    def asynchronous(self):
        return getattr(self.local, 'required', False)

    @contextmanager
    def required(self, token=None):
        if token is not None and not isinstance(token, str):
            raise ValueError('Invalid preparation token')
        previous = getattr(self.local, 'required', False), getattr(self.local, 'token', None)
        self.local.required, self.local.token = True, token
        try:
            yield
        finally:
            self.local.required, self.local.token = previous

    def cleanup(self):
        now = monotonic()
        for key, job in list(self.jobs.items()):
            job.leases = {token: until for token, until in job.leases.items() if until > now}
            if (job.stop.is_set() or not job.valid() or
                    (job.values is None and not job.leases) or
                    (job.values is not None and now - job.touched > self.RETAIN_SECONDS)):
                job.stop.set()
                del self.jobs[key]

    def bytes_used(self):
        # Cancelled workers still own memory until their storage call returns.
        jobs = {id(job):job for job in self.jobs.values()}
        jobs.update(self.running)
        return sum(job.weight for job in jobs.values())

    def ready(self, index, ordering, valid):
        key = (index.path, index.revision, ordering.sort)
        with self.lock:
            self.cleanup()
            job = self.jobs.get(key)
            if job and job.values is not None:
                job.touched = monotonic()
                return job.values
            if not self.asynchronous:
                return None
            if job is None:
                # Includes descriptors, references, keys, and eventual fact values.
                weight = 512 + sum(768 + len(entry.path) * 8 for entry in index.entries.values())
                if weight > self.MAX_BYTES:
                    raise OrderTooLarge('Collection exceeds ordering preparation budget; browse by name')
                if len(self.running) >= self.MAX_JOBS:
                    raise Busy('Ordering preparation is at capacity; retry shortly')
                while self.bytes_used() + weight > self.MAX_BYTES:
                    candidates = [(item.touched, old_key) for old_key, item in self.jobs.items()
                                  if item.values is not None and not item.leases]
                    if not candidates:
                        raise Busy('Ordering preparation is at capacity; retry shortly')
                    del self.jobs[min(candidates)[1]]
                job = Preparation(index, ordering, weight, valid)
                self.jobs[key] = job
                self.running[id(job)] = job
                start = True
            else:
                start = False
            token = getattr(self.local, 'token', None)
            if token not in job.leases:
                token = uuid.uuid4().hex
            job.leases[token] = monotonic() + self.LEASE_SECONDS
            job.touched = monotonic()
            if start:
                threading.Thread(target=self.run, args=(job,), daemon=True,
                                 name='order-preparation').start()
            if job.error:
                error = job.error
                self.jobs.pop(key, None)
                raise error
            raise Preparing({'status': 'preparing', 'path': index.path, 'revision': index.revision,
                             'completed': job.completed,
                             'total': sum(len(index.groups[kind]) for kind in ordering.fact_groups),
                             'token': token})

    def run(self, job):
        def cancelled():
            with self.lock:
                return (job.stop.is_set() or not job.valid() or
                        not any(until > monotonic() for until in job.leases.values()))
        try:
            with request_work(2, cancelled):
                values = self.repository.comparison_values(job.index, job.ordering, job.valid,
                    progress=lambda: self.advance(job))
            with self.lock:
                if not cancelled():
                    job.values = values
        except Exception as error:  # noqa: BLE001
            # Every worker failure must reach polling consumers, including bugs.
            with self.lock:
                job.error = error
                if isinstance(error, (Cancelled, Invalidated)):
                    job.stop.set()

        finally:
            with self.lock:
                self.running.pop(id(job), None)

    def advance(self, job):
        with self.lock:
            job.completed += 1

    def completed(self, path, criterion):
        with self.lock:
            return tuple(job.values for key, job in self.jobs.items()
                         if key[0] == path and key[2] == criterion
                         and job.values is not None and not job.stop.is_set())

    def cancel(self, token):
        if not isinstance(token, str):
            # Invalid JSON inputs follow the API's ValueError/HTTP 400 contract.
            raise ValueError('Invalid preparation token')  # noqa: TRY004
        with self.lock:
            for job in self.jobs.values():
                job.leases.pop(token, None)
            self.cleanup()

    def invalidate(self, scope, *, exact=False):
        with self.lock:
            for key, job in list(self.jobs.items()):
                related = key[0] == scope if exact else intersects(key[0], scope)
                if related:
                    job.stop.set()
                    del self.jobs[key]
