import {isVideo, fileExtension} from './media-kind.js';
import {getFolder, walkImages, sequence} from './api.js';
import {byId, element, plainClick, setButtonLabel, TaskScope} from './dom.js';
import {icon} from './icons.js';
import {GridLayout} from './grid-layout.js';
import {filename, joinPath, parentPath, ScreenMode, ItemType, sortKey, sortSettings} from './state.js';

const OVERSCAN = 230;
const DISCOVERY_MARGIN = 400;
const MAX_RECURSIVE_IMAGES = 2000;
const RETURN_NEIGHBORS = 8;

function positionRow(node, row) {
    node.style.top = row.top + 'px';
    node.style.height = row.height + 'px';
    node.style.gridTemplateColumns = row.items ? `repeat(${row.columns}, minmax(0, 1fr))` : '1fr';
}

/** Owns folder loading, incremental discovery, and the lifetime of visible rows. */
export class FolderGrid {
    constructor(previews, {folderLink, mediaLink, folderLoaded, refresh, showInfo}) {
        this.previews = previews;
        this.folderLink = folderLink;
        this.mediaLink = (image, collection, label, mode) => {
            const link = mediaLink(image, collection, label, mode);
            link.addEventListener('click', event => {
                if (!plainClick(event)) return;
                if (image && parentPath(image) === this.directory?.path && collection === this.directory.path) {
                    const {images, folders} = this.directory.listing;
                    const index = images.indexOf(filename(image));
                    if (index >= 0) {
                        const start = Math.max(0, index - 32), end = Math.min(images.length, index + 33);
                        sequence.seed(collection, images.slice(start, end).map(name => joinPath(collection, name)),
                            {...this.directory.ordering, start: start === 0, end: end === images.length && !folders.length});
                    }
                }
            }, {capture: true});
            return link;
        };
        this.folderLoaded = folderLoaded;
        this.refresh = refresh;
        this.showInfo = showInfo;
        this.viewport = byId('grid-viewport');
        this.container = byId('grid');
        this.status = byId('grid-status');
        this.summary = byId('summary');
        this.moreButton = byId('load-more');
        this.layout = new GridLayout(this.viewport);
        this.rowNodes = new Map();
        this.items = [];
        this.otherFiles = [];
        this.othersOpen = false;
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
        this.viewport.inert = !state.active;
        if (!state.active) return;
        if (position) this.restorePosition = position;
        this.viewport.classList.toggle('compact', state.compact);
        if (force || previous?.folder !== state.folder || this.directory?.key !== this.directoryKey(state)) {
            this.loadFolder(force);
        } else if (this.directory && !this.loadingFolder
            && (!previous.active || ['recursive', 'compact', 'filter'].some(key => previous[key] !== state[key]))) {
            this.displayFolder();
        } else this.scheduleRender();
    }

    position() {
        const top = this.viewport.scrollTop - this.gridOffset;
        const [index] = this.layout.visibleRange(top + 1, top + 1);
        const row = this.layout.rows[index];
        if (!row) return null;
        const position = {path: row.items?.[0].path ?? row.path, heading: !row.items,
            offset: top - row.top, rowHeight: row.height};
        if (!this.state.recursive && row.items) {
            // Original filtered order: next item wins ties with the previous one.
            position.neighbors = [];
            for (let distance = 1; distance <= RETURN_NEIGHBORS; distance++) {
                for (const index of [row.startIndex + distance, row.startIndex - distance]) {
                    if (this.items[index]) position.neighbors.push(this.items[index].path);
                }
            }
        }
        return position;
    }

    restore() {
        if (!this.restorePosition || this.loadingFolder) return;
        const {path, heading, offset, rowHeight} = this.restorePosition;
        let row = this.layout.byPath.get((heading ? 'heading:' : 'item:') + path);
        if (!row && !this.state.recursive) {
            for (const neighbor of this.restorePosition.neighbors || []) {
                row = this.layout.byPath.get('item:' + neighbor);
                if (row) break;
            }
        }
        if (!row && this.restorePosition.reveal && this.state.recursive && this.directory) {
            // Start a bounded window at the known image, rather than scanning from the root.
            this.scope?.dispose(); this.scope = new TaskScope(); this.loadingPage = false;
            Object.assign(this.directory, {images: [{type: ItemType.MEDIA, path}],
                cursor: {anchor: path, server: null}, done: false, failed: false,
                trimmedBefore: true, windowed: true});
            this.items = this.directory.images;
            this.layout.reset(this.items, true, this.rootName);
            this.container.style.height = this.layout.height + 'px';
            row = this.layout.byPath.get('item:' + path);
        }
        if (this.restorePosition.reveal) this.focusPath = path;
        // Restoring ordinary history never initiates a traversal.
        this.viewport.scrollTop = row ? Math.max(0, this.gridOffset + row.top + offset * row.height / (rowHeight || row.height)) : 0;
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
        if (!this.state.recursive && !this.loadingFolder && this.directory?.listing.other_files.length) {
            const count = this.state.filter ? this.otherFiles.length : this.directory.listing.other_files.length;
            const label = this.state.filter ? `${count} matching other ${count === 1 ? 'file' : 'files'}` : `Other files (${count})`;
            this.layout.appendDisclosure(this.state.folder, label, this.otherFiles, this.othersOpen);
        }
        this.container.style.height = this.layout.height + 'px';
        this.gridOffset = this.container.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top + this.viewport.scrollTop;
        this.renderRows();
    }

