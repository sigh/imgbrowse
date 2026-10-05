import {ResourceCache} from './resource-cache.js';
import {Sequence} from './sequence.js';
import {EntryStore} from './entry-store.js';
import {relatedScope, sortSettings} from '../shared/state.js';

/** Cached catalog queries, shared basic facts, and collection adjacency. */
export function createCatalogClient(request) {
    const walks = new ResourceCache(4 * 1024 * 1024, 256);
    const folders = new ResourceCache(4 * 1024 * 1024, 32);
    const folderListeners = new Set();
    const folderRequests = new Map();
    function onFolderListing(listener) {
        folderListeners.add(listener);
        return () => folderListeners.delete(listener);
    }
    function publishFolders(path, folders) {
        for (const listener of folderListeners) listener(path, folders);
    }
    const sequence = new Sequence(async (options, signal) => {
        const result = await walks.get(JSON.stringify(options),
            shared => request('/api/walk', shared, options), signal, value => JSON.stringify(value).length * 2);
        if (result.folders) publishFolders(options.root || '', result.folders);
        return result;
    });

    function invalidateViews(scope) {
        folders.clear(key => relatedScope(JSON.parse(key)[0], scope));
        walks.clear(key => relatedScope(JSON.parse(key).root || '', scope));
        sequence.clear(scope);
    }

    /** Membership carries identities. Basic facts use a separate bounded POST. */
    async function getFolder(path, signal, ordering = {}, progress = () => {}) {
        const settings = sortSettings(ordering), key = JSON.stringify([path, settings]);
        const normalize = result => {
            entries.register(path, result.revision);
            return {...result, folders:result.items.filter(item => item.type === 'folder').map(item => item.name),
                images:result.items.filter(item => item.type === 'image').map(item => item.name),
                other_files:result.items.filter(item => item.type === 'file').map(item => item.name)};
        };
        const active = folderRequests.get(key) || {listeners:new Set()};
        folderRequests.set(key, active);
        const listener = (listing, preparation) => { if (!signal?.aborted) progress(listing, preparation); };
        active.listeners.add(listener);
        let listing;
        try {
            if (active.preparation) listener(active.listing || null, active.preparation);
            const result = await folders.get(key,
                shared => {
                    shared.addEventListener('abort', () => {
                        if (folderRequests.get(key) === active) folderRequests.delete(key);
                    }, {once:true});
                    return request('/api/folder?' + new URLSearchParams({path, ...settings}), shared, undefined, state => {
                        shared.throwIfAborted();
                        const {listing, ...preparation} = state;
                        const preview = listing ? normalize(listing) : null;
                        if (preview) active.listing = preview;
                        active.preparation = preparation;
                        for (const listener of active.listeners) listener(preview, preparation);
                    });
                }, signal, value => JSON.stringify(value).length * 2);
            signal?.throwIfAborted();
            listing = normalize(result);
        } finally {
            active.listeners.delete(listener);
            if (!active.listeners.size && folderRequests.get(key) === active) folderRequests.delete(key);
        }
        if (listing.natural_folders) publishFolders(path, listing.natural_folders);
        return listing;
    }
    const entries = new EntryStore((path, items, revision, signal) =>
        request('/api/folder/entries', signal, {path, items, revision}));

    const walkImages = (options, signal) => sequence.walk(options, signal);

    function retainFacts(path, type, data) {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const revision = entries.revisions.get(parent);
        if (revision) entries.retain({path, type}, revision, {status:'ready', facts_revision:data.facts_revision,
            modified:data.modified, source_version:data.source_version, size:data.size,
            compressed_size:data.compressed_size, unavailable:data.unavailable});
    }
    function invalidate(scope, {stale = false} = {}) {
        invalidateViews(scope);
        entries.invalidate(scope, {stale});
    }
    return {getFolder, walkImages, onFolderListing, entries, sequence, retainFacts, invalidateViews, invalidate};
}
