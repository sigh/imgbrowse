import {ResourceCache} from './resource-cache.js';
import {Sequence} from './sequence.js';
import {EntryStore} from './entry-store.js';
import {relatedScope, sortSettings} from '../shared/state.js';

/** Cached catalog queries, shared basic facts, and collection adjacency. */
export function createCatalogClient(request) {
    const walks = new ResourceCache(4 * 1024 * 1024, 256);
    const folders = new ResourceCache(4 * 1024 * 1024, 32);
    const folderListeners = new Set();
    const orderListeners = new Map();
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
        const settings = sortSettings(ordering);
        const load = async (settings, callback = () => {}) => {
            const key = JSON.stringify([path, settings]);
            const listeners = orderListeners.get(key) || new Set();
            orderListeners.set(key, listeners);
            const listener = state => { if (!signal?.aborted) callback(state); };
            listeners.add(listener);
            let result;
            try {
                result = await folders.get(key,
                    shared => request('/api/folder?' + new URLSearchParams({path, ...settings}), shared, undefined,
                        state => { for (const listener of orderListeners.get(key) || []) listener(state); }), signal,
                    value => JSON.stringify(value).length * 2);
            } finally {
                listeners.delete(listener);
                if (!listeners.size && orderListeners.get(key) === listeners) orderListeners.delete(key);
            }
            signal?.throwIfAborted();
            entries.register(path, result.revision);
            return {...result, folders:result.items.filter(item => item.type === 'folder').map(item => item.name),
                images:result.items.filter(item => item.type === 'image').map(item => item.name),
                other_files:result.items.filter(item => item.type === 'file').map(item => item.name)};
        };
        if (settings.sort === 'modified' && !folders.peek(JSON.stringify([path, settings])) && typeof progress === 'function')
            progress(await load({sort:'natural', order:'asc'}), {status:'preparing'});
        const listing = await load(settings, state => typeof progress === 'function' && progress(null, state));
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
