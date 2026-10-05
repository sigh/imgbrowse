import {ResourceCache} from './resource-cache.js';
import {relatedScope} from '../shared/state.js';
import {MetadataKind} from '../shared/media-kind.js';

/** Versioned media URLs, thumbnails, and optional metadata enrichment. */
export function createMediaClient({request, fetcher, onFacts = () => {}}) {
    const mediaVersions = new Map();
    const mediaVersion = path => Math.max(0, ...[...mediaVersions].filter(([scope]) => relatedScope(path, scope)).map(([, value]) => value));
    const thumbnails = new ResourceCache(32 * 1024 * 1024, 512);
    const videoInfo = new ResourceCache(1024 * 1024, 4096);
    const imageUrl = (path, thumbnail = false, kind = 'image') =>
        (thumbnail ? '/thumbnail?' : '/image?') + new URLSearchParams({path, kind, v:mediaVersion(path)});

    /** Complete item facts; optional video failure preserves basic metadata and can be retried. */
    async function getMetadata(path, signal, {onBasic = () => {}, kind = null} = {}) {
        const data = await request('/api/metadata?' + new URLSearchParams({path, ...(kind ? {kind} : {})}), signal);
        signal?.throwIfAborted();
        const type = kind || (['directory','archive'].includes(data.kind) ? 'folder' : data.kind === 'file' ? 'file' : 'image');
        onFacts(path, type, data);
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

    const cachedThumbnail = (path, kind = 'image') => thumbnails.peek(JSON.stringify([path, kind]));
    const getVideoInfo = (path, signal) => videoInfo.get(path,
        shared => request('/api/video?' + new URLSearchParams({path}), shared), signal, () => 128);

    function getThumbnail(path, signal, kind = 'image') {
        return thumbnails.get(JSON.stringify([path, kind]), async shared => {
            const response = await fetcher(imageUrl(path, true, kind), {signal: shared, priority: 'low'});
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

    function invalidate(scope) {
        const now = Date.now();
        for (const [path, version] of mediaVersions) if (now - version > 300000) mediaVersions.delete(path);
        mediaVersions.set(scope, now);
        thumbnails.clear(key => relatedScope(JSON.parse(key)[0], scope));
        videoInfo.clear(key => relatedScope(key, scope));
    }
    return {imageUrl, getMetadata, cachedThumbnail, getThumbnail, getVideoInfo, invalidate};
}
