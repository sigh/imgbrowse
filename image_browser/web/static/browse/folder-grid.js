import {isVideo, fileExtension} from '../shared/media-kind.js';
import {getFolder, walkImages, sequence} from '../data/api.js';
import {byId, element, plainClick, setButtonLabel, TaskScope} from '../shared/dom.js';
import {icon} from '../shared/icons.js';
import {GridLayout} from './grid-layout.js';
import {FolderData} from '../data/folder-data.js';
import {filename, joinPath, ScreenMode, ItemType} from '../shared/state.js';

const OVERSCAN = 230;
const DISCOVERY_MARGIN = 400;
const RETURN_NEIGHBORS = 8;
const mediaItem = path => ({type:ItemType.MEDIA, path});

function itemParts(item) {
    const folder = item.type === ItemType.FOLDER;
    const other = item.type === ItemType.FILE;
    return {folder, other, video: !folder && !other && isVideo(item.path)};
}

/** Width occupied by the same parts rendered in cards and list rows. */
function itemGeometry(item, compact, number) {
    const {folder, other, video} = itemParts(item);
    const padding = 2 * number('--card-caption-padding');
    const actions = number('--folder-actions-units') * number('--control-height');
    const labelInset = compact ? padding + number('--list-kind-width') + number('--list-gap')
        + (folder ? actions + number('--list-gap') : other || video ? number('--list-detail-width') + number('--list-gap') : 0)
        : padding + 2 * number('--card-border-width')
        + (folder ? actions + number('--card-caption-gap') + number('--control-icon-size') + number('--space-sm') : 0);
    return {labelInset, minLabelHeight:folder ? number('--control-height') : compact ? number('--control-icon-size') : 0};
}

function positionRow(node, row) {
    node.style.top = row.top + 'px';
    node.style.height = row.height + 'px';
    node.style.gridTemplateColumns = row.items ? `repeat(${row.columns}, minmax(0, 1fr))` : '1fr';
}

