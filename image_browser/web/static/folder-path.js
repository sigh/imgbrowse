import {joinPath, filename} from './state.js';
import {isVideo} from './media-kind.js';
import {getLocation, fullPath} from './api.js';
import {icon} from './icons.js';
import {element, setButtonLabel} from './dom.js';
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
export function renderItemHeader(location, actions, {folder, image = null, rootName, folderLink, currentLink = false, collection = null, compact = false}) {
    const name = location.querySelector('.item-name');
    name.hidden = !image;
    name.textContent = image ? filename(image) : '';
    name.title = image || '';
    const breadcrumbs = location.querySelector('.breadcrumbs');
    const changed = breadcrumbs.dataset.folder !== folder || breadcrumbs.dataset.image !== (image || '');
    const scrollLeft = breadcrumbs.scrollLeft;
    const context = JSON.stringify([folder, rootName, currentLink, collection, Boolean(image), compact]);
    if (breadcrumbs.dataset.context !== context) {
        renderFolderPath(breadcrumbs, folder, rootName, folderLink, {currentLink, collection, hasImage: Boolean(image)});
        if (image && folder !== collection) breadcrumbs.append(element('span', '', '/'));
        breadcrumbs.append(name);
        breadcrumbs.dataset.context = context;
    }
    breadcrumbs.dataset.image = image || '';
    if (image) breadcrumbs.scrollLeft = changed ? breadcrumbs.scrollWidth : scrollLeft;
    const target = image || folder;
    const kind = image ? (isVideo(image) ? 'video' : 'image') : 'folder';
    const holder = location.querySelector('.path-copy');
    let copy = holder.querySelector('.copy-path');
    if (!copy) copy = copyPathButton(holder);
    const label = `Copy ${kind} path`;
    if (copy.dataset.path !== target || copy.dataset.label !== label) {
        clearTimeout(copy.feedbackTimer);
        copy.dataset.path = target;
        copy.dataset.label = label;
        copy.replaceChildren(icon('copy'));
        holder.querySelector('.copy-feedback').textContent = '';
        setButtonLabel(copy, label);
    }
    renderItemActions(actions, target, kind);
}

/** Shared path presentation; the viewer keeps the current folder navigable. */
function renderFolderPath(container, folder, rootName, folderLink, {currentLink, collection, hasImage}) {
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
        if (index && parts[index - 1].path !== collection) container.append(element('span', '', '/'));
        const current = index === parts.length - 1;
        const node = current && !currentLink ? element('span', '', part.name) : folderLink(part.path, part.name);
        if (current) node.setAttribute('aria-current', 'page');
        if (part.path === (collection ?? folder)) {
            node.classList.add('selected-folder');
            node.title = collection === null ? 'Browsing folder' : 'Viewing folder: ' + (part.path || rootName);
        }
        if (part.path === collection) {
            const pinned = element('span', 'collection-breadcrumb');
            pinned.append(node);
            if (!current || hasImage) pinned.append(element('span', '', '/'));
            container.append(pinned);
        } else container.append(node);
        if (focused && node.getAttribute('href') === focused) node.focus({preventScroll: true});
    });
    container.scrollLeft = changed ? container.scrollWidth : scrollLeft;
}

/** Actions belong next to the item they describe. */
function renderItemActions(container, target, kind) {
    let info = container.querySelector('.item-info');
    if (!info) {
        info = element('button', 'item-info');
        info.type = 'button';
        info.setAttribute('aria-controls', 'metadata-popover');
        info.append(icon('info'));
        info.addEventListener('click', () => toggleMetadata(info.dataset.path, info, container));
        container.append(info);
    }
    info.dataset.path = target;
    setButtonLabel(info, `${kind[0].toUpperCase() + kind.slice(1)} info`);
    updateMetadataTarget(target, info, container);
}

/** Copy stays in the fixed slot immediately left of the displayed path. */
function copyPathButton(holder) {
    const copy = element('button', 'copy-path');
    copy.type = 'button';
    copy.append(icon('copy'));
    const feedback = element('span', 'copy-feedback');
    feedback.setAttribute('role', 'status');
    holder.append(copy, feedback);
    copy.addEventListener('click', async () => {
        const target = copy.dataset.path;
        feedback.textContent = '';
        clearTimeout(copy.feedbackTimer);
        copy.replaceChildren(icon('copy'));
        setButtonLabel(copy, copy.dataset.label);
        try {
            await copyPath(target);
            if (copy.dataset.path !== target) return;
            clearTimeout(copy.feedbackTimer);
            copy.replaceChildren(icon('check'));
            setButtonLabel(copy, 'Copied');
            copy.feedbackTimer = setTimeout(() => {
                copy.replaceChildren(icon('copy'));
                setButtonLabel(copy, copy.dataset.label);
            }, 1500);
        } catch {
            if (copy.dataset.path === target) {
                feedback.textContent = 'Copy failed. Try again.';
                setButtonLabel(copy, 'Copy failed. Try again.');
            }
        }
    });
    return copy;
}
