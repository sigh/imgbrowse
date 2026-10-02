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

function resolveImage(folder, image) {
    const parts = [];
    for (const part of joinPath(folder, image).split('/')) {
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
}

export function readState(search = location.search) {
    const query = new URLSearchParams(search);
    const folder = query.get('folder') ?? '';
    const image = query.get('image');
    const layout = ['grid', 'single'].includes(query.get('view')) ? query.get('view') : 'strip';
    return {
        folder,
        size: imageSize(query.get('size')),
        layout,
        overview: layout === 'grid',
        recursive: layout === 'grid',
        compact: query.get('compact') === '1',
        filter: query.get('filter') || '',
        image: image === null ? null : resolveImage(folder, image),
        collection: query.get('collection') ?? folder,
        viewing: image !== null || query.get('viewer') === '1' || layout !== 'strip',
    };
}

export function stateUrl(next) {
    const query = new URLSearchParams();
    if (next.folder) query.set('folder', next.folder);
    if (next.compact) query.set('compact', '1');
    if (next.filter) query.set('filter', next.filter);
    if (next.viewing) {
        if (next.layout !== 'strip') query.set('view', next.layout);
        if (imageSize(next.size) !== 'page') query.set('size', imageSize(next.size));
        if (next.collection !== next.folder) query.set('collection', next.collection);
        if (next.image != null) query.set('image', relativePath(next.folder, next.image));
        else if (next.layout === 'strip') query.set('viewer', '1');
    }
    return query.size ? '/?' + query : '/';
}