    toggleOtherFiles() {
        this.othersOpen = !this.othersOpen;
        this.relayout();
        if (this.othersOpen) {
            const heading = this.layout.byPath.get('heading:' + this.state.folder);
            this.viewport.scrollTop = this.gridOffset + heading.top;
            this.renderRows();
        }
        this.container.querySelector('.other-files-toggle')?.focus({preventScroll:true});
    }

    appendRows(items) {
        const lastIndex = this.layout.rows.length - 1;
        const last = this.layout.rows[lastIndex];
        if (last?.items && last.items.length < this.layout.columns) this.removeRow(lastIndex);
        this.layout.append(items);
        this.container.style.height = this.layout.height + 'px';
        this.renderRows();
    }

    itemLink(item, label = filename(item.path)) {
        const name = filename(item.path);
        let link, action;
        if (item.type === ItemType.FILE) {
            link = element('button', '', label);
            link.type = 'button';
            link.setAttribute('aria-controls', 'item-info');
            link.addEventListener('click', event => {
                event.stopPropagation();
                this.showInfo(item.path);
            });
            action = 'File info for';
        } else if (item.type === ItemType.FOLDER) {
            link = this.folderLink(item.path, label);
            action = 'Open folder';
        } else {
            link = this.mediaLink(item.path, this.state.folder, label);
            action = isVideo(item.path) ? 'View video' : 'View image';
        }
        link.setAttribute('aria-label', `${action} ${name}`);
        return link;
    }

    renderListItem(node, item, scope) {
        const folder = item.type === ItemType.FOLDER;
        const other = item.type === ItemType.FILE;
        node.classList.add('list-item');
        node.classList.toggle('other-file', other);
        const name = this.itemLink(item);
        name.classList.add('list-name');
        name.title = item.path;
        const kind = icon(other ? 'file' : folder ? 'folder' : isVideo(item.path) ? 'video' : 'image');
        kind.classList.add('list-kind');
        node.append(kind, name);
        if (other) node.append(element('span', 'list-file-type', fileExtension(item.path) || ''));
        else if (!folder && isVideo(item.path)) {
            const duration = element('span', 'list-duration');
            node.append(duration);
            this.previews.duration(duration, item.path, scope);
        }
        if (folder) node.prepend(this.folderActions(item.path));
    }

    folderActions(path) {
        const group = element('div', 'folder-actions choice-group');
        for (const [mode, name, className] of [[ScreenMode.OVERVIEW, 'grid', 'folder-overview'], [ScreenMode.VIEW, 'play', 'folder-view']]) {
            const link = this.mediaLink(null, path, undefined, mode);
            link.classList.add(className);
            setButtonLabel(link, (mode === ScreenMode.OVERVIEW ? 'Collection overview of ' : 'View items in ') + filename(path));
            link.append(icon(name));
            group.append(link);
        }
        return group;
    }

    createCard(item, scope, compact) {
        const node = element('article', 'card');
        node.dataset.path = item.path;
        node.classList.toggle('selected-media', this.state.selected === item.path);
        if (compact) this.renderListItem(node, item, scope);
        else this.renderPreview(node, item, scope);
        return node;
    }

    renderPreview(node, item, scope) {
        const isFolder = item.type === ItemType.FOLDER;
        const picture = this.itemLink(item, isFolder ? 'Folder' : 'Loading…');
        picture.classList.add('picture');
        const caption = element('div', 'card-caption');
        const name = this.itemLink(item);
        if (isFolder) {
            node.classList.add('folder-card');
            name.prepend(icon('folder'));
            caption.append(name, this.folderActions(item.path));
        } else {
            name.classList.add('image-name');
            caption.append(name);
        }
        this.previews.thumbnail(picture, item.path, scope).catch(() => {
            if (!scope.signal.aborted) picture.textContent = 'Preview unavailable';
        });
        caption.title = item.path;
        node.append(picture, caption);
    }

    createRow(index) {
        const row = this.layout.rows[index];
        const node = element('div', 'grid-row');
        node.classList.toggle('compact-row', Boolean(row.compact));
        positionRow(node, row);
        const scope = new TaskScope();
        if (row.items) row.items.forEach(item => node.append(this.createCard(item, scope, row.compact)));
        else if (row.disclosure) {
            node.classList.add('other-files-heading');
            const control = element('button', 'other-files-toggle', row.label);
            control.type = 'button';
            control.setAttribute('aria-expanded', String(row.expanded));
            control.prepend(icon('down'));
            control.addEventListener('click', () => this.toggleOtherFiles());
            node.append(control);
        } else {
            const heading = element('h2', 'folder-heading');
            heading.append(this.folderLink(row.path, row.label));
            node.append(heading);
        }
        this.container.append(node);
        this.rowNodes.set(index, {node, scope, signature: this.rowSignature(row)});
    }

