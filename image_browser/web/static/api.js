import {ResourceCache} from './resource-cache.js';
import {Sequence} from './sequence.js';

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
const previews = new ResourceCache(1024 * 1024, 2048);
const walks = new ResourceCache(4 * 1024 * 1024, 256);
export const sequence = new Sequence((options, signal) => walks.get(JSON.stringify(options),
    shared => request('/api/walk', shared, options), signal, value => JSON.stringify(value).length * 2));

export async function refreshScope(path) {
    await request('/api/refresh', undefined, {path});
    mediaVersion++; thumbnails.clear(); videoInfo.clear(); previews.clear(); walks.clear(); sequence.clear();
}

export const imageUrl = (path, thumbnail = false) =>
    (thumbnail ? '/thumbnail?' : '/image?') + new URLSearchParams({path, v: mediaVersion});

export const getInfo = () => request('/api/info');
export const getLocation = path => request('/api/location?' + new URLSearchParams({path}));

export const getFolder = (path, signal) =>
    request('/api/folder?' + new URLSearchParams({path}), signal);

export const getPreview = (path, signal) =>
    previews.get(path, shared => request('/api/preview?' + new URLSearchParams({path}), shared), signal,
        value => JSON.stringify(value).length * 2);

export const walkImages = (options, signal) => sequence.walk(options, signal);

export const cachedThumbnail = path => thumbnails.peek(path);
export const getVideoInfo = (path, signal) => videoInfo.get(path,
    shared => request('/api/video?' + new URLSearchParams({path}), shared), signal, () => 128);

export function getThumbnail(path, signal) {
    return thumbnails.get(path, async shared => {
        const response = await fetch(imageUrl(path, true), {signal: shared, priority: 'low'});
        if (!response.ok) throw new Error('Preview unavailable');
        const blob = await response.blob();
        const duration = response.headers.get('X-Video-Duration');
        if (duration !== null) blob.duration = Number(duration);
        return blob;
    }, signal, blob => blob.size);
}
