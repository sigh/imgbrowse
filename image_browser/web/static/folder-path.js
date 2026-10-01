import {joinPath, filename} from './state.js';
import {isVideo} from './media-kind.js';
import {getLocation, fullPath} from './api.js';
import {icon} from './icons.js';
import {element} from './dom.js';
import {toggleMetadata, updateMetadataTarget} from './metadata.js';

async function copyPath(target) {
    const location = await getLocation(target);
    const path = fullPath(location);
    if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(path); return; } catch { /* Try the local HTTP fallback. */ }
    }
    // Clipboard API is unavailable over plain HTTP on the local network.
    const input = element('textarea', 'clipboard-input');
    input.value = path;
    const focused = document.activeElement;
    document.body.append(input);
    input.select();
    try {
        if (!document.execCommand('copy')) throw new Error('Copy failed');
    } finally {
        input.remove();
        focused?.focus({preventScroll: true});
    }
}

/** Shared identity and actions for Browse, reading, and folder overview. */
export function renderItemHeader(location, actions, {folder, image = null, rootName, folderLink, currentLink = false, browseFolder = folder}) {
    const name = location.querySelector('.item-name');
    name.hidden = !image;
    name.textContent = image ? filename(image) : '';
    name.title = image || '';
    const breadcrumbs = location.querySelector('.breadcrumbs');
    const changed = breadcrumbs.dataset.folder !== folder || breadcrumbs.dataset.image !== (image || '');
    const scrollLeft = breadcrumbs.scrollLeft;
    renderFolderPath(breadcrumbs, folder, rootName, folderLink, {currentLink, browseFolder});
    breadcrumbs.dataset.image = image || '';
    if (image) breadcrumbs.append(element('span', '', '/'));
    breadcrumbs.append(name);
    if (image) breadcrumbs.scrollLeft = changed ? breadcrumbs.scrollWidth : scrollLeft;
    const target = image || folder;
    const kind = image ? (isVideo(image) ? 'video' : 'image') : 'folder';
    const holder = location.querySelector('.path-copy');
    const focused = holder.contains(document.activeElement);
    const copy = copyPathButton(target, kind);
    holder.replaceChildren(copy);
    if (focused) copy.focus({preventScroll: true});
    renderItemActions(actions, target, kind);
}

/** Shared path presentation; the viewer keeps the current folder navigable. */
export function renderFolderPath(container, folder, rootName, folderLink, {currentLink = false, browseFolder = folder} = {}) {
    const focused = container.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
    const changed = container.dataset.folder !== folder;
    const scrollLeft = container.scrollLeft;
    container.dataset.folder = folder;
    container.tabIndex = 0;
    container.onkeydown = event => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) event.stopPropagation();
    };
    const parts = [{path: '', name: rootName}];
    let path = '';
    for (const name of folder.split('/').filter(Boolean)) {
        path = joinPath(path, name);
        parts.push({path, name});
    }
    container.replaceChildren();
    parts.forEach((part, index) => {
        if (index) container.append(element('span', '', '/'));
        const current = index === parts.length - 1;
        const node = current && !currentLink ? element('span', '', part.name) : folderLink(part.path, part.name);
        if (current) node.setAttribute('aria-current', 'page');
        if (part.path === browseFolder) {
            node.classList.add('browsing-folder');
            node.title = 'Browsing folder';
        }
        container.append(node);
        if (focused && node.getAttribute('href') === focused) node.focus({preventScroll: true});
    });
    container.scrollLeft = changed ? container.scrollWidth : scrollLeft;
}

/** Actions belong next to the item they describe. */
export function renderItemActions(container, target, kind) {
    const focused = container.contains(document.activeElement) ? document.activeElement.className : null;
    container.replaceChildren();
    const info = element('button', 'item-info');
    info.type = 'button';
    info.title = `${kind[0].toUpperCase() + kind.slice(1)} info`;
    info.setAttribute('aria-label', info.title);
    info.setAttribute('aria-controls', 'metadata-popover');
    info.append(icon('info'));
    info.addEventListener('click', () => toggleMetadata(target, info, container));
    container.append(info);
    updateMetadataTarget(target, info, container);
    if (focused === info.className) info.focus({preventScroll: true});
}

/** Copy stays in the fixed slot immediately left of the displayed path. */
function copyPathButton(target, kind) {
    const copy = element('button', 'copy-path');
    copy.type = 'button';
    copy.title = `Copy ${kind} path`;
    copy.setAttribute('aria-label', copy.title);
    copy.append(icon('copy'));
    copy.addEventListener('click', async () => {
        try {
            await copyPath(target);
            copy.querySelector('.icon').replaceWith(icon('check'));
            copy.title = 'Copied';
            copy.setAttribute('aria-label', copy.title);
            setTimeout(() => {
                copy.querySelector('.icon').replaceWith(icon('copy'));
                copy.title = `Copy ${kind} path`;
                copy.setAttribute('aria-label', copy.title);
            }, 1500);
        } catch {
            copy.title = 'Unable to copy path. Click to retry.';
            copy.setAttribute('aria-label', copy.title);
        }
    });
    return copy;
}
