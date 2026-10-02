import {isVideo} from './media-kind.js';
import {getFolder, walkImages, sequence} from './api.js';
import {byId, element, TaskScope} from './dom.js';
import {icon} from './icons.js';
import {GridLayout} from './grid-layout.js';
import {filename, joinPath, parentPath} from './state.js';

const OVERSCAN = 230;
const DISCOVERY_MARGIN = 400;
const MAX_RECURSIVE_IMAGES = 2000;

/** Owns folder loading, incremental discovery, and the lifetime of visible rows. */
export class FolderGrid {
    constructor(previews, {folderLink, openViewer, folderLoaded, refresh}) {
        this.previews = previews;
        this.folderLink = folderLink;
        this.openViewer = (image, collection, opener) => {
            if (image && parentPath(image) === this.directory?.path && collection === this.directory.path) {
                const {images, folders} = this.directory.listing;
                const index = images.indexOf(filename(image));
                if (index >= 0) {
                    const start = Math.max(0, index - 32), end = Math.min(images.length, index + 33);
                    sequence.seed(collection, images.slice(start, end).map(name => joinPath(collection, name)),
                        {start: start === 0, end: end === images.length && !folders.length});
                }
            }
            openViewer(image, collection, opener);
        };
        this.folderLoaded = folderLoaded;
        this.refresh = refresh;
        this.viewport = byId('grid-viewport');
        this.container = byId('grid');
        this.status = byId('grid-status');
        this.summary = byId('summary');
        this.moreButton = byId('load-more');
        this.layout = new GridLayout(this.viewport);
        this.rowNodes = new Map();
        this.items = [];
        this.rootName = 'Collection';
        this.directory = null;
        this.cache = new Map();
        this.loadingFolder = false;
        this.loadingPage = false;
        this.restorePosition = null;
        this.scrollScheduled = false;
        this.viewport.addEventListener('scroll', () => this.scheduleRender());
        this.moreButton.addEventListener('click', () => this.refresh());
        this.resizeObserver = new ResizeObserver(() => {
            if (!this.state) return;
            if (this.viewport.clientWidth !== this.layout.width) this.relayout();
            else this.renderRows();
        });
        this.resizeObserver.observe(this.viewport);
    }

    show(state, force = false, position = null) {
        const previous = this.state;
        this.state = state;
        this.viewport.inert = state.viewing;
        if (state.viewing) return;
        if (position) this.restorePosition = position;
        this.viewport.classList.toggle('compact', state.compact);
        if (force || previous?.folder !== state.folder || this.directory?.path !== state.folder) {
            this.loadFolder(force);
        } else if (this.directory && !this.loadingFolder
            && ['recursive', 'compact', 'filter'].some(key => previous[key] !== state[key])) {
            this.displayFolder();
        } else this.scheduleRender();
    }

    position() {
        const [index] = this.layout.visibleRange(this.viewport.scrollTop + 1, this.viewport.scrollTop + 1);
        const row = this.layout.rows[index];
        return row ? {path: row.items?.[0].path ?? row.path, heading: !row.items,
            offset: this.viewport.scrollTop - row.top, rowHeight: row.height} : null;
    }

    restore() {
        if (!this.restorePosition || this.loadingFolder) return;
        const {path, heading, offset, rowHeight} = this.restorePosition;
        let row = this.layout.byPath.get((heading ? 'heading:' : 'item:') + path);
        if (!row && this.restorePosition.reveal && this.state.recursive && this.directory) {
            // Start a bounded window at the known image, rather than scanning from the root.
            this.scope?.dispose(); this.scope = new TaskScope(); this.loadingPage = false;
            Object.assign(this.directory, {images: [{type: 'image', path}],
                cursor: {anchor: path, server: null}, done: false, failed: false,
                trimmedBefore: true, windowed: true});
            this.items = this.directory.images;
            this.layout.reset(this.items, true, this.rootName);
            this.container.style.height = this.layout.height + 'px';
            row = this.layout.byPath.get('item:' + path);
        }
        if (this.restorePosition.reveal) this.focusPath = path;
        // Restoring ordinary history never initiates a traversal.
        this.viewport.scrollTop = row ? Math.max(0, row.top + offset * row.height / (rowHeight || row.height)) : 0;
        this.restorePosition = null;
    }

