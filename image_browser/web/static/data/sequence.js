/** Shared, bounded adjacency for grid discoveries, reader navigation, and the strip. */
import {relatedScope, sortKey, sortSettings} from '../shared/state.js';

export class Sequence {
    constructor(request, limit = 10000) {
        this.request = request;
        this.limit = limit;
        this.links = new Map();
        this.versions = new Map();
        this.listeners = new Set();
    }
    onInvalidation(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    key(root, path, reverse, ordering = {}) { return JSON.stringify([root, path, reverse, sortKey(ordering)]); }
    put(root, path, reverse, next, ordering = {}) {
        const key = this.key(root, path, reverse, ordering);
        this.links.delete(key); this.links.set(key, next);
        while (this.links.size > this.limit) this.links.delete(this.links.keys().next().value);
    }
    seed(root, images, options = {}) {
        const {start = false, end = false} = options;
        if (options.revision) this.observe(root, options, {[root]:options.revision});
        for (let i = 1; i < images.length; i++) {
            this.put(root, images[i - 1], false, images[i], options);
            this.put(root, images[i], true, images[i - 1], options);
        }
        if (images.length && start) { this.put(root, null, false, images[0], options); this.put(root, images[0], true, null, options); }
        if (images.length && end) { this.put(root, null, true, images.at(-1), options); this.put(root, images.at(-1), false, null, options); }
    }
    async walk(options, signal) {
        signal?.throwIfAborted();
        const {root = '', reverse = false, limit = 60} = options;
        const ordering = sortSettings(options);
        const continuation = options.cursor;
        const anchor = continuation && !Array.isArray(continuation) ? continuation.anchor : options.anchor ?? null;
        const cursor = continuation && !Array.isArray(continuation) ? continuation.server : continuation;
        if (!cursor) {
            const images = [];
            let path = anchor;
            while (images.length < limit) {
                const key = this.key(root, path, reverse, ordering);
                if (!this.links.has(key)) break;
                path = this.links.get(key);
                if (path === null) return {images, cursor:null, warnings:[], revisions:this.versions.get(JSON.stringify([root, sortKey(ordering)])) || {}};
                images.push(path);
            }
            if (images.length) return {images, cursor:{anchor:path, server:null}, warnings:[], revisions:this.versions.get(JSON.stringify([root, sortKey(ordering)])) || {}};
        }
        const result = await this.request({...options, ...ordering, anchor, cursor: cursor || null}, signal);
        signal?.throwIfAborted();
        this.observe(root, ordering, result.revisions || {});
        const ordered = reverse ? [...result.images].reverse() : result.images;
        this.seed(root, ordered, ordering);
        if (result.images.length && !result.anchor_missing) {
            this.put(root, anchor, reverse, result.images[0], ordering);
            if (anchor !== null) this.put(root, result.images[0], !reverse, anchor, ordering);
        }
        const tail = result.images.at(-1) ?? anchor;
        if (result.cursor === null && !result.warnings.length && (!result.anchor_missing || result.images.length))
            this.put(root, tail, reverse, null, ordering);
        return {...result, cursor: result.cursor === null ? null : {server: result.cursor, anchor: tail}};
    }
    observe(root, ordering, revisions) {
        const key = JSON.stringify([root, sortKey(ordering)]);
        const known = this.versions.get(key) || {};
        if (Object.entries(revisions).some(([path, revision]) => known[path] && known[path] !== revision)) {
            for (const link of this.links.keys()) {
                const [collection, , , sort] = JSON.parse(link);
                if (collection === root && sort === sortKey(ordering)) this.links.delete(link);
            }
            for (const listener of this.listeners) listener({root, ordering});
        }
        this.versions.delete(key); this.versions.set(key, {...known, ...revisions});
        while (this.versions.size > 256 || [...this.versions.values()].reduce((sum, versions) => sum + Object.keys(versions).length, 0) > this.limit) {
            const oldest = this.versions.keys().next().value;
            const [collection, sort] = JSON.parse(oldest);
            this.versions.delete(oldest);
            for (const key of this.links.keys()) {
                const [root, , , ordering] = JSON.parse(key);
                if (root === collection && ordering === sort) this.links.delete(key);
            }
        }
    }
    clear(scope = '') {
        for (const listener of this.listeners) listener({scope});
        for (const key of this.links.keys()) if (relatedScope(JSON.parse(key)[0], scope)) this.links.delete(key);
        for (const key of this.versions.keys()) if (relatedScope(JSON.parse(key)[0], scope)) this.versions.delete(key);
    }
}
