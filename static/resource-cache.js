/** Bounded LRU values and shared requests; the last departing consumer cancels work. */
export class ResourceCache {
    constructor(maxBytes, maxEntries = 256, dispose = () => {}) {
        Object.assign(this, {maxBytes, maxEntries, dispose});
        this.values = new Map();
        this.pending = new Map();
        this.bytes = 0;
        this.generation = 0;
    }

    peek(key) { return this.values.get(key)?.value; }

    async get(key, load, signal, weight = () => 1) {
        signal?.throwIfAborted();
        const cached = this.values.get(key);
        if (cached) {
            this.values.delete(key); this.values.set(key, cached);
            return cached.value;
        }
        let task = this.pending.get(key);
        if (!task) {
            const controller = new AbortController();
            const generation = this.generation;
            task = {controller, users: 0};
            this.pending.set(key, task);
            task.promise = Promise.resolve().then(() => load(controller.signal)).then(value => {
                if (generation === this.generation && !controller.signal.aborted) {
                    const bytes = weight(value);
                    this.values.set(key, {value, bytes}); this.bytes += bytes;
                    while (this.bytes > this.maxBytes || this.values.size > this.maxEntries) {
                        const oldest = this.values.keys().next().value;
                        const entry = this.values.get(oldest);
                        this.values.delete(oldest); this.bytes -= entry.bytes;
                        this.dispose(entry.value);
                    }
                } else this.dispose(value);
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

    clear() {
        this.generation++;
        for (const task of this.pending.values()) task.controller.abort();
        this.pending.clear();
        for (const entry of this.values.values()) this.dispose(entry.value);
        this.values.clear(); this.bytes = 0;
    }
}