/** Presents folder data and owns geometry, focus, and visible row lifetimes. */
export class FolderGrid {
    constructor(previews, {folderLink, mediaLink, folderLoaded, refresh, showInfo}) {
        this.previews = previews;
        this.data = new FolderData({getFolder, walkImages, seed:(...args) => sequence.seed(...args)});
        this.folderLink = folderLink;
        this.mediaLink = (image, collection, label, mode) => {
            const link = mediaLink(image, collection, label, mode);
            link.addEventListener('click', event => {
                if (!plainClick(event)) return;
                this.data.seedAround(this.directory, image, collection);
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
        this.layout = new GridLayout(this.viewport, itemGeometry);
        this.rowNodes = new Map();
        this.items = [];
        this.otherFiles = [];
        this.othersOpen = false;
        this.rootName = 'Collection';
        this.directory = null;
        this.loadingFolder = false;
        this.restorePosition = null;
        this.scrollScheduled = false;
        this.viewport.addEventListener('scroll', () => this.scheduleRender());
        this.moreButton.addEventListener('click', () => this.refresh());
        this.resizeObserver = new ResizeObserver(() => {
            if (!this.state?.active) return;
            if (this.viewport.clientWidth !== this.layout.width) this.relayout();
            else this.renderRows();
        });
        this.resizeObserver.observe(this.viewport);
    }

    show(state, force = false, position = null) {
        const previous = this.state;
        this.state = state;
        this.viewport.inert = !state.active;
        if (!state.active) { this.stop(); return; }
        if (!this.scope || this.scope.signal.aborted) this.scope = new TaskScope();
        if (position) this.restorePosition = position;
        this.viewport.classList.toggle('compact', state.compact);
        if (force || this.directory?.key !== this.data.key(state)) {
            this.loadFolder(force);
        } else if (this.directory && !this.loadingFolder
            && (!previous.active || ['recursive', 'compact', 'filter'].some(key => previous[key] !== state[key]))) {
            this.displayFolder();
        } else this.scheduleRender();
    }

    get loadingPage() { return Boolean(this.directory?.window.edges.some(edge => edge.loading)); }

    stop() {
        this.scope?.dispose();
        this.loadingFolder = false;
        if (this.directory) for (const edge of this.directory.window.edges) edge.loading = false;
        this.viewport.setAttribute('aria-busy', 'false');
    }

    invalidate() { this.data.clear(); }

    get canSavePosition() { return !this.loadingFolder && !this.restorePosition; }

    showError(message) { this.status.textContent = message; }

    /** History stores this bookmark without knowing the grid's markup. */
    captureFocus(node) {
        if (node?.id) return {id: node.id};
        const card = node?.closest('.card');
        if (!card) return {id: this.viewport.id};
        const action = ['folder-overview', 'folder-view', 'list-name', 'picture', 'image-name']
            .find(name => node.classList.contains(name));
        return {path: card.dataset.path, selector: action ? '.' + action : '.card-caption a'};
    }

    restoreFocus(bookmark = {}) {
        if (bookmark.path) {
            this.focusPath = bookmark.path;
            this.focusSelector = bookmark.selector;
            this.viewport.focus({preventScroll: true});
            this.scheduleRender();
        } else (byId(bookmark.id) || this.viewport).focus({preventScroll: true});
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
            this.stop(); this.scope = new TaskScope();
            this.data.reveal(this.directory, path);
            this.items = this.directory.window.paths.map(mediaItem);
            this.resetLayout();
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
            const bookmark = this.captureFocus(document.activeElement);
            this.focusPath = bookmark.path;
            this.focusSelector = bookmark.selector;
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
        this.resetLayout();
        if (!this.state.recursive && !this.loadingFolder && this.directory?.listing.other_files.length) {
            const count = this.state.filter ? this.otherFiles.length : this.directory.listing.other_files.length;
            const label = this.state.filter ? `${count} matching other ${count === 1 ? 'file' : 'files'}` : `Other files (${count})`;
            this.layout.appendDisclosure(this.state.folder, label, this.otherFiles, this.othersOpen);
        }
        this.container.style.height = this.layout.height + 'px';
        this.gridOffset = this.container.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top + this.viewport.scrollTop;
        this.renderRows();
    }

    resetLayout() {
        const media = this.items.filter(item => !itemParts(item).folder);
        const videoCards = !this.state.recursive && !this.state.compact && media.length
            && media.every(item => itemParts(item).video);
        this.layout.reset(this.items, this.state.recursive, this.rootName, videoCards ? 16 / 9 : null);
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
        const {folder, other, video} = itemParts(item);
        node.classList.add('list-item');
        node.classList.toggle('other-file', other);
        const name = this.itemLink(item);
        name.classList.add('list-name');
        name.title = item.path;
        const kind = icon(other ? 'file' : folder ? 'folder' : video ? 'video' : 'image');
        kind.classList.add('list-kind');
        node.append(kind, name);
        if (other) node.append(element('span', 'list-file-type', fileExtension(item.path) || ''));
        else if (video) {
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
        const {folder: isFolder} = itemParts(item);
        const picture = this.itemLink(item, isFolder ? 'Folder' : 'Loading…');
        picture.classList.add('picture');
        const caption = element('div', 'card-caption');
        const name = this.itemLink(item);
        name.classList.add('card-name');
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
        node.classList.toggle('heading-row', !row.items && !row.disclosure);
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
        if (!this.state?.active) return;
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
        if (this.state.recursive && this.directory?.window.canLoad(this.directory.window.edges[0]) && this.viewport.scrollTop < DISCOVERY_MARGIN
            && !this.loadingPage && !this.loadingFolder && this.state.active) { this.loadPage(true); return; }
        const needsMore = end >= this.layout.height - DISCOVERY_MARGIN;
        if (needsMore && this.state.recursive && this.directory?.window.canLoad(this.directory.window.edges[1]) && !this.loadingFolder
            && !this.loadingPage && this.state.active) this.loadPage();
    }

    async loadFolder(force) {
        this.scope?.dispose();
        this.directory = null;
        const scope = this.scope = new TaskScope();
        this.loadingFolder = true;
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
        try {
            this.directory = await this.data.open(this.state, scope.signal, force);
            scope.signal.throwIfAborted();
            this.rootName = this.directory.listing.root_name || 'Collection';
            this.folderLoaded(this.rootName);
            this.loadingFolder = false;
            this.displayFolder();
        } catch (error) {
            if (!scope.signal.aborted) {
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
        this.items = this.state.recursive ? this.directory.window.paths.map(mediaItem) : [
            ...children(listing.folders, ItemType.FOLDER), ...children(listing.images, ItemType.MEDIA),
        ];
        this.otherFiles = this.state.recursive ? [] : children(listing.other_files, ItemType.FILE);
        this.updateSummary();
        this.relayout();
    }

    updateSummary() {
        const directory = this.directory;
        const window = directory.window, after = window.edges[1];
        if (this.state.recursive) {
            this.summary.textContent = (window.windowed ? 'Media'
                : window.paths.length + (after.done ? ' items' : ' items discovered'))
                + (window.warning ? ' · Some folders could not be read.' : '');
            this.status.textContent = after.done ? (this.items.length ? 'End of folder' : 'No images or videos found.') : '';
        } else {
            const {listing} = directory;
            this.status.textContent = this.items.length ? '' : (this.state.filter
                ? this.otherFiles.length ? 'No matching media or folders.' : 'No matching names.'
                : listing.other_files.length ? 'No supported media.' : 'This folder is empty.');
            this.summary.textContent = `${listing.folders.length} folders · ${listing.images.length} direct items`
                + (listing.other_files.length ? ` · ${listing.other_files.length} other ${listing.other_files.length === 1 ? 'file' : 'files'}` : '')
                + (this.state.filter ? ` · ${this.items.length} matches` : '');
        }
        this.moreButton.hidden = !window.edges.some(edge => edge.failed);
        // Empty Browse feedback precedes the disclosure; Overview's end marker follows its grid.
        if (this.state.recursive) this.container.after(this.status);
        else this.container.before(this.status);
    }

    async loadPage(reverse = false) {
        if (!this.state.active || !this.state.recursive || this.loadingFolder || this.loadingPage || !this.directory) return;
        const directory = this.directory;
        const edge = directory.window.edges[reverse ? 0 : 1];
        if (!directory.window.canLoad(edge)) return;
        const scope = this.scope;
        const result = await this.data.load(directory, reverse, scope.signal);
        if (scope.signal.aborted) return;
        if (!result) {
            this.status.textContent = edge.error;
            this.moreButton.hidden = false;
            return;
        }
        const position = this.position();
        this.items = directory.window.paths.map(mediaItem);
        if (reverse || result.removed.length) {
            this.restorePosition = position;
            this.relayout();
        } else this.appendRows(result.added.map(mediaItem));
        this.updateSummary();
        this.scheduleRender();
    }
}
