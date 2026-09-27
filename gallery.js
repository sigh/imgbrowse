'use strict';

const $ = id => document.getElementById(id);
const viewport = $('grid-viewport');
const grid = $('grid');
const viewer = $('viewer');
const joinPath = (parent, name) => parent ? parent + '/' + name : name;
const parentPath = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const filename = path => path.split('/').pop();
const imageUrl = (path, thumbnail = false) => (thumbnail ? '/thumbnail?' : '/image?') + new URLSearchParams({path});
let state;
let rootName = 'Collection';
let gridKey = null;
let gridController;
let viewerController;
let moveController;
let viewerKey = null;
let items = [];
let rows = [];
let rowNodes = new Map();
let gridCursor = null;
let gridDone = true;
let gridLoading = false;
let gridFailed = false;
let columns = 1;
let gridWidth = 0;
let collectionWarning = '';
let wrapDirection = null;
let stripCleanup = [];
let previousFocus = null;
let nearbyImages = [];
let nearbyCollection = null;
let wrapPending = false;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function readState() {
    const query = new URLSearchParams(location.search);
    const legacyFolder = query.get('category') ?? query.get('m');
    const folder = query.get('folder') ?? legacyFolder ?? '';
    let image = query.get('image') ?? query.get('img');
    if (legacyFolder !== null && !query.has('folder') && image !== null) {
        // Older versions stored an already URL-encoded image path in the query.
        try { image = decodeURIComponent(image); } catch { /* Leave malformed links readable. */ }
    }
    return {
        folder,
        recursive: query.get('recursive') === '1',
        filter: query.get('filter') || '',
        image,
        collection: query.get('collection') ?? folder,
        viewing: image !== null || query.get('viewer') === '1',
    };
}

function stateUrl(next) {
    const query = new URLSearchParams({folder: next.folder, sort: 'natural'});
    if (next.recursive) query.set('recursive', '1');
    if (next.filter) query.set('filter', next.filter);
    if (next.viewing) {
        if (next.collection !== next.folder) query.set('collection', next.collection);
        if (next.image != null) query.set('image', next.image);
        else query.set('viewer', '1');
    }
    return '/?' + query;
}

function navigate(changes, replace = false) {
    clearTimeout(filterTimer);
    history[replace ? 'replaceState' : 'pushState'](null, '', stateUrl({...state, ...changes}));
    render();
}

