import {joinPath, filename} from './state.js';
import {isVideo} from './media-kind.js';
import {setIconButton} from './icons.js';
import {element} from './dom.js';
import {toggleMetadata, updateMetadataTarget} from './metadata.js';

/** Shared identity and actions for Browse, reading, and folder overview. */
export function renderItemHeader(location, actions, {folder, image = null, rootName, folderLink, currentLink = false, collection = null, compact = false}) {
    const name = location.querySelector('.item-name');
    name.hidden = !image;
    name.textContent = image ? filename(image) : '';
    name.title = image || '';
    const breadcrumbs = location.querySelector('.breadcrumbs');
    const changed = breadcrumbs.dataset.folder !== folder || breadcrumbs.dataset.image !== (image || '');
    const scrollLeft = breadcrumbs.scrollLeft;
    // Layout belongs in link destinations even though it does not change the header's appearance.
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
        info.addEventListener('click', () => toggleMetadata(info.dataset.path, info));
        container.append(info);
    }
    info.dataset.path = target;
    setIconButton(info, 'info', `${kind[0].toUpperCase() + kind.slice(1)} info`);
    updateMetadataTarget(target, info);
}
