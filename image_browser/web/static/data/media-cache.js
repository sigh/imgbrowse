import {ResourceCache} from './resource-cache.js';
import {imageUrl} from './api.js';

/** A few decoded originals; decoded pixel cost counts toward the budget. */
export const originals = new ResourceCache(96 * 1024 * 1024, 4, value => URL.revokeObjectURL(value.url));
export const clearOriginals = () => originals.clear();

/** Decoded images return immediately; uncached images return a loading promise. */
export function loadOriginal(path, signal, prefetch = false) {
    signal?.throwIfAborted();
    const cached = originals.getCached(path);
    if (cached) return cached;
    return originals.get(path, async sharedSignal => {
        const response = await fetch(imageUrl(path) + (prefetch ? '&prefetch=1' : ''),
            {signal: sharedSignal, priority: prefetch ? 'low' : 'high'});
        if (!response.ok) throw new Error('Image unavailable');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.src = url;
        try { await image.decode(); sharedSignal.throwIfAborted(); }
        catch (error) { URL.revokeObjectURL(url); throw error; }
        image.alt = path.split('/').pop();
        image.dataset.path = path;
        return {image, url, bytes: blob.size + image.naturalWidth * image.naturalHeight * 4};
    }, signal, value => value.bytes);
}
