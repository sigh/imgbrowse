/** Shared, bounded adjacency for grid discoveries, reader navigation, and the strip. */
import {sortKey, sortSettings} from './state.js';

export class Sequence {
    constructor(request, limit = 10000) {
        this.request = request;
        this.limit = limit;
        this.links = new Map();
    }
    key(root, path, reverse, ordering = {}) { return JSON.stringify([root, path, reverse, sortKey(ordering)]); }
    put(root, path, reverse, next, ordering = {}) {
        const key = this.key(root, path, reverse, ordering);
        this.links.delete(key); this.links.set(key, next);
        while (this.links.size > this.limit) this.links.delete(this.links.keys().next().value);
    }
    seed(root, images, options = {}) {
        const {start = false, end = false} = options;
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
                if (path === null) return {images, cursor: null, warnings: []};
                images.push(path);
            }
            if (images.length) return {images, cursor: {anchor: path, server: null}, warnings: []};
        }
        const result = await this.request({...options, ...ordering, anchor, cursor: cursor || null}, signal);
        signal?.throwIfAborted();
        const ordered = reverse ? [...result.images].reverse() : result.images;
        this.seed(root, ordered, ordering);
        if (result.images.length) {
            this.put(root, anchor, reverse, result.images[0], ordering);
            if (anchor !== null) this.put(root, result.images[0], !reverse, anchor, ordering);
        }
        const tail = result.images.at(-1) ?? anchor;
        if (result.cursor === null && !result.warnings.length) this.put(root, tail, reverse, null, ordering);
        return {...result, cursor: result.cursor === null ? null : {server: result.cursor, anchor: tail}};
    }
    clear() { this.links.clear(); }
}
