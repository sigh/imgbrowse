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
    return {
        folder,
        size: imageSize(query.get('size')),
        recursive: query.get('recursive') === '1',
        compact: query.get('compact') === '1',
        filter: query.get('filter') || '',
        image: image === null ? null : resolveImage(folder, image),
        collection: query.get('collection') ?? folder,
        viewing: image !== null || query.get('viewer') === '1',
    };
}

export function stateUrl(next) {
    const query = new URLSearchParams();
    if (next.folder) query.set('folder', next.folder);
    if (next.recursive) query.set('recursive', '1');
    if (next.compact) query.set('compact', '1');
    if (next.filter) query.set('filter', next.filter);
    if (next.viewing) {
        if (imageSize(next.size) !== 'page') query.set('size', imageSize(next.size));
        if (next.collection !== next.folder) query.set('collection', next.collection);
        if (next.image != null) query.set('image', relativePath(next.folder, next.image));
        else query.set('viewer', '1');
    }
    return query.size ? '/?' + query : '/';
}

/** The item representing an image in the chosen browsing scope. */
export function browseAnchor(folder, image, recursive) {
    if (!image || (folder && !image.startsWith(folder + '/'))) return null;
    const relative = folder ? image.slice(folder.length + 1) : image;
    return recursive ? image : joinPath(folder, relative.split('/')[0]);
}

/** Return a browse destination without changing the state held by either view. */
export function revealInBrowse(state, image) {
    const path = browseAnchor(state.folder, image, state.recursive);
    const hidden = path && !state.recursive
        && !filename(path).toLocaleLowerCase().includes(state.filter.toLocaleLowerCase());
    return {
        state: hidden ? {...state, filter: ''} : state,
        position: path ? {path, offset: 0, reveal: true} : null,
    };
}
