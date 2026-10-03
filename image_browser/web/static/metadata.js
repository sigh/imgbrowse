import {getMetadata, fullPath} from './api.js';
import {byId, element} from './dom.js';

let request;

function bytes(value) {
    if (value < 1024) return `${value} bytes`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let index = -1;
    do { value /= 1024; index++; } while (value >= 1024 && index < units.length - 1);
    return `${value.toLocaleString(undefined, {maximumFractionDigits: 2})} ${units[index]}`;
}

/** Unambiguous numeric date and 24-hour time, at minute precision. */
export function formatMetadataDate(value) {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    const pad = part => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

let context;
const popover = () => byId('metadata-popover');
export const metadataOpen = () => popover().matches(':popover-open');

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
export function updateMetadataTarget(path, button, container) {
    button.setAttribute('aria-expanded', 'false');
    if (!metadataOpen() || context?.container !== container) return;
    const changed = context.path !== path;
    context = {path, button, container};
    button.setAttribute('aria-expanded', 'true');
    positionMetadata();
    requestAnimationFrame(positionMetadata);
    if (changed) loadMetadata(path);
}

export function toggleMetadata(path, button, container) {
    if (metadataOpen() && context?.container === container) {
        closeMetadata(true);
        return;
    }
    closeMetadata();
    context = {path, button, container};
    button.setAttribute('aria-expanded', 'true');
    container.append(popover());
    popover().showPopover();
    popover().focus({preventScroll: true});
    positionMetadata();
    requestAnimationFrame(positionMetadata);
    loadMetadata(path);
}

window.addEventListener('resize', positionMetadata);
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !metadataOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMetadata(true);
}, true);
document.addEventListener('pointerdown', event => {
    if (!metadataOpen() || popover().contains(event.target) || context.button.contains(event.target)) return;
    // Reading controls stay available while inspecting consecutive images.
    if (event.target.closest('.copy-path, .viewer-nav, .viewer-strip')) return;
    closeMetadata();
});

async function loadMetadata(path) {
    const details = byId('metadata-details');
    const status = byId('metadata-status');
    request?.abort();
    const controller = request = new AbortController();
    if (status.contains(document.activeElement)) popover().focus({preventScroll: true});
    details.replaceChildren();
    byId('metadata-title').textContent = path.split('/').pop() || 'Folder info';
    status.textContent = 'Loading…';
    try {
        const data = await getMetadata(path, controller.signal);
        if (controller.signal.aborted) return;
        byId('metadata-title').textContent = data.name;
        const row = (label, value, className = '') => {
            if (value !== undefined && value !== null) details.append(element('dt', '', label), element('dd', className, String(value)));
        };
        if (data.width !== undefined) row('Dimensions', `${data.width} × ${data.height}`);
        if (data.size !== undefined) row('Size', bytes(data.size));
        row('Format', data.format);
        if (data.archive_size !== undefined) row('Archive size', bytes(data.archive_size));
        if (data.folders !== undefined) {
            row('Media', data.media);
            row('Folders', data.folders);
        }
        const exif = data.exif || {};
        row('Camera', [exif['Camera make'], exif['Camera model']].filter(Boolean).join(' ') || undefined);
        row('Taken', formatMetadataDate(exif.Taken));
        row(data.kind === 'directory' && data.archive_member ? 'Archive date' : 'Modified', formatMetadataDate(data.modified));
        for (const label of ['Artist', 'Copyright']) row(label, exif[label]);
        row(data.archive_member ? 'Member path' : data.kind === 'archive' ? 'Archive' : 'Path', fullPath(data), 'metadata-path');
        status.textContent = data.metadata_error ? 'Image details unavailable.' : '';
    } catch {
        if (controller.signal.aborted) return;
        const retry = element('button', '', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', () => loadMetadata(path));
        status.textContent = 'Unable to load info. ';
        status.append(retry);
    }
}
