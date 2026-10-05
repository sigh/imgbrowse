/** Bounded LRU values and shared requests; the last departing consumer cancels work. */
export class ResourceCache {
    constructor(maxBytes, maxEntries = 256, dispose = () => {}) {
        Object.assign(this, {maxBytes, maxEntries, dispose});
        this.values = new Map();
        this.pending = new Map();
        this.bytes = 0;
    }

    peek(key) { return this.values.get(key)?.value; }

    getCached(key) {
        const entry = this.values.get(key);
        if (entry) {
            this.values.delete(key); this.values.set(key, entry);
        }
        return entry?.value;
    }

    /** Publish an authoritative value, superseding any older shared request. */
    set(key, value, weight = () => 1) {
        const bytes = weight(value);
        this.clear(candidate => candidate === key);
        this._retain(key, value, bytes);
    }

    _retain(key, value, bytes) {
        this.values.set(key, {value, bytes}); this.bytes += bytes;
        while (this.bytes > this.maxBytes || this.values.size > this.maxEntries) {
            const oldest = this.values.keys().next().value;
            const entry = this.values.get(oldest);
            this.values.delete(oldest); this.bytes -= entry.bytes;
            this.dispose(entry.value);
        }
    }

    async get(key, load, signal, weight = () => 1) {
        signal?.throwIfAborted();
        const cached = this.getCached(key);
        if (cached !== undefined) return cached;
        let task = this.pending.get(key);
        if (!task) {
            const controller = new AbortController();
            task = {controller, users: 0};
            this.pending.set(key, task);
            task.promise = Promise.resolve().then(() => load(controller.signal)).then(value => {
                if (this.pending.get(key) === task && !controller.signal.aborted) {
                    this._retain(key, value, weight(value));
                } else {
                    this.dispose(value);
                    throw new DOMException('Aborted', 'AbortError');
                }
                return value;
            }).finally(() => {
                if (this.pending.get(key) === task) this.pending.delete(key);
            });
        }
        task.users++;
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (fn, value) => {
                if (finished) return;
                finished = true;
                signal?.removeEventListener('abort', abort);
                if (--task.users === 0 && this.pending.get(key) === task) {
                    this.pending.delete(key); task.controller.abort();
                }
                fn(value);
            };
            const abort = () => finish(reject, new DOMException('Aborted', 'AbortError'));
            signal?.addEventListener('abort', abort, {once: true});
            task.promise.then(value => finish(resolve, value), error => finish(reject, error));
            if (signal?.aborted) abort();
        });
    }

    clear(predicate = () => true) {
        for (const [key, task] of this.pending) if (predicate(key)) {
            this.pending.delete(key); task.controller.abort();
        }
        for (const [key, entry] of this.values) if (predicate(key)) {
            this.values.delete(key); this.bytes -= entry.bytes;
            this.dispose(entry.value);
        }
    }
}
