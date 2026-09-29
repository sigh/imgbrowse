import {joinPath} from './state.js';
import {getInfo} from './api.js';
import {icon} from './icons.js';

/** Small DOM helpers and explicit ownership of abortable work and blob URLs. */
export const byId = id => document.getElementById(id);

export function element(tag, className = '', text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

async function copyFolderPath(folder) {
    const {root_path: root} = await getInfo();
    const path = folder ? root.replace(/\/$/, '') + '/' + folder : root;
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

export class TaskScope {
    constructor() {
        this.controller = new AbortController();
        this.signal = this.controller.signal;
        this.cleanups = [];
    }

    onDispose(cleanup) {
        if (this.signal.aborted) cleanup();
        else this.cleanups.push(cleanup);
    }

    objectUrl(blob) {
        this.signal.throwIfAborted();
        const url = URL.createObjectURL(blob);
        this.onDispose(() => URL.revokeObjectURL(url));
        return url;
    }

    delay(callback, milliseconds) {
        const timer = setTimeout(callback, milliseconds);
        this.onDispose(() => clearTimeout(timer));
    }

    dispose() {
        this.controller.abort();
        this.cleanups.splice(0).forEach(cleanup => cleanup());
    }
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
    const copy = element('button', 'copy-path');
    copy.type = 'button';
    copy.title = 'Copy absolute folder path';
    copy.setAttribute('aria-label', copy.title);
    copy.append(icon('copy'));
    copy.addEventListener('click', async () => {
        try {
            await copyFolderPath(folder);
            copy.replaceChildren(icon('check'));
            copy.title = 'Copied';
            copy.setAttribute('aria-label', copy.title);
            setTimeout(() => {
                copy.replaceChildren(icon('copy'));
                copy.title = 'Copy absolute folder path';
                copy.setAttribute('aria-label', copy.title);
            }, 1500);
        } catch {
            copy.title = 'Unable to copy path. Click to retry.';
            copy.setAttribute('aria-label', copy.title);
        }
    });
    container.append(copy);
    container.scrollLeft = changed ? container.scrollWidth : scrollLeft;
}
