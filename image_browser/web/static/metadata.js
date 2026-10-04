import {getMetadata, getVideoInfo} from './api.js';
import {metadataInfo, MetadataKind} from './metadata-data.js';
import {byId, element} from './dom.js';
import {filename} from './state.js';
import {setIconButton} from './icons.js';

let request;
let context;
const popover = () => byId('metadata-popover');
const metadataOpen = () => popover().matches(':popover-open');

export function closeMetadata(restoreFocus = false) {
    if (!metadataOpen()) return;
    popover().hidePopover();
    request?.abort();
    context?.button.setAttribute('aria-expanded', 'false');
    if (restoreFocus && context?.button.isConnected) context.button.focus({preventScroll: true});
    context = null;
}

function positionMetadata() {
    if (!metadataOpen() || !context?.button.isConnected) return;
    const panel = popover();
    const anchor = context.button.getBoundingClientRect();
    const header = context.button.closest('.app-header').getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 12));
    const top = Math.min(Math.max(anchor.bottom, header.bottom) + 8, innerHeight - 60);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(48, innerHeight - top - 12)}px`;
}

// Keep an open panel in sync with the persistent header action.
export function updateMetadataTarget(path, button) {
    button.setAttribute('aria-expanded', 'false');
    if (!metadataOpen() || context?.button !== button) return;
    const changed = context.path !== path;
    context = {path, button};
    button.setAttribute('aria-expanded', 'true');
    positionMetadata();
    requestAnimationFrame(positionMetadata);
    if (changed) loadMetadata(path);
}

export function toggleMetadata(path, button) {
    if (metadataOpen() && context?.button === button) {
        closeMetadata(true);
        return;
    }
    closeMetadata();
    context = {path, button};
    button.setAttribute('aria-expanded', 'true');
    button.parentElement.append(popover());
    popover().showPopover();
    popover().focus({preventScroll: true});
    positionMetadata();
    requestAnimationFrame(positionMetadata);
    loadMetadata(path);
}

window.addEventListener('resize', positionMetadata);
byId('metadata-close').addEventListener('click', () => closeMetadata(true));
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !metadataOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMetadata(true);
}, true);
document.addEventListener('pointerdown', event => {
    if (!metadataOpen() || popover().contains(event.target) || context.button.contains(event.target)) return;
    // Reading controls stay available while inspecting consecutive images.
    if (event.target.closest('.viewer-nav, .viewer-strip')) return;
    closeMetadata();
});

async function loadMetadata(path) {
    const details = byId('metadata-details');
    const status = byId('metadata-status');
    request?.abort();
    const controller = request = new AbortController();
    if (status.contains(document.activeElement)) popover().focus({preventScroll: true});
    details.replaceChildren();
    byId('metadata-title').textContent = filename(path) || 'Folder info';
    status.textContent = 'Loading…';
    try {
        const data = await getMetadata(path, controller.signal);
        if (controller.signal.aborted) return;
        const summary = renderMetadata(metadataInfo(data));
        if (data.kind === MetadataKind.VIDEO) {
            getVideoInfo(path, controller.signal).then(video => {
                if (!controller.signal.aborted) renderSummary(summary, metadataInfo({...data, duration:video.duration}).summary);
            }).catch(() => {});
        }
    } catch {
        if (controller.signal.aborted) return;
        const retry = element('button', '', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', () => loadMetadata(path));
        status.textContent = 'Unable to load info. ';
        status.append(retry);
    }
}

function renderSummary(container, facts) {
    container.replaceChildren();
    container.hidden = facts.length === 0;
    for (const {label, value} of facts) {
        const group = element('div');
        group.append(element('dt', 'visually-hidden', label), element('dd', '', value));
        container.append(group);
    }
}

/** Presentation consumes prepared values; it does not interpret API metadata. */
function renderMetadata(info) {
    byId('metadata-title').textContent = info.name;
    const path = element('section', 'metadata-path');
    const heading = element('div', 'metadata-path-heading', info.pathLabel);
    const copy = copyPathControl(info.path);
    heading.append(copy.button);
    path.append(heading, element('div', 'metadata-path-text', info.path), copy.feedback);
    const summary = element('dl', 'metadata-summary');
    renderSummary(summary, info.summary);
    const attributes = element('dl', 'metadata-attributes');
    for (const row of info.rows) attributes.append(element('dt', '', row.label), renderAttribute(row));
    attributes.hidden = attributes.childElementCount === 0;
    byId('metadata-details').replaceChildren(path, summary, attributes);
    byId('metadata-status').textContent = info.status;
    return summary;
}

function renderAttribute({value, datetime, age, href}) {
    const content = element('dd');
    if (datetime) {
        content.className = 'metadata-date';
        const date = element('time', '', value);
        date.dateTime = datetime;
        content.append(date);
        if (age) content.append(element('span', 'metadata-age', `(${age})`));
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

/** Copy the full path displayed in Info, including archive member identity. */
function copyPathControl(path) {
    const copy = element('button', 'copy-path');
    copy.type = 'button';
    const feedback = element('span', 'copy-feedback');
    feedback.setAttribute('role', 'status');
    let feedbackTimer;
    const reset = () => {
        feedback.textContent = '';
        setIconButton(copy, 'copy', 'Copy full path');
    };
    reset();
    copy.addEventListener('click', async () => {
        clearTimeout(feedbackTimer);
        reset();
        try {
            await copyPath(path);
            if (!copy.isConnected) return;
            clearTimeout(feedbackTimer);
            setIconButton(copy, 'check', 'Copied');
            feedbackTimer = setTimeout(reset, 1500);
        } catch {
            if (copy.isConnected) {
                feedback.textContent = 'Copy failed. Try again.';
                setIconButton(copy, 'copy', feedback.textContent);
            }
        }
    });
    return {button:copy, feedback};
}
