import {createTransport} from './http.js';
import {createCatalogClient} from './catalog-client.js';
import {createMediaClient} from './media-client.js';

export {ApiError} from './http.js';

/** Compose clients and coordinate scoped refresh; views share one application instance. */
export function createApi(fetcher = (...args) => globalThis.fetch(...args)) {
    const transport = createTransport(fetcher);
    let catalog;
    const request = async (url, signal, data, progress) => {
        try { return await transport.request(url, signal, data, progress); }
        catch (error) {
            if (error.code === 'stale_view') {
                const scope = data?.root ?? data?.path
                    ?? new URL(url, 'http://localhost').searchParams.get('path') ?? '';
                catalog.invalidate(scope, {stale:true});
            }
            throw error;
        }
    };
    catalog = createCatalogClient(request);
    const media = createMediaClient({request, fetcher, onFacts:catalog.retainFacts});
    const refreshScope = async path => {
        const {scope} = await request('/api/refresh', undefined, {path});
        media.invalidate(scope);
        catalog.invalidate(scope);
        return scope;
    };
    return {getInfo:() => request('/api/info'), refreshScope,
        getFolder:catalog.getFolder, walkImages:catalog.walkImages, onFolderListing:catalog.onFolderListing,
        entries:catalog.entries, sequence:catalog.sequence, invalidateViews:catalog.invalidateViews,
        imageUrl:media.imageUrl, getMetadata:media.getMetadata, cachedThumbnail:media.cachedThumbnail,
        getThumbnail:media.getThumbnail, getVideoInfo:media.getVideoInfo};
}

export const {getInfo, refreshScope, getFolder, walkImages, onFolderListing, entries, sequence,
    invalidateViews, imageUrl, getMetadata, cachedThumbnail, getThumbnail, getVideoInfo} = createApi();