    scheduleRender() {
        if (this.scrollScheduled) return;
        this.scrollScheduled = true;
        requestAnimationFrame(() => {
            this.scrollScheduled = false;
            if (this.state) this.renderRows();
        });
    }

    removeRow(index) {
        const entry = this.rowNodes.get(index);
        if (!entry) return;
        if (!this.focusPath && entry.node.contains(document.activeElement)) {
            this.focusPath = document.activeElement.closest('.card')?.dataset.path;
        }
        entry.scope.dispose();
        entry.node.remove();
        this.rowNodes.delete(index);
    }

    clearRows() {
        for (const index of this.rowNodes.keys()) this.removeRow(index);
        this.previews.schedule();
    }

    relayout() {
        this.layout.reset(this.items, this.state.recursive, this.rootName);
        this.container.style.height = this.layout.height + 'px';
        this.renderRows();
    }

    appendRows(items) {
        const lastIndex = this.layout.rows.length - 1;
        const last = this.layout.rows[lastIndex];
        if (last?.items && last.items.length < this.layout.columns) this.removeRow(lastIndex);
        this.layout.append(items);
        this.container.style.height = this.layout.height + 'px';
        this.renderRows();
    }

    createListItem(item, scope) {
        const folder = item.type === 'folder';
        const node = element('article', 'card list-item');
        node.dataset.path = item.path;
        node.classList.toggle('selected-media', this.state.overview && this.state.image === item.path);
        const name = folder ? this.folderLink(item.path, filename(item.path))
            : element('button', 'list-name', filename(item.path));
        name.classList.add('list-name');
        name.title = item.path;
        if (!folder) name.addEventListener('click', event => this.openViewer(item.path, this.state.folder, event.currentTarget));
        const kind = icon(folder ? 'folder' : isVideo(item.path) ? 'video' : 'image');
        kind.classList.add('list-kind');
        kind.setAttribute('aria-label', folder ? 'Folder' : isVideo(item.path) ? 'Video' : 'Image');
        node.append(kind, name);
        if (!folder && isVideo(item.path)) {
            const duration = element('span', 'list-duration');
            node.append(duration);
            this.previews.duration(duration, item.path, scope);
        }
        if (folder) {
            const read = element('button', 'list-read', 'View');
            read.setAttribute('aria-label', 'View items in ' + filename(item.path));
            read.addEventListener('click', event => this.openViewer(null, item.path, event.currentTarget));
            node.prepend(read);
        }
        return node;
    }

    createCard(item, scope) {
        if (this.state.compact) return this.createListItem(item, scope);
        const node = element('article', 'card');
        node.dataset.path = item.path;
        node.classList.toggle('selected-media', this.state.overview && this.state.image === item.path);
        const isFolder = item.type === 'folder';
        const picture = isFolder ? this.folderLink(item.path, 'Folder') : element('button', '', 'Loading…');
        picture.className = 'picture';
        picture.setAttribute('aria-label', (isFolder ? 'Open folder ' : 'View ') + filename(item.path));
        const caption = element('div', 'card-caption');
        let preview;
        if (isFolder) {
            const read = element('button', '', 'View');
            read.title = 'View all items in ' + filename(item.path);
            read.addEventListener('click', event => this.openViewer(null, item.path, event.currentTarget));
            node.classList.add('folder-card');
            const name = this.folderLink(item.path, filename(item.path));
            name.prepend(icon('folder'));
            caption.append(name, read);
            preview = this.previews.thumbnail(picture, item.path, scope);
        } else {
            picture.addEventListener('click', event => this.openViewer(item.path, this.state.folder, event.currentTarget));
            const name = element('button', 'image-name', filename(item.path));
            name.addEventListener('click', event => this.openViewer(item.path, this.state.folder, event.currentTarget));
            caption.append(name);
            preview = this.previews.thumbnail(picture, item.path, scope);
        }
        preview.catch(error => {
            if (!scope.signal.aborted) picture.textContent = 'Preview unavailable';
        });
        caption.title = item.path;
        node.append(picture, caption);
        return node;
    }

