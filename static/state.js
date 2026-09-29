/** URL state is the source of truth for folder and viewer navigation. */
export const joinPath = (parent, name) => parent ? parent + '/' + name : name;
export const parentPath = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const filename = path => path.split('/').pop();

/** Display a path relative to its browsing folder; that folder itself is empty. */
export function relativePath(base, path) {
    const from = base.split('/').filter(Boolean);
    const to = path.split('/').filter(Boolean);
    let shared = 0;
    while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
    return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
}

export const IMAGE_SIZES = ['page', 'width', '0.1', '0.25', '0.5', '0.75', '1', '1.25', '1.5', '2', '3', '4', '6', '8'];
export const imageSize = value => IMAGE_SIZES.includes(String(value)) ? String(value) : 'page';

export function readState(search = location.search) {
    const query = new URLSearchParams(search);
    const legacyFolder = query.get('category') ?? query.get('m');
    const folder = query.get('folder') ?? legacyFolder ?? '';
    let image = query.get('image') ?? query.get('img');
    if (legacyFolder !== null && !query.has('folder') && image !== null) {
        // Older versions stored an already URL-encoded image path in the query.
        try { image = decodeURIComponent(image); } catch { /* Leave malformed links readable. */ }
    }
    return {
        folder,
        size: imageSize(query.get('size')),
        recursive: query.get('recursive') === '1',
        compact: query.get('compact') === '1',
        filter: query.get('filter') || '',
        image,
        collection: query.get('collection') ?? folder,
        viewing: image !== null || query.get('viewer') === '1',
    };
}

export function stateUrl(next) {
    const query = new URLSearchParams({folder: next.folder, sort: 'natural'});
    if (next.recursive) query.set('recursive', '1');
    if (next.compact) query.set('compact', '1');
    if (next.filter) query.set('filter', next.filter);
    if (next.viewing) {
        if (imageSize(next.size) !== 'page') query.set('size', imageSize(next.size));
        if (next.collection !== next.folder) query.set('collection', next.collection);
        if (next.image != null) query.set('image', next.image);
        else query.set('viewer', '1');
    }
    return '/?' + query;
}
