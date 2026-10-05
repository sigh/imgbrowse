import {CollectionWindow} from './collection-window.js';
import {filename, joinPath, parentPath, relatedScope, sortKey, sortSettings} from '../shared/state.js';

const MAX_PATHS = 2000;
const PAGE_SIZE = 60;

/** Retained listings and bounded recursive discovery; no DOM or presentation state. */
export class FolderData {
    constructor({getFolder, walkImages, seed}) {
        Object.assign(this, {getFolder, walkImages, seed});
        this.cache = new Map();
    }

    key(state) { return JSON.stringify([state.folder, sortKey(state)]); }
    clear(scope = '') {
        for (const [key, directory] of this.cache) if (relatedScope(directory.path, scope)) this.cache.delete(key);
    }

    createWindow(path, ordering, image) {
        return new CollectionWindow(this.walkImages, {root:path, ordering, image, pageSize:PAGE_SIZE, maxPaths:MAX_PATHS});
    }

    async open(state, signal, force = false, progress = () => {}) {
        const key = this.key(state);
        if (force) this.cache.delete(key);
        let directory = this.cache.get(key);
        if (!directory) {
            const path = state.folder, ordering = sortSettings(state);
            const create = (listing, preparation = null) => {
                if (signal.aborted) return;
                directory = {path, key, ordering, listing, preparation,
                    window:this.createWindow(path, ordering)};
                directory.window.edges[0].done = true;
                return directory;
            };
            const listing = await this.getFolder(path, signal, ordering, (listing, preparation) => {
                signal.throwIfAborted();
                if (listing) progress(create(listing, preparation));
                else if (directory) { directory.preparation = preparation; progress(directory); }
            });
            signal.throwIfAborted();
            create(listing);
            directory.window.edges[0].done = true;
        }
        signal.throwIfAborted();
        this.remember(directory);
        const {path, ordering, listing} = directory;
        this.seed(path, listing.images.slice(0, 2048).map(name => joinPath(path, name)),
            {...ordering, revision:listing.view_revision, start:true, end:listing.images.length <= 2048 && !listing.folders.length});
        return directory;
    }

    remember(directory) {
        this.cache.delete(directory.key);
        this.cache.set(directory.key, directory);
        const count = () => [...this.cache.values()].reduce((sum, item) => sum + item.window.paths.length
            + item.listing.folders.length + item.listing.images.length + item.listing.other_files.length, 0);
        while (this.cache.size > 3 || count() > 20000) this.cache.delete(this.cache.keys().next().value);
    }

    reveal(directory, path) {
        directory.window = this.createWindow(directory.path, directory.ordering, path);
        directory.window.windowed = true;
    }

    async load(directory, reverse, signal, anchor) {
        const result = await directory.window.load(directory.window.edges[reverse ? 0 : 1], signal, {anchor});
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
            {...directory.ordering, revision:directory.listing.view_revision, start:start === 0, end:end === images.length && !folders.length});
    }
}