    createRow(index) {
        const row = this.layout.rows[index];
        const node = element('div', 'grid-row');
        node.style.top = row.top + 'px';
        node.style.height = row.height + 'px';
        node.style.gridTemplateColumns = row.items ? `repeat(${this.layout.columns}, minmax(0, 1fr))` : '1fr';
        const scope = new TaskScope();
        if (row.items) row.items.forEach(item => node.append(this.createCard(item, scope)));
        else {
            const heading = element('h2', 'folder-heading');
            heading.append(this.folderLink(row.path, row.label));
            node.append(heading);
        }
        this.container.append(node);
        this.rowNodes.set(index, {node, scope, signature: this.rowSignature(row)});
    }

    rowSignature(row) {
        return JSON.stringify([this.state.compact, this.state.overview ? this.state.image : null, row.items?.map(item => item.path) ?? row.path]);
    }

    renderRows() {
        this.restore();
        const start = Math.max(0, this.viewport.scrollTop - OVERSCAN);
        const end = this.viewport.scrollTop + this.viewport.clientHeight + OVERSCAN;
        const [first, last] = this.layout.visibleRange(start, end);
        for (const index of this.rowNodes.keys()) {
            const row = this.layout.rows[index];
            if (index < first || index >= last || !row || this.rowNodes.get(index).signature !== this.rowSignature(row)) this.removeRow(index);
            else {
                const node = this.rowNodes.get(index).node;
                node.style.top = row.top + 'px'; node.style.height = row.height + 'px';
                node.style.gridTemplateColumns = row.items ? `repeat(${this.layout.columns}, minmax(0, 1fr))` : '1fr';
            }
        }
        for (let index = first; index < last; index++) {
            if (!this.rowNodes.has(index)) this.createRow(index);
        }
        if (this.focusPath && !this.state.viewing) {
            const item = [...this.container.querySelectorAll('.card')].find(node => node.dataset.path === this.focusPath);
            const target = item?.querySelector(this.focusSelector || '.list-name, .card-caption a, .image-name, button');
            (target || item?.querySelector('a, button'))?.focus({preventScroll: true});
            if (item || !this.loadingFolder) {
                if (!item) this.viewport.focus({preventScroll: true});
                this.focusPath = null;
                this.focusSelector = null;
            }
        }
        this.previews.schedule();
        if (this.state.recursive && this.directory?.trimmedBefore && this.viewport.scrollTop < DISCOVERY_MARGIN
            && !this.loadingPage && !this.loadingFolder && !this.state.viewing) { this.loadPage(true); return; }
        const needsMore = end >= this.layout.height - DISCOVERY_MARGIN;
        if (needsMore && this.state.recursive && !this.directory?.done && !this.loadingFolder
            && !this.loadingPage && !this.directory?.failed && !this.state.viewing) this.loadPage();
    }

    rememberDirectory() {
        if (!this.directory?.listing) return;
        this.cache.delete(this.directory.path);
        this.cache.set(this.directory.path, this.directory);
        // Keep recently discovered names for Back, bounded independently of images.
        const count = () => [...this.cache.values()].reduce((sum, item) => sum + item.images.length
            + item.listing.folders.length + item.listing.images.length, 0);
        while (this.cache.size > 3 || (count() > 20000 && this.cache.size > 0)) {
            this.cache.delete(this.cache.keys().next().value);
        }
    }

