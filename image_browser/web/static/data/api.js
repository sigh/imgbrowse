import {ResourceCache} from './resource-cache.js';
import {Sequence} from './sequence.js';
import {sortSettings} from '../shared/state.js';
import {MetadataKind} from '../shared/media-kind.js';

/** HTTP details live here; views work with folder listings and traversal pages. */
async function request(url, signal, data) {
    const options = {signal};
    if (data !== undefined) {
        options.method = 'POST';
        options.headers = {'Content-Type': 'application/json'};
        options.body = JSON.stringify(data);
    }
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to load this folder');
    return result;
}

let mediaVersion = Date.now();
const thumbnails = new ResourceCache(32 * 1024 * 1024, 512);
const videoInfo = new ResourceCache(1024 * 1024, 4096);
const walks = new ResourceCache(4 * 1024 * 1024, 256);
const folders = new ResourceCache(4 * 1024 * 1024, 32);
const folderListeners = new Set();
export function onFolderListing(listener) {
    folderListeners.add(listener);
    return () => folderListeners.delete(listener);
}
function publishFolders(path, folders) {
    for (const listener of folderListeners) listener(path, folders);
}
export const sequence = new Sequence(async (options, signal) => {
    const result = await walks.get(JSON.stringify(options),
        shared => request('/api/walk', shared, options), signal, value => JSON.stringify(value).length * 2);
    if (result.folders) publishFolders(options.root || '', result.folders);
    return result;
});

export async function refreshScope(path) {
    await request('/api/refresh', undefined, {path});
    mediaVersion++; thumbnails.clear(); videoInfo.clear(); walks.clear(); folders.clear(); sequence.clear();
}

export const imageUrl = (path, thumbnail = false) =>
    (thumbnail ? '/thumbnail?' : '/image?') + new URLSearchParams({path, v: mediaVersion});

export const getInfo = () => request('/api/info');
/** Complete item facts; optional video failure preserves basic metadata and can be retried. */
export async function getMetadata(path, signal, onBasic = () => {}) {
    const data = await request('/api/metadata?' + new URLSearchParams({path}), signal);
    if (data.kind !== MetadataKind.VIDEO) return data;
    signal?.throwIfAborted();
    onBasic({...data, video_pending: true});
    try {
        return {...data, ...await getVideoInfo(path, signal)};
    } catch {
        signal?.throwIfAborted();
        return {...data, video_error: true};
    }
}

/** A name index for tree/traversal; Browse also requests bounded complete entry pages. */
export async function getFolder(path, signal, ordering = {}, page = {}) {
    const settings = sortSettings(ordering);
    const params = {...settings, ...page};
    if (page.names) params.names = JSON.stringify(page.names);
    const listing = await folders.get(JSON.stringify([path, params]),
        shared => request('/api/folder?' + new URLSearchParams({path, ...params}), shared), signal,
        value => JSON.stringify(value).length * 2);
    signal?.throwIfAborted();
    if (listing.folders) publishFolders(path, listing.natural_folders || listing.folders);
    return listing;
}

export const walkImages = (options, signal) => sequence.walk(options, signal);

export const cachedThumbnail = path => thumbnails.peek(path);
export const getVideoInfo = (path, signal) => videoInfo.get(path,
    shared => request('/api/video?' + new URLSearchParams({path}), shared), signal, () => 128);

export function getThumbnail(path, signal) {
    return thumbnails.get(path, async shared => {
        const response = await fetch(imageUrl(path, true), {signal: shared, priority: 'low'});
        if (!response.ok) {
            const detail = await response.json();
            throw Object.assign(new Error(detail.error || 'Preview unavailable'), {code: detail.code, mediaKind: detail.media_kind});
        }
        if (response.status === 204) return {blob: null, mediaKind: null};
        const blob = await response.blob();
        const duration = response.headers.get('X-Video-Duration');
        return {blob, mediaKind: response.headers.get('X-Media-Kind'),
            ...(duration !== null ? {duration: Number(duration)} : {})};
    }, signal, result => (result.blob?.size || 0) + 128);
}
