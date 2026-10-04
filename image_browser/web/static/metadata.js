import {getMetadata} from './api.js';
import {metadataInfo} from './metadata-data.js';
import {element} from './dom.js';
import {setIconButton} from './icons.js';

/** Selection and its path are immediate; only fetched facts have a loading state. */
export class MetadataPanel {
    constructor(section, openSidebar) {
        this.section = section;
        this.openSidebar = openSidebar;
        this.visible = false;
        this.pathText = section.querySelector('#metadata-path');
        this.copy = section.querySelector('#metadata-copy');
        this.details = section.querySelector('#metadata-details');
        this.facts = section.querySelector('#metadata-facts');
        this.status = section.querySelector('#metadata-status');
        this.message = section.querySelector('#metadata-message');
        this.retry = section.querySelector('#metadata-retry');
        this.resetCopy = copyPathControl(this.copy, section.querySelector('#metadata-copy-feedback'), () => this.fullPath);
        this.retry.addEventListener('click', () => this.refresh());
        section.addEventListener('toggle', () => this.sync());
    }

    setRoot(root) {
        if (root === this.root) return;
        this.root = root;
        this.updatePath();
    }

    update({folder, image = null}) {
        const selected = image || folder;
        if (selected === this.selected) return;
        this.selected = selected;
        this.setPath(selected);
    }

    setPath(path) {
        if (path !== this.path) {
            this.path = path;
            this.loadedPath = undefined;
            this.request?.abort();
            this.updatePath();
            this.details.classList.add('loading');
        }
        this.sync();
    }

    updatePath() {
        this.fullPath = this.root === undefined ? this.path || ''
            : this.path ? this.root.replace(/\/$/, '') + '/' + this.path : this.root;
        this.pathText.textContent = this.fullPath;
        this.copy.disabled = this.root === undefined;
        this.resetCopy();
    }

    setVisible(visible) {
        this.visible = visible;
        this.sync();
    }

    show(path) {
        this.setPath(path);
        this.openSidebar();
        this.section.open = true;
        this.sync();
    }

    sync() {
        if (!this.visible || !this.section.open) {
            this.request?.abort();
            return;
        }
        if (this.loadedPath === this.path || this.request && !this.request.signal.aborted && this.requestPath === this.path) return;
        this.load();
    }

    refresh() {
        this.loadedPath = undefined;
        this.request?.abort();
        this.sync();
    }

    async load() {
        const path = this.requestPath = this.path;
        const controller = this.request = new AbortController();
        this.details.classList.add('loading');
        try {
            const data = await getMetadata(path, controller.signal, data => this.render(data));
            if (controller.signal.aborted) return;
            this.render(data);
            this.loadedPath = path;
        } catch {
            if (controller.signal.aborted) return;
            this.facts.replaceChildren();
            this.facts.hidden = true;
            this.message.textContent = 'Unable to load info.';
            this.status.hidden = false;
            this.retry.hidden = false;
            this.details.classList.remove('loading');
        } finally {
            if (this.request === controller) this.request = null;
        }
    }

    render(data) {
        this.setRoot(data.root_path);
        const info = metadataInfo(data);
        this.facts.replaceChildren(...info.facts.flatMap(row => [element('dt', '', row.label), renderAttribute(row)]));
        this.facts.hidden = info.facts.length === 0;
        this.message.textContent = info.status;
        this.status.hidden = !info.status;
        this.retry.hidden = !data.video_error;
        this.details.classList.remove('loading');
    }
}

function renderAttribute({value, datetime, age, href}) {
    const content = element('dd');
    if (datetime) {
        content.className = 'metadata-date';
        const date = element('time', '', value);
        date.dateTime = datetime;
        content.append(date);
        if (age) date.title = age;
    } else if (href) {
        const link = element('a', '', value);
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        content.append(link);
    } else content.textContent = value;
    return content;
}

async function copyPath(path) {
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

/** A permanent copy control reads the current path, independent of metadata requests. */
function copyPathControl(copy, feedback, getPath) {
    let feedbackTimer;
    const reset = () => {
        clearTimeout(feedbackTimer);
        feedback.textContent = '';
        setIconButton(copy, 'copy', 'Copy full path');
    };
    reset();
    copy.addEventListener('click', async () => {
        const path = getPath();
        reset();
        try {
            await copyPath(path);
            if (path !== getPath()) return;
            setIconButton(copy, 'check', 'Copied');
            feedbackTimer = setTimeout(reset, 1500);
        } catch {
            if (path === getPath()) feedback.textContent = 'Copy failed. Try again.';
        }
    });
    return reset;
}