    async loadFolder(force) {
        this.rememberDirectory();
        if (force) this.cache.delete(this.state.folder);
        this.scope?.dispose();
        const scope = this.scope = new TaskScope();
        this.loadingFolder = true;
        this.loadingPage = false;
        this.clearRows();
        this.items = [];
        this.viewport.scrollTop = 0;
        this.relayout();
        this.status.textContent = 'Opening folder…';
        this.summary.textContent = '';
        this.moreButton.hidden = true;
        this.viewport.setAttribute('aria-busy', 'true');
        const path = this.state.folder;
        try {
            this.directory = !force && this.cache.get(path);
            if (!this.directory) {
                const listing = await getFolder(path, scope.signal);
                scope.signal.throwIfAborted();
                this.directory = {path, listing, images: [], cursor: null, done: false, failed: false, warning: ''};
            }
            this.rootName = this.directory.listing.root_name || 'Collection';
            this.folderLoaded(this.rootName);
            const {listing} = this.directory;
            sequence.seed(path, listing.images.slice(0, 2048).map(name => joinPath(path, name)),
                {start: true, end: listing.images.length <= 2048 && !listing.folders.length});
            this.loadingFolder = false;
            this.displayFolder();
        } catch (error) {
            if (error.name !== 'AbortError') {
                this.directory = null;
                this.status.textContent = error.message;
                this.moreButton.hidden = false;
            }
        } finally {
            if (scope === this.scope) {
                this.loadingFolder = false;
                this.viewport.setAttribute('aria-busy', 'false');
            }
        }
    }

    displayFolder() {
        const {listing} = this.directory;
        const filter = this.state.filter.toLocaleLowerCase();
        this.items = this.state.recursive ? this.directory.images : [
            ...listing.folders.map(name => ({type: 'folder', path: joinPath(this.state.folder, name)})),
            ...listing.images.map(name => ({type: 'image', path: joinPath(this.state.folder, name)})),
        ].filter(item => filename(item.path).toLocaleLowerCase().includes(filter));
        this.relayout();
        this.updateSummary();
    }

    updateSummary() {
        const directory = this.directory;
        if (this.state.recursive) {
            this.summary.textContent = (directory.windowed ? 'Media'
                : directory.images.length + (directory.done ? ' items' : ' items discovered'))
                + (directory.warning ? ' · ' + directory.warning : '');
            this.status.textContent = directory.done ? (this.items.length ? 'End of folder' : 'No images or videos found.') : '';
        } else {
            const {listing} = directory;
            this.status.textContent = this.items.length ? '' : (this.state.filter
                ? 'No matching names.' : 'This folder has no visible folders or supported images or videos.');
            this.summary.textContent = `${listing.folders.length} folders · ${listing.images.length} direct items`
                + (this.state.filter ? ` · ${this.items.length} matches` : '');
        }
        this.moreButton.hidden = !directory.failed;
    }

    async loadPage(reverse = false) {
        if (!this.directory) { this.loadFolder(true); return; }
        if (this.loadingPage || (!reverse && this.directory.done) || !this.state.recursive) return;
        this.loadingPage = true;
        const directory = this.directory;
        directory.failed = false;
        this.moreButton.hidden = true;
        const scope = this.scope;
        try {
            const result = await walkImages({root: directory.path, reverse,
                anchor: reverse ? directory.images[0]?.path : null, cursor: reverse ? null : directory.cursor}, scope.signal);
            scope.signal.throwIfAborted();
            const added = result.images.map(path => ({type: 'image', path}));
            const position = this.position();
            if (reverse) {
                directory.images.unshift(...added.reverse());
                directory.trimmedBefore = result.cursor !== null;
            } else {
                directory.images.push(...added);
                directory.cursor = result.cursor;
                directory.done = result.cursor === null;
            }
            const overflow = directory.images.length > MAX_RECURSIVE_IMAGES;
            if (overflow) {
                directory.windowed = true;
                if (reverse) {
                    directory.images.splice(MAX_RECURSIVE_IMAGES);
                    directory.done = false;
                    directory.cursor = {anchor: directory.images.at(-1).path, server: null};
                } else {
                    directory.images.splice(0, directory.images.length - MAX_RECURSIVE_IMAGES);
                    directory.trimmedBefore = true;
                }
            }
            if (result.warnings.length) directory.warning = 'Some folders could not be read.';
            if (this.state.recursive) {
                if (reverse || overflow) {
                    this.items = directory.images; this.restorePosition = position; this.relayout();
                } else this.appendRows(added);
                this.updateSummary();
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                directory.failed = true;
                this.status.textContent = error.message;
                this.moreButton.hidden = false;
            }
        } finally {
            if (scope === this.scope) {
                this.loadingPage = false;
                if (!directory.failed) this.scheduleRender();
            }
        }
    }
}