    rowSignature(row) {
        return JSON.stringify([row.compact, this.state.linkPresentation, row.label, row.expanded,
            this.state.selected, row.items?.map(item => item.path) ?? row.path]);
    }

    renderRows() {
        this.restore();
        const top = this.viewport.scrollTop - this.gridOffset;
        const start = Math.max(0, top - OVERSCAN);
        const end = top + this.viewport.clientHeight + OVERSCAN;
        const [first, last] = this.layout.visibleRange(start, end);
        for (const index of this.rowNodes.keys()) {
            const row = this.layout.rows[index];
            if (index < first || index >= last || !row || this.rowNodes.get(index).signature !== this.rowSignature(row)) this.removeRow(index);
            else {
                const node = this.rowNodes.get(index).node;
                positionRow(node, row);
            }
        }
        for (let index = first; index < last; index++) {
            if (!this.rowNodes.has(index)) this.createRow(index);
        }
        if (this.focusPath && this.state.active) {
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
            && !this.loadingPage && !this.loadingFolder && this.state.active) { this.loadPage(true); return; }
        const needsMore = end >= this.layout.height - DISCOVERY_MARGIN;
        if (needsMore && this.state.recursive && !this.directory?.done && !this.loadingFolder
            && !this.loadingPage && !this.directory?.failed && this.state.active) this.loadPage();
    }

    rememberDirectory() {
        if (!this.directory?.listing) return;
        this.cache.delete(this.directory.key);
        this.cache.set(this.directory.key, this.directory);
        // Keep recently discovered names for Back, bounded independently of images.
        const count = () => [...this.cache.values()].reduce((sum, item) => sum + item.images.length
            + item.listing.folders.length + item.listing.images.length + item.listing.other_files.length, 0);
        while (this.cache.size > 3 || (count() > 20000 && this.cache.size > 0)) {
            this.cache.delete(this.cache.keys().next().value);
        }
    }

    directoryKey(state) { return JSON.stringify([state.folder, sortKey(state)]); }

    async loadFolder(force) {
        this.rememberDirectory();
        const key = this.directoryKey(this.state);
        const ordering = sortSettings(this.state);
        if (force) this.cache.delete(key);
        this.scope?.dispose();
        const scope = this.scope = new TaskScope();
        this.loadingFolder = true;
        this.loadingPage = false;
        this.clearRows();
        this.items = [];
        this.otherFiles = [];
        this.othersOpen = false;
        this.viewport.scrollTop = 0;
        this.relayout();
        this.status.textContent = 'Opening folder…';
        this.summary.textContent = '';
        this.moreButton.hidden = true;
        this.viewport.setAttribute('aria-busy', 'true');
        const path = this.state.folder;
        try {
            this.directory = !force && this.cache.get(key);
            if (!this.directory) {
                const listing = await getFolder(path, scope.signal, ordering);
                scope.signal.throwIfAborted();
                this.directory = {path, key, ordering, listing, images: [], cursor: null, done: false, failed: false, warning: ''};
            }
            this.rootName = this.directory.listing.root_name || 'Collection';
            this.folderLoaded(this.rootName);
            const {listing} = this.directory;
            sequence.seed(path, listing.images.slice(0, 2048).map(name => joinPath(path, name)),
                {...ordering, start: true, end: listing.images.length <= 2048 && !listing.folders.length});
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
        const children = (names, type) => names.filter(name => name.toLocaleLowerCase().includes(filter))
            .map(name => ({type, path:joinPath(this.state.folder, name)}));
        this.items = this.state.recursive ? this.directory.images : [
            ...children(listing.folders, ItemType.FOLDER), ...children(listing.images, ItemType.MEDIA),
        ];
        this.otherFiles = this.state.recursive ? [] : children(listing.other_files, ItemType.FILE);
        this.updateSummary();
        this.relayout();
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
                ? this.otherFiles.length ? 'No matching media or folders.' : 'No matching names.'
                : listing.other_files.length ? 'No supported media.' : 'This folder is empty.');
            this.summary.textContent = `${listing.folders.length} folders · ${listing.images.length} direct items`
                + (listing.other_files.length ? ` · ${listing.other_files.length} other ${listing.other_files.length === 1 ? 'file' : 'files'}` : '')
                + (this.state.filter ? ` · ${this.items.length} matches` : '');
        }
        this.moreButton.hidden = !directory.failed;
        // Empty Browse feedback precedes the disclosure; Overview's end marker follows its grid.
        if (this.state.recursive) this.container.after(this.status);
        else this.container.before(this.status);
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
            const result = await walkImages({...directory.ordering, root: directory.path, reverse,
                anchor: reverse ? directory.images[0]?.path : null, cursor: reverse ? null : directory.cursor}, scope.signal);
            scope.signal.throwIfAborted();
            const added = result.images.map(path => ({type: ItemType.MEDIA, path}));
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
