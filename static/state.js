/** URL state is the source of truth for folder and viewer navigation. */
export const joinPath = (parent, name) => parent ? parent + '/' + name : name;
export const parentPath = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const filename = path => path.split('/').pop();

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
        recursive: query.get('recursive') === '1',
        filter: query.get('filter') || '',
        image,
        collection: query.get('collection') ?? folder,
        viewing: image !== null || query.get('viewer') === '1',
    };
}

export function stateUrl(next) {
    const query = new URLSearchParams({folder: next.folder, sort: 'natural'});
    if (next.recursive) query.set('recursive', '1');
    if (next.filter) query.set('filter', next.filter);
    if (next.viewing) {
        if (next.collection !== next.folder) query.set('collection', next.collection);
        if (next.image != null) query.set('image', next.image);
        else query.set('viewer', '1');
    }
    return '/?' + query;
}

