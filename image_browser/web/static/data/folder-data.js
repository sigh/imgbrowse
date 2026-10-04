import {CollectionWindow} from './collection-window.js';
import {filename, joinPath, parentPath, sortKey, sortSettings} from '../shared/state.js';

const MAX_PATHS = 2000;
const PAGE_SIZE = 60;

/** Retained listings and bounded recursive discovery; no DOM or presentation state. */
export class FolderData {
    constructor({getFolder, walkImages, seed}) {
        Object.assign(this, {getFolder, walkImages, seed});
        this.cache = new Map();
    }

    key(state) { return JSON.stringify([state.folder, sortKey(state)]); }
    clear() { this.cache.clear(); }

    createWindow(path, ordering, image) {
        return new CollectionWindow(this.walkImages, {root:path, ordering, image, pageSize:PAGE_SIZE, maxPaths:MAX_PATHS});
    }

    async open(state, signal, force = false) {
        const key = this.key(state);
        if (force) this.cache.delete(key);
        let directory = this.cache.get(key);
        if (!directory) {
            const path = state.folder, ordering = sortSettings(state);
            const {entries = [], ...listing} = await this.getFolder(path, signal, ordering, state.recursive ? {} : {limit:PAGE_SIZE});
            signal.throwIfAborted();
            directory = {path, key, ordering, listing, entries:new Map(), pending:null, error:'',
                window:this.createWindow(path, ordering)};
            this.retainEntries(directory, entries);
            directory.window.edges[0].done = true;
        }
        signal.throwIfAborted();
        this.remember(directory);
        const {path, ordering, listing} = directory;
        this.seed(path, listing.images.slice(0, 2048).map(name => joinPath(path, name)),
            {...ordering, start:true, end:listing.images.length <= 2048 && !listing.folders.length});
        return directory;
    }

    remember(directory) {
        this.cache.delete(directory.key);
        this.cache.set(directory.key, directory);
        const count = () => [...this.cache.values()].reduce((sum, item) => sum + item.window.paths.length
            + item.entries.size + item.listing.folders.length + item.listing.images.length + item.listing.other_files.length, 0);
        while (this.cache.size > 3 || count() > 20000) this.cache.delete(this.cache.keys().next().value);
    }

    retainEntries(directory, entries) {
        for (const entry of entries) {
            directory.entries.delete(entry.name);
            directory.entries.set(entry.name, {...entry, path:joinPath(directory.path, entry.name)});
        }
        while (directory.entries.size > MAX_PATHS) directory.entries.delete(directory.entries.keys().next().value);
    }

    entriesLoading(directory) { return Boolean(directory?.pending && !directory.pending.aborted); }

    async loadEntries(directory, items, signal) {
        const names = items.map(item => filename(item.path)).filter(name => !directory.entries.has(name)).slice(0, PAGE_SIZE);
        if (!names.length || this.entriesLoading(directory) || directory.error) return;
        directory.pending = signal;
        try {
            const page = await this.getFolder(directory.path, signal, directory.ordering,
                {names, ...(directory.listing.revision ? {revision:directory.listing.revision} : {})});
            signal.throwIfAborted();
            this.retainEntries(directory, page.entries);
            this.remember(directory);
        } finally {
            if (directory.pending === signal) directory.pending = null;
        }
    }

    reveal(directory, path) {
        directory.window = this.createWindow(directory.path, directory.ordering, path);
        directory.window.windowed = true;
    }

    async load(directory, reverse, signal) {
        const result = await directory.window.load(directory.window.edges[reverse ? 0 : 1], signal);
        if (result) this.remember(directory);
        return result;
    }

    seedAround(directory, image, collection) {
        if (!image || !directory || parentPath(image) !== directory.path || collection !== directory.path) return;
        const {images, folders} = directory.listing;
        const index = images.indexOf(filename(image));
        if (index < 0) return;
        const start = Math.max(0, index - 32), end = Math.min(images.length, index + 33);
        this.seed(collection, images.slice(start, end).map(name => joinPath(collection, name)),
            {...directory.ordering, start:start === 0, end:end === images.length && !folders.length});
    }
}