async function api(url, signal, data) {
    const response = await fetch(url, {
        signal,
        ...(data === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to load this folder');
    return result;
}

// Schedule complete card previews, rather than putting a discovered image at the
// back of the queue behind lower cards. Recompute priorities after each scroll.
const jobs = [];
let runningJobs = 0;
let pumpScheduled = false;
function enqueue(work, signal, target) {
    return new Promise((resolve, reject) => {
        jobs.push({work, signal, target, resolve, reject});
        if (!pumpScheduled) {
            pumpScheduled = true;
            queueMicrotask(() => { pumpScheduled = false; pumpJobs(); });
        }
    });
}
function previewPriority(target) {
    if (!target.isConnected) return Infinity;
    const rect = target.getBoundingClientRect();
    if (viewer.contains(target)) {
        if (!state.viewing) return Infinity;
        return Math.abs((rect.left + rect.right) / 2 - viewer.clientWidth / 2);
    }
    if (state.viewing) return Infinity;
    const bounds = viewport.getBoundingClientRect();
    const visible = rect.bottom > bounds.top && rect.top < bounds.bottom;
    return (visible ? 0 : 1e9) + (visible ? Math.max(0, rect.top - bounds.top) : Math.abs(rect.top - bounds.top)) * 1000 + rect.left;
}
function pumpJobs() {
    for (let index = jobs.length - 1; index >= 0; index--) {
        if (jobs[index].signal.aborted) jobs.splice(index, 1)[0].reject(new DOMException('Aborted', 'AbortError'));
    }
    jobs.sort((a, b) => previewPriority(a.target) - previewPriority(b.target));
    while (runningJobs < 8 && jobs.length && Number.isFinite(previewPriority(jobs[0].target))) {
        const job = jobs.shift();
        runningJobs++;
        Promise.resolve().then(() => {
            job.signal.throwIfAborted();
            return job.work();
        }).then(job.resolve, job.reject).finally(() => { runningJobs--; pumpJobs(); });
    }
}

async function loadThumbnail(container, path, signal, cleanup) {
    const response = await fetch(imageUrl(path, true), {signal});
    if (!response.ok) throw new Error('Preview unavailable');
    const blob = await response.blob();
    signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    cleanup.push(() => URL.revokeObjectURL(url));
    const image = element('img');
    image.alt = '';
    image.src = url;
    container.replaceChildren(image);
}
function attachThumbnail(container, path, signal, cleanup) {
    return enqueue(() => loadThumbnail(container, path, signal, cleanup), signal, container);
}

async function folderPreview(container, path, signal, cleanup) {
    try {
        await enqueue(async () => {
            let result;
            do {
                result = await api('/api/preview?' + new URLSearchParams({path}), signal);
                path = result.continue;
            } while (path !== undefined);
            if (result.image) await loadThumbnail(container, result.image, signal, cleanup);
            else container.textContent = 'Folder';
        }, signal, container);
    } catch (error) {
        if (error.name !== 'AbortError') container.textContent = 'Preview unavailable';
    }
}

function folderLink(path, label) {
    const link = element('a', '', label);
    link.href = stateUrl({...state, folder: path, viewing: false, image: null, filter: ''});
    link.addEventListener('click', event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate({folder: path, viewing: false, image: null, filter: ''});
    });
    return link;
}

function renderBreadcrumbs() {
    const breadcrumbs = $('breadcrumbs');
    breadcrumbs.replaceChildren(folderLink('', rootName));
    let path = '';
    for (const name of state.folder.split('/').filter(Boolean)) {
        path = joinPath(path, name);
        breadcrumbs.append(element('span', '', '/'), folderLink(path, name));
    }
}

function card(item, signal, cleanup) {
    const node = element('article', 'card');
    const picture = item.type === 'folder' ? folderLink(item.path, 'Folder') : element('button', '', 'Loading…');
    picture.className = 'picture';
    picture.setAttribute('aria-label', (item.type === 'folder' ? 'Open folder ' : 'View image ') + filename(item.path));
    const caption = element('div', 'card-caption');
    if (item.type === 'folder') {
        const read = element('button', '', 'View ▶');
        read.title = 'View all images in ' + filename(item.path);
        read.addEventListener('click', () => openViewer(null, item.path));
        caption.append(folderLink(item.path, filename(item.path)), read);
        folderPreview(picture, item.path, signal, cleanup);
    } else {
        picture.addEventListener('click', () => openViewer(item.path, state.folder));
        caption.append(element('span', '', filename(item.path)));
        attachThumbnail(picture, item.path, signal, cleanup).catch(error => {
            if (error.name !== 'AbortError') picture.textContent = 'Preview unavailable';
        });
    }
    caption.title = item.path;
    node.append(picture, caption);
    return node;
}

function clearRows() {
    for (const {node, controller, cleanup} of rowNodes.values()) {
        controller.abort();
        cleanup.forEach(fn => fn());
        node.remove();
    }
    rowNodes.clear();
    pumpJobs();
}

function layoutRows() {
    clearRows();
    gridWidth = viewport.clientWidth;
    columns = Math.max(1, Math.floor(viewport.clientWidth / 220));
    rows = [];
    appendRows(items);
}

const labelMeasure = document.createElement('canvas').getContext('2d');
const labelFontFamily = getComputedStyle(document.body).fontFamily;
function labelHeight(text, width, fontSize = 13.44) {
    labelMeasure.font = fontSize + 'px ' + labelFontFamily;
    width = Math.max(1, width);
    const space = labelMeasure.measureText(' ').width;
    let lines = 1;
    let used = 0;
    for (const word of text.split(/\s+/)) {
        const wordWidth = labelMeasure.measureText(word).width;
        if (used && used + space + wordWidth > width) {
            lines++;
            used = 0;
        }
        if (wordWidth > width) {
            lines += Math.ceil(wordWidth / width) - 1;
            used = wordWidth % width || width;
        } else {
            used += (used ? space : 0) + wordWidth;
        }
    }
    return (lines > 1 ? lines + 1 : lines) * 20;
}

function appendRows(addedItems) {
    const last = rows.at(-1);
    let top = last ? last.top + last.height : 0;
    let current = last?.items ? last : null;
    let previousFolder = current ? parentPath(current.items.at(-1).path) : null;
    const cardWidth = (viewport.clientWidth - 36 - (columns - 1) * 12) / columns;
    // Only the last row can change when the next page arrives.
    const existing = rowNodes.get(rows.length - 1);
    if (existing && current && current.items.length < columns) {
        existing.controller.abort();
        existing.cleanup.forEach(fn => fn());
        existing.node.remove();
        rowNodes.delete(rows.length - 1);
    }
    for (const item of addedItems) {
        const folder = parentPath(item.path);
        if (state.recursive && folder !== previousFolder) {
            current = null;
            const label = folder || rootName;
            const height = Math.max(42, labelHeight(label, viewport.clientWidth - 36, 14.4) + 16);
            rows.push({top, height, label});
            top += height;
            previousFolder = folder;
        }
        if (!current || current.items.length === columns) {
            current = {top, height: 230, items: []};
            rows.push(current);
            top += 230;
        }
        current.items.push(item);
        const height = Math.max(current.height,
            190 + labelHeight(filename(item.path), cardWidth - 18) + (item.type === 'folder' ? 34 : 0));
        top += height - current.height;
        current.height = height;
    }
    grid.style.height = top + 'px';
    renderRows();
}

function renderRows() {
    const start = Math.max(0, viewport.scrollTop - 230);
    const end = viewport.scrollTop + viewport.clientHeight + 230;
    // Binary search keeps scrolling independent of the number of discovered rows.
    let low = 0, high = rows.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (rows[mid].top + rows[mid].height < start) low = mid + 1;
        else high = mid;
    }
    const visible = new Set();
    for (let index = low; index < rows.length && rows[index].top < end; index++) {
        visible.add(index);
        if (rowNodes.has(index)) continue;
        const row = rows[index];
        const node = element('div', 'grid-row');
        node.style.top = row.top + 'px';
        node.style.height = row.height + 'px';
        node.style.gridTemplateColumns = row.items ? 'repeat(' + columns + ', minmax(0, 1fr))' : '1fr';
        const controller = new AbortController();
        const cleanup = [];
        if (row.items) row.items.forEach(item => node.append(card(item, controller.signal, cleanup)));
        else node.append(element('h2', 'folder-heading', row.label));
        grid.append(node);
        rowNodes.set(index, {node, controller, cleanup});
    }
    for (const [index, entry] of rowNodes) {
        if (!visible.has(index)) {
            entry.controller.abort();
            entry.cleanup.forEach(fn => fn());
            entry.node.remove();
            rowNodes.delete(index);
        }
    }
    pumpJobs();
    if (!gridDone && !gridLoading && !gridFailed && !state.viewing && end >= grid.offsetHeight - 400) loadRecursivePage();
}

async function loadRecursivePage() {
    if (gridLoading || gridDone) return;
    gridLoading = true;
    gridFailed = false;
    $('load-more').hidden = true;
    $('grid-status').textContent = 'Finding images…';
    const controller = gridController;
    try {
        const result = await api('/api/walk', controller.signal, {root: state.folder, cursor: gridCursor});
        controller.signal.throwIfAborted();
        const addedItems = result.images.map(path => ({type: 'image', path}));
        items.push(...addedItems);
        gridCursor = result.cursor;
        gridDone = result.cursor === null;
        if (result.warnings.length) collectionWarning = 'Some folders could not be read.';
        appendRows(addedItems);
        $('summary').textContent = items.length + (gridDone ? ' images' : ' images discovered') + (collectionWarning ? ' · ' + collectionWarning : '');
        $('grid-status').textContent = gridDone ? (items.length ? 'End of folder' : 'No images found.') : '';
    } catch (error) {
        if (error.name !== 'AbortError') {
            gridFailed = true;
            $('grid-status').textContent = error.message;
            $('load-more').hidden = false;
        }
    } finally {
        if (controller === gridController) {
            gridLoading = false;
            if (!gridFailed) requestAnimationFrame(renderRows);
        }
    }
}

async function loadGrid() {
    gridController?.abort();
    gridController = new AbortController();
    const controller = gridController;
    clearRows();
    items = [];
    rows = [];
    grid.style.height = '0px';
    viewport.scrollTop = 0;
    gridLoading = false;
    gridFailed = false;
    collectionWarning = '';
    gridDone = true;
    gridCursor = null;
    $('grid-status').textContent = 'Opening folder…';
    $('summary').textContent = '';
    $('load-more').hidden = true;
    try {
        const listing = await api('/api/folder?' + new URLSearchParams({path: state.folder}), controller.signal);
        controller.signal.throwIfAborted();
        rootName = listing.root_name || 'Collection';
        document.title = (filename(state.folder) || rootName) + ' · Image Browser';
        renderBreadcrumbs();
        if (state.recursive) {
            gridDone = false;
            // A bookmarked image opens directly; defer background grid traversal.
            if (!state.viewing) loadRecursivePage();
            else $('grid-status').textContent = '';
        } else {
            const filter = state.filter.toLocaleLowerCase();
            items = [
                ...listing.folders.map(name => ({type: 'folder', path: joinPath(state.folder, name)})),
                ...listing.images.map(name => ({type: 'image', path: joinPath(state.folder, name)})),
            ].filter(item => filename(item.path).toLocaleLowerCase().includes(filter));
            layoutRows();
            $('grid-status').textContent = items.length ? '' : (filter ? 'No matching names.' : 'This folder is empty of visible folders and supported images.');
            $('summary').textContent = listing.folders.length + ' folders · ' + listing.images.length + ' direct images' + (filter ? ' · ' + items.length + ' matches' : '');
        }
    } catch (error) {
        if (error.name !== 'AbortError') $('grid-status').textContent = error.message + ' — use Refresh to try again.';
    }
}

function openViewer(image, collection) {
    navigate({viewing: true, image, collection});
}
function closeViewer() {
    navigate({viewing: false, image: null});
}
function setViewerBusy(busy) {
    viewer.setAttribute('aria-busy', String(busy));
}
function clearStrip() {
    stripCleanup.forEach(fn => fn());
    stripCleanup = [];
    $('viewer-strip').replaceChildren();
}

async function loadStrip(image, collection, controller) {
    const request = reverse => api('/api/walk', controller.signal, {root: collection, anchor: image, reverse, limit: 4});
    try {
        const [before, after] = await Promise.all([request(true), request(false)]);
        controller.signal.throwIfAborted();
        const paths = [...before.images.reverse(), image, ...after.images];
        nearbyImages = paths;
        nearbyCollection = collection;
        for (const path of paths) {
            const button = element('button', path === image ? 'selected' : '');
            button.title = path;
            button.setAttribute('aria-label', 'View ' + filename(path));
            button.addEventListener('click', () => navigate({image: path}, true));
            $('viewer-strip').append(button);
            attachThumbnail(button, path, controller.signal, stripCleanup).catch(() => {});
        }
        $('viewer-strip').querySelector('.selected')?.scrollIntoView({block: 'nearest', inline: 'center'});
    } catch (error) {
        if (error.name !== 'AbortError') $('viewer-status').textContent = 'Nearby previews unavailable. ' + error.message;
    }
}

async function moveImage(reverse = false, wrap = false) {
    if (moveController || !state.viewing) return;
    if (!wrap && nearbyCollection === state.collection) {
        const index = nearbyImages.indexOf(state.image);
        const neighbor = index >= 0 ? nearbyImages[index + (reverse ? -1 : 1)] : null;
        if (neighbor) {
            navigate({image: neighbor}, true);
            return;
        }
    }
    const controller = new AbortController();
    moveController = controller;
    setViewerBusy(true);
    $('viewer-wrap').hidden = true;
    $('viewer-status').textContent = '';
    // Ordinary navigation stays quiet. Only a genuinely slow operation gets feedback.
    const loadingTimer = setTimeout(() => {
        if (moveController === controller) $('viewer-status').textContent = 'Loading…';
    }, 700);
    const collection = state.collection;
    const anchor = wrap ? null : state.image;
    let cursor = null;
    let warning = false;
    try {
        do {
            const result = await api('/api/walk', controller.signal, {root: collection, anchor, reverse, cursor, limit: 1});
            warning ||= result.warnings.length > 0;
            if (result.images.length) {
                navigate({image: result.images[0]}, true);
                return;
            }
            cursor = result.cursor;
        } while (cursor !== null);
        if (!state.image) {
            $('viewer-status').textContent = warning ? 'No accessible images found; some folders could not be read.' : 'No images in this folder.';
        } else {
            $('viewer-status').textContent = (reverse ? 'Beginning of folder.' : 'End of folder.') +
                ' Press again or start a new scroll to wrap.' + (warning ? ' Some folders could not be read.' : '');
            wrapDirection = reverse;
            wrapPending = true;
            $('viewer-wrap').textContent = reverse ? 'Go to last image' : 'Go to first image';
            $('viewer-wrap').hidden = false;
        }
    } catch (error) {
        if (error.name !== 'AbortError') $('viewer-status').textContent = error.message;
    } finally {
        clearTimeout(loadingTimer);
        if (moveController === controller) {
            moveController = null;
            setViewerBusy(false);
        }
    }
}

function requestMove(reverse, freshGesture = true) {
    if (moveController || !state.viewing) return;
    if (wrapPending && reverse === wrapDirection) {
        if (!freshGesture) return;
        wrapPending = false;
        moveImage(reverse, true);
    } else {
        wrapPending = false;
        moveImage(reverse);
    }
}

function renderViewer() {
    const key = JSON.stringify([state.viewing, state.collection, state.image]);
    if (key === viewerKey) return;
    viewerKey = key;
    viewerController?.abort();
    moveController?.abort();
    moveController = null;
    viewerController = new AbortController();
    clearStrip();
    wrapPending = false;
    setViewerBusy(false);
    $('viewer-wrap').hidden = true;
    $('viewer-status').textContent = '';
    const wasOpen = !viewer.hidden;
    viewer.hidden = !state.viewing;
    $('grid-viewport').inert = state.viewing;
    document.querySelector('.toolbar').inert = state.viewing;
    document.querySelector('.app-header').inert = state.viewing;
    if (!state.viewing) {
        nearbyImages = [];
        nearbyCollection = null;
        $('viewer-image').removeAttribute('src');
        if (wasOpen && previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
        requestAnimationFrame(renderRows);
        return;
    }
    if (!wasOpen) {
        previousFocus = document.activeElement;
        $('viewer-close').focus();
    }
    $('viewer-collection').textContent = (state.collection || rootName) + ' · all subfolders';
    $('viewer-name').textContent = state.image || '';
    if (state.image) {
        // Load the exact image immediately; traversal is only for nearby previews.
        const image = $('viewer-image');
        image.alt = filename(state.image);
        image.src = imageUrl(state.image);
        image.onerror = () => { $('viewer-status').textContent = 'Image unavailable. You can still navigate to another image.'; };
        loadStrip(state.image, state.collection, viewerController);
    } else {
        $('viewer-image').removeAttribute('src');
        moveImage();
    }
}

function render(force = false) {
    state = readState();
    $('recursive').checked = state.recursive;
    $('filter').value = state.filter;
    $('filter').disabled = state.recursive;
    $('filter').placeholder = state.recursive ? 'Name filtering is available in folder view' : 'Filter this folder by name';
    renderBreadcrumbs();
    const key = JSON.stringify([state.folder, state.recursive, state.filter]);
    if (force || key !== gridKey) {
        gridKey = key;
        loadGrid();
    }
    if (force) {
        viewerKey = null;
        nearbyImages = [];
        nearbyCollection = null;
    }
    renderViewer();
}

let scheduledScroll = false;
viewport.addEventListener('scroll', () => {
    if (scheduledScroll) return;
    scheduledScroll = true;
    requestAnimationFrame(() => { scheduledScroll = false; renderRows(); });
});
new ResizeObserver(() => {
    if (viewport.clientWidth !== gridWidth) layoutRows();
    else renderRows();
}).observe(viewport);
$('recursive').addEventListener('change', event => navigate({recursive: event.target.checked}));
let filterTimer;
$('filter').addEventListener('input', event => {
    const filter = event.target.value;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => navigate({filter}, true), 200);
});
$('refresh').addEventListener('click', () => render(true));
$('read-folder').addEventListener('click', () => openViewer(null, state.folder));
$('load-more').addEventListener('click', loadRecursivePage);
$('viewer-close').addEventListener('click', closeViewer);
$('viewer-prev').addEventListener('click', () => requestMove(true));
$('viewer-next').addEventListener('click', () => requestMove(false));
$('viewer-wrap').addEventListener('click', () => moveImage(wrapDirection, true));
document.addEventListener('keydown', event => {
    if (!state.viewing) return;
    if (event.key === 'Escape') closeViewer();
    else if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        requestMove(['ArrowLeft', 'ArrowUp'].includes(event.key), !event.repeat);
    } else if (event.key === 'Tab') {
        const buttons = [...viewer.querySelectorAll('button')].filter(node => !node.hidden && !node.disabled);
        const next = (buttons.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
    }
});
let lastWheel = 0;
let lastWheelEvent = -Infinity;
viewer.addEventListener('wheel', event => {
    if (event.target.closest('.viewer-strip') || !event.deltaY) return;
    event.preventDefault();
    const now = performance.now();
    const freshGesture = now - lastWheelEvent > 300;
    lastWheelEvent = now;
    if (now - lastWheel < 220) return;
    lastWheel = now;
    requestMove(event.deltaY < 0, freshGesture);
}, {passive: false});
window.addEventListener('popstate', () => render());
render();
