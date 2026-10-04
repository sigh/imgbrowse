/** URL state is the source of truth for folder and viewer navigation. */
export const ScreenMode = Object.freeze({BROWSE: 'browse', OVERVIEW: 'overview', VIEW: 'view'});
export const ReadingLayout = Object.freeze({STRIP: 'strip', SINGLE: 'single', SCROLL: 'scroll'});
export const FolderLayout = Object.freeze({PREVIEWS: 'previews', LIST: 'list'});
export const ImageSize = Object.freeze({DEFAULT: 'auto', ORIGINAL: '1'});
export const ViewerEntry = Object.freeze({TOP: 'top', BOTTOM: 'bottom', KEEP: 'keep'});
export const ItemType = Object.freeze({FOLDER: 'folder', MEDIA: 'image'});

export const joinPath = (parent, name) => parent ? parent + '/' + name : name;
export const parentPath = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const filename = path => path.split('/').pop();
export const currentFolder = state => state.mode === ScreenMode.BROWSE ? state.folder : state.collection;

/** Display a path relative to its browsing folder; that folder itself is empty. */
export function relativePath(base, path) {
    const from = base.split('/').filter(Boolean);
    const to = path.split('/').filter(Boolean);
    let shared = 0;
    while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
    return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
}

export const ZOOM = Object.freeze({MIN: .01, MAX: 8, STEP: 1.25});
export const imageSize = value => Number.isFinite(Number(value)) && Number(value) >= ZOOM.MIN && Number(value) <= ZOOM.MAX
    ? String(Number(value)) : ImageSize.DEFAULT;
export const readingLayout = value => Object.values(ReadingLayout).includes(value) ? value : ReadingLayout.STRIP;

const OVERVIEW_QUERY_VALUE = 'grid';

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
    const view = query.get('view');
    return {
        folder,
        size: imageSize(query.get('size')),
        mode: view === OVERVIEW_QUERY_VALUE ? ScreenMode.OVERVIEW
            : image !== null || query.get('viewer') === '1' || [ReadingLayout.SINGLE, ReadingLayout.SCROLL].includes(view) ? ScreenMode.VIEW : ScreenMode.BROWSE,
        layout: view === ReadingLayout.SCROLL || query.get('size') === 'width' ? ReadingLayout.SCROLL : readingLayout(view),
        compact: query.get('compact') === '1',
        filter: query.get('filter') || '',
        image: image === null ? null : resolveImage(folder, image),
        collection: query.get('collection') ?? folder,
    };
}

export function stateUrl(next) {
    const query = new URLSearchParams();
    if (next.folder) query.set('folder', next.folder);
    if (next.compact) query.set('compact', '1');
    if (next.filter) query.set('filter', next.filter);
    if (next.mode !== ScreenMode.BROWSE) {
        if (next.mode === ScreenMode.OVERVIEW) query.set('view', OVERVIEW_QUERY_VALUE);
        else if (next.layout !== ReadingLayout.STRIP) query.set('view', next.layout);
        if (imageSize(next.size) !== ImageSize.DEFAULT) query.set('size', imageSize(next.size));
        if (next.collection !== next.folder) query.set('collection', next.collection);
        if (next.image != null) query.set('image', relativePath(next.folder, next.image));
        else if (next.mode === ScreenMode.VIEW && next.layout === ReadingLayout.STRIP) query.set('viewer', '1');
    }
    return query.size ? '/?' + query : '/';
}
