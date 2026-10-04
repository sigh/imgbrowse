import {joinPath, filename} from './state.js';

export const PathKind = Object.freeze({FOLDER:'folder', FILE:'file', GAP:'gap'});

/** Describe identity and navigation semantics without DOM nodes or measurements. */
export function folderPath({folder, image = null, rootName, currentLink = false, collection = null}) {
    const folders = [{path:'', label:rootName}];
    let path = '';
    for (const label of folder.split('/').filter(Boolean)) {
        path = joinPath(path, label);
        folders.push({path, label});
    }
    const items = folders.map((item, index) => {
        const current = index === folders.length - 1;
        return {...item, kind:PathKind.FOLDER, browsing:item.path === (collection ?? folder),
            link:!current || currentLink, current:current ? (image ? 'location' : 'page') : null};
    });
    if (image) items.push({kind:PathKind.FILE, path:image, label:filename(image), browsing:false, link:false, current:'page'});
    return items;
}

/** Collapse ancestors, then intermediate descendants; retain browsing and file identity. */
export function fitFolderPath(items, widths, {available, spacing, separator, gap}) {
    const shown = new Set(items);
    const measured = new Map(items.map((item, index) => [item, widths[index]]));
    const segments = () => {
        const result = [];
        let hidden = [];
        for (const item of items) {
            if (!shown.has(item)) { hidden.push(item); continue; }
            if (hidden.length) { result.push({kind:PathKind.GAP, items:hidden}); hidden = []; }
            result.push(item);
        }
        return result;
    };
    const width = parts => parts.reduce((total, item) => total + (item.kind === PathKind.GAP ? gap : measured.get(item)), 0)
        + Math.max(0, parts.length - 1) * (separator + 2 * spacing);
    let parts = segments();
    for (const item of items.filter(item => !item.browsing && item.kind !== PathKind.FILE)) {
        if (width(parts) <= available + 1) break;
        shown.delete(item);
        parts = segments();
    }
    // A single overflow control leaves room for both identities on small headers.
    if (width(parts) > available + 1 && parts.filter(item => item.kind === PathKind.GAP).length > 1) {
        parts = [{kind:PathKind.GAP, items:items.filter(item => !shown.has(item))}, ...items.filter(item => shown.has(item))];
    }
    return {parts, truncated:width(parts) > available + 1};
}
