import {ResourceCache} from './resource-cache.js';
import {entryKey, filename, parentPath, relatedScope} from '../shared/state.js';

/** Shared facts are independent of ordering, geometry, and a view's lifetime. */
export class EntryStore {
    constructor(request) {
        this.request = request;
        this.revisions = new Map();
        this.listeners = new Set();
        this.records = new ResourceCache(4 * 1024 * 1024, 4000);
        this.batches = new ResourceCache(0, 0);
    }

    key(item, revision) { return JSON.stringify([item.path, item.type, revision]); }
    peek(item, revision) { return this.records.peek(this.key(item, revision)); }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    publish(event) { for (const listener of this.listeners) listener(event); }

    async load(path, revision, items, signal) {
        const identities = items.map(item => ({name:filename(item.path), type:item.type}));
        const batchKey = JSON.stringify([path, revision, identities]);
        const loadBatch = shared => this.request(path, identities, revision, shared);
        const results = await Promise.allSettled(items.map(item => this.records.get(this.key(item, revision),
            async shared => {
                const page = await this.batches.get(batchKey, loadBatch, shared);
                shared.throwIfAborted();
                const entry = page.entries.find(entry => entry.name === filename(item.path) && entry.type === item.type);
                if (!entry) throw new Error('Incomplete entry response');
                if (entry.status === 'error') throw Object.assign(new Error(entry.error), entry);
                return {...entry, path:item.path};
            }, signal, entry => JSON.stringify(entry).length * 2)));
        signal.throwIfAborted();
        this.publish({keys:new Set(results.flatMap((result, index) => result.status === 'fulfilled'
            ? [this.key(items[index], revision)] : []))});
        return results.map((result, index) => ({item:items[index], ...result}));
    }

    register(path, revision) {
        this.revisions.delete(path); this.revisions.set(path, revision);
        while (this.revisions.size > 256) this.revisions.delete(this.revisions.keys().next().value);
    }

    retain(item, revision, data) {
        // Info and Browse publish the same basic facts; enrichment stays in Info.
        const key = this.key(item, revision);
        const cached = this.records.peek(key);
        if (cached && (!data.facts_revision || cached.facts_revision === data.facts_revision)) return;
        this.records.set(key, {...data, ...item, name:filename(item.path)}, value => JSON.stringify(value).length * 2);
        this.publish({keys:new Set([key])});
    }

    invalidate(scope, {stale = false} = {}) {
        for (const path of this.revisions.keys()) if (relatedScope(path, scope)) this.revisions.delete(path);
        this.records.clear(key => relatedScope(parentPath(JSON.parse(key)[0]), scope));
        this.batches.clear(key => relatedScope(JSON.parse(key)[0], scope));
        this.publish({scope, stale});
    }
}

/** One view's visible demand. Obsolete requests leave shared facts available. */
export class FactDemand {
    constructor(store, path, revision, changed, comparisons = new Map()) {
        Object.assign(this, {store, path, revision, changed, comparisons});
        this.wanted = new Map();
        this.active = new Set();
        this.errors = new Map();
        this.disposed = false;
        this.unsubscribe = store.subscribe(event => {
            if (event.scope !== undefined) {
                if (!relatedScope(this.path, event.scope)) return;
                for (const task of this.active) task.controller.abort();
                this.errors.clear();
                if (event.stale && this.wanted.size) this.errors.set(this.wanted.keys().next().value,
                    Object.assign(new Error('Folder view changed'), {code:'stale_view'}));
            } else {
                const changed = [...this.wanted.values()].filter(item => event.keys.has(store.key(item, this.revision)));
                if (!changed.length) return;
                for (const item of changed) this.errors.delete(entryKey(item));
                this.checkRevisions();
            }
            this.changed(); this.pump();
        });
    }

    state(item) {
        const error = this.errors.get(entryKey(item));
        if (error?.code === 'stale_view') return {status:'error', error};
        return this.store.peek(item, this.revision) || (this.errors.has(entryKey(item))
            ? {status:'error', error:this.errors.get(entryKey(item))} : {status:'loading'});
    }

    update(items) {
        this.wanted = new Map(items.map(item => [entryKey(item), item]));
        for (const key of this.errors.keys()) if (!this.wanted.has(key)) this.errors.delete(key);
        for (const task of this.active) {
            if (!task.items.some(item => this.wanted.has(entryKey(item)))) task.controller.abort();
        }
        this.checkRevisions();
        this.pump();
    }

    checkRevisions() {
        for (const item of this.wanted.values()) {
            const fact = this.store.peek(item, this.revision), key = entryKey(item);
            if (fact && this.comparisons.has(key) && this.comparisons.get(key) !== (fact.modified?.key ?? null)) {
                this.errors.set(key, Object.assign(new Error('Modified order changed'), {code:'stale_view'}));
            }
        }
    }

    retry() { this.errors.clear(); this.pump(); }
    get loading() { return [...this.active].some(task => !task.controller.signal.aborted); }

    pump() {
        if (this.disposed) return;
        const pending = new Set([...this.active].filter(task => !task.controller.signal.aborted)
            .flatMap(task => task.items.map(entryKey)));
        const candidates = [...this.wanted.values()].filter(item => !this.store.peek(item, this.revision)
            && !pending.has(entryKey(item)) && !this.errors.has(entryKey(item)));
        while (candidates.length && [...this.active].filter(task => !task.controller.signal.aborted).length < 2) {
            const items = [];
            while (candidates.length && items.length < 60) {
                const item = candidates.shift();
                const proposed = [...items, item];
                const bytes = new TextEncoder().encode(JSON.stringify({path:this.path, revision:this.revision,
                    items:proposed.map(item => ({name:filename(item.path), type:item.type}))})).length;
                if (bytes > 120 * 1024) {
                    if (!items.length) this.errors.set(entryKey(item), new Error('Name exceeds the request size limit'));
                    else candidates.unshift(item);
                    break;
                }
                items.push(item);
            }
            if (!items.length) continue;
            const task = {items, controller:new AbortController()};
            this.active.add(task);
            this.store.load(this.path, this.revision, items, task.controller.signal).then(results => {
                for (const result of results) if (result.status === 'rejected' && this.wanted.has(entryKey(result.item))
                    && !this.store.peek(result.item, this.revision))
                    this.errors.set(entryKey(result.item), result.reason);
            }).catch(error => {
                if (!task.controller.signal.aborted) for (const item of items) {
                    if (this.wanted.has(entryKey(item))) this.errors.set(entryKey(item), error);
                }
            }).finally(() => {
                this.active.delete(task);
                if (!this.disposed) { this.checkRevisions(); this.changed(); this.pump(); }
            });
        }
    }

    dispose() {
        this.disposed = true;
        this.unsubscribe();
        for (const task of this.active) task.controller.abort();
        this.wanted.clear();
    }
}
