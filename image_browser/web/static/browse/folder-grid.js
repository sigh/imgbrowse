import {isVideo, fileExtension} from '../shared/media-kind.js';
import {getFolder, walkImages, sequence, entries, invalidateViews} from '../data/api.js';
import {formatBytes, formatMetadataDate, timestampValue} from '../data/metadata-data.js';
import {byId, element, plainClick, setButtonLabel, TaskScope} from '../shared/dom.js';
import {icon} from '../shared/icons.js';
import {GridLayout} from './grid-layout.js';
import {FactDemand} from '../data/entry-store.js';
import {FolderData} from '../data/folder-data.js';
import {entryKey, filename, joinPath, ScreenMode, ItemType} from '../shared/state.js';

const OVERSCAN = 230;
const DISCOVERY_MARGIN = 400;
const RETURN_NEIGHBORS = 8;
const mediaItem = path => ({type:ItemType.MEDIA, path});

function setFactLabel(node, text, title) {
    node.textContent = text;
    node.title = title;
    node.setAttribute('aria-label', title);
}

function itemParts(item) {
    const folder = item.type === ItemType.FOLDER;
    const other = item.type === ItemType.FILE;
    return {folder, other, video: !folder && !other && isVideo(item.path)};
}

/** Width occupied by the same parts rendered in cards and list rows. */
function itemGeometry(item, compact, number, recursive) {
    const {folder, other, video} = itemParts(item);
    const padding = 2 * number('--card-caption-padding');
    const actions = number('--folder-actions-units') * number('--control-height');
    const dateColumn = compact && !recursive ? number('--list-date-width') : 0;
    const sizeColumn = compact && !recursive ? number('--list-size-width') : 0;
    const labelInset = compact ? padding + number('--list-kind-width') + number('--list-gap')
        + (dateColumn ? dateColumn + number('--list-gap') : 0)
        + (sizeColumn ? sizeColumn + number('--list-gap') : 0)
        + (folder ? actions + number('--list-gap') : other || video ? number('--list-detail-width') + number('--list-gap') : 0)
        : padding + 2 * number('--card-border-width')
        + (folder ? actions + number('--card-caption-gap') : 0);
    return {labelInset, labelExtraHeight:recursive || dateColumn ? 0 : number('--item-date-line-height'),
        topInset:!compact && folder ? number('--folder-tab-height') : 0,
        minLabelHeight:folder ? number('--control-height') : compact ? number('--control-icon-size') : 0};
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
        this.summary = byId('folder-summary');
        this.feedback = byId('folder-feedback');
        this.moreButton = byId('load-more');
        this.layout = new GridLayout(this.viewport, itemGeometry);
        this.rowNodes = new Map();
        this.items = [];
        this.otherFiles = [];
        this.othersOpen = false;
        this.rootName = 'Collection';
        this.directory = null;
        this.loadingFolder = false;
        this.folderError = null;
        this.restorePosition = null;
        this.scrollScheduled = false;
        this.viewport.addEventListener('scroll', () => this.scheduleRender());
        this.moreButton.addEventListener('click', () => {
            if (!this.folderError && this.facts?.errors.size) { this.facts.retry(); this.scheduleRender(); }
            else this.refresh();
        });
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
        } else if (this.directory
            && (!previous.active || ['recursive', 'compact', 'filter'].some(key => previous[key] !== state[key]))) {
            this.displayFolder();
        } else this.scheduleRender();
    }

    get loadingPage() { return Boolean(this.directory?.window.edges.some(edge => edge.loading)); }

    stop() {
        this.scope?.dispose();
        this.facts?.dispose(); this.facts = null;
        this.loadingFolder = false;
        if (this.directory) for (const edge of this.directory.window.edges) edge.loading = false;
        this.viewport.setAttribute('aria-busy', 'false');
    }

    invalidate(scope) { this.data.clear(scope); }

    get canSavePosition() { return !this.loadingFolder && !this.restorePosition; }

    showError(message) { this.setFeedback(message, true); }

    setFeedback(message, retry = false) {
        this.feedback.textContent = message;
        this.summary.hidden = Boolean(message);
        if (!retry && document.activeElement === this.moreButton) this.viewport.focus({preventScroll: true});
        this.moreButton.hidden = !retry;
    }

    updateFeedback() {
        if (this.loadingFolder) return;
        if (this.folderError) { this.showError(this.folderError.message); return; }
        const {preparation, window} = this.directory;
        if (preparation) {
            const {completed = 0, total} = preparation;
            this.setFeedback('Preparing order…' + (total ? ` ${completed} / ${total}` : ''));
        } else if (this.facts?.errors.size) {
            this.setFeedback('Some file details could not be read.', true);
        } else {
            const failed = window.edges.find(edge => edge.failed);
            this.setFeedback(failed?.error || '', Boolean(failed));
        }
    }

    /** History stores this bookmark without knowing the grid's markup. */
    captureFocus(node) {
        if (node?.id) return {id: node.id};
        const card = node?.closest('.card');
        if (!card) return {id: this.viewport.id};
        const action = ['folder-overview', 'folder-view', 'list-name', 'picture', 'image-name']
            .find(name => node.classList.contains(name));
        return {path: card.dataset.path, type:card.dataset.type, selector: action ? '.' + action : '.card-caption a'};
    }

    restoreFocus(bookmark = {}) {
        if (bookmark.path) {
            this.focusPath = bookmark.path;
            this.focusType = bookmark.type;
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
        const position = {path: row.items?.[0].path ?? row.path, type:row.items?.[0].type, heading: !row.items,
            offset: top - row.top, rowHeight: row.height};
        if (!this.state.recursive && row.items) {
            // Original filtered order: next item wins ties with the previous one.
            position.neighbors = [];
            for (let distance = 1; distance <= RETURN_NEIGHBORS; distance++) {
                for (const index of [row.startIndex + distance, row.startIndex - distance]) {
                    if (this.items[index]) position.neighbors.push({path:this.items[index].path, type:this.items[index].type});
                }
            }
        }
        return position;
    }

    restore() {
        if (!this.restorePosition || this.loadingFolder) return;
        const {path, type, heading, offset, rowHeight} = this.restorePosition;
        let row = this.layout.byPath.get(heading ? 'heading:' + path : 'item:' + entryKey({path, type:type || ItemType.MEDIA}));
        if (!row && !this.state.recursive) {
            for (const neighbor of this.restorePosition.neighbors || []) {
                row = this.layout.byPath.get('item:' + entryKey(typeof neighbor === 'string' ? {path:neighbor, type:ItemType.MEDIA} : neighbor));
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
            row = this.layout.byPath.get('item:' + entryKey({path, type:ItemType.MEDIA}));
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
            this.focusType = bookmark.type;
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
        if (!this.state.recursive && this.directory?.listing.other_files.length) {
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
                this.showInfo(item.path, item.type);
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
        node.dataset.type = item.type;
        node.classList.toggle('selected-media', item.type === ItemType.MEDIA && this.state.selected === item.path);
        if (compact) this.renderListItem(node, item, scope);
        else this.renderPreview(node, item, scope);
        if (!this.state.recursive) {
            const name = node.querySelector('.list-name, .card-name');
            const label = element('div', 'item-label');
            const time = element('time', 'item-modified');
            time.dataset.fact = 'modified';
            name.before(label);
            label.append(name, time);
            if (compact) {
                const size = element('span', 'item-size');
                if (item.type === ItemType.FOLDER) setFactLabel(size, '—', 'Folder size is not calculated');
                else size.dataset.fact = 'size';
                label.append(size);
            }
            this.renderFacts(node, this.facts.state(item));
        }
        return node;
    }

    renderFacts(card, fact) {
        const time = card.querySelector('.item-modified');
        time.removeAttribute('datetime');
        if (fact.status !== 'ready') {
            const loading = fact.status === 'loading';
            const text = loading ? '…' : '—';
            const title = loading ? 'Loading file details' : fact.error.message;
            for (const field of card.querySelectorAll('[data-fact]')) setFactLabel(field, text, title);
            return;
        }
        const date = formatMetadataDate(fact.modified);
        setFactLabel(time, date || '—', date ? 'Modified: ' + date : 'Modified time unavailable');
        if (date) time.dateTime = timestampValue(fact.modified);
        const size = card.querySelector('[data-fact="size"]');
        if (size) {
            const text = formatBytes(fact.size);
            setFactLabel(size, text || '—', text ? `Size: ${fact.size.toLocaleString()} bytes` : 'Size unavailable');
        }
    }

    factsChanged(event) {
        if (!this.directory || !this.state?.active || this.loadingFolder) return;
        let orderChanged = false;
        for (const {node} of this.rowNodes.values()) for (const card of node.querySelectorAll('.card')) {
            if (!card.querySelector('.item-modified')) continue;
            const item = {path:card.dataset.path, type:card.dataset.type};
            const fact = this.facts.state(item);
            if (!this.data.matchesFacts(this.directory, item, fact)) orderChanged = true;
            if (!event?.stale) this.renderFacts(card, fact);
        }
        if ((event?.stale || orderChanged) && !this.folderError) {
            invalidateViews(this.directory.path);
            this.loadFolder(true, true);
            return;
        }
        this.updateFeedback();
        this.viewport.setAttribute('aria-busy', String(Boolean(this.directory.preparation || this.facts?.loading)));
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
            caption.append(name, this.folderActions(item.path));
        } else {
            name.classList.add('image-name');
            caption.append(name);
        }
        this.previews.thumbnail(picture, item.path, scope, item.type).catch(() => {
            if (!scope.signal.aborted) picture.textContent = 'Preview unavailable';
        });
        caption.title = item.path;
        node.append(picture, caption);
    }

    createRow(index) {
        const row = this.layout.rows[index];
        const node = element('div', 'grid-row');
        node.classList.toggle('compact-row', Boolean(row.compact));
        node.classList.toggle('folder-row', Boolean(row.folders));
        node.classList.toggle('heading-row', !row.items && !row.disclosure);
        positionRow(node, row);
        const scope = new TaskScope();
        if (row.items) row.items.forEach(item => node.append(this.createCard(
            item, scope, row.compact)));
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
            this.state.selected, row.items?.map(entryKey) ?? row.path]);
    }

    renderRows() {
        if (!this.state?.active) return;
        if (document.activeElement !== document.body && document.activeElement !== this.viewport) {
            this.focusPath = null;
            this.focusType = null;
            this.focusSelector = null;
        }
        this.restore();
        const top = this.viewport.scrollTop - this.gridOffset;
        const start = Math.max(0, top - OVERSCAN);
        const end = top + this.viewport.clientHeight + OVERSCAN;
        const [first, last] = this.layout.visibleRange(start, end);
        const wanted = [];
        for (const index of this.rowNodes.keys()) {
            const row = this.layout.rows[index];
            if (index < first || index >= last || !row || this.rowNodes.get(index).signature !== this.rowSignature(row)) this.removeRow(index);
            else positionRow(this.rowNodes.get(index).node, row);
        }
        for (let index = first; index < last; index++) {
            if (!this.rowNodes.has(index)) this.createRow(index);
            if (!this.state.recursive) wanted.push(...(this.layout.rows[index].items || []));
        }
        this.facts?.update(this.state.recursive ? [] : wanted);
        this.factsChanged();
        if (this.focusPath && this.state.active) {
            const item = [...this.container.querySelectorAll('.card')].find(node => node.dataset.path === this.focusPath && (!this.focusType || node.dataset.type === this.focusType));
            const target = item?.querySelector(this.focusSelector || '.list-name, .card-caption a, .image-name, button');
            (target || item?.querySelector('a, button'))?.focus({preventScroll: true});
            if (item || !this.loadingFolder) {
                if (!item) this.viewport.focus({preventScroll: true});
                this.focusPath = null;
                this.focusType = null;
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

    async loadFolder(force, retain = false) {
        this.scope?.dispose();
        this.facts?.dispose();
        if (this.directory?.path !== this.state.folder) this.othersOpen = false;
        const scope = this.scope = new TaskScope();
        this.loadingFolder = true;
        this.folderError = null;
        if (!retain) {
            this.facts = null;
            this.directory = null;
            this.clearRows();
            this.items = [];
            this.otherFiles = [];
            this.viewport.scrollTop = 0;
            this.relayout();
            this.status.textContent = '';
            this.summary.textContent = '';
        }
        this.setFeedback(retain ? 'Updating folder…' : 'Opening folder…');
        this.viewport.setAttribute('aria-busy', 'true');
        try {
            const completed = await this.data.open(this.state, scope.signal, force, directory => {
                if (scope.signal.aborted || retain) return;
                if (this.directory !== directory) { this.facts?.dispose(); this.facts = null; }
                this.directory = directory;
                this.rootName = directory.listing.root_name || 'Collection';
                this.loadingFolder = false;
                this.displayFolder();
            });
            scope.signal.throwIfAborted();
            if (retain || this.directory?.preparation) this.restorePosition = this.position();
            if (this.directory !== completed) { this.facts?.dispose(); this.facts = null; }
            this.directory = completed;
            this.rootName = this.directory.listing.root_name || 'Collection';
            this.folderLoaded(this.rootName);
            this.loadingFolder = false;
            this.displayFolder();
        } catch (error) {
            if (!scope.signal.aborted) {
                if (!retain) this.directory = null;
                this.folderError = error;
                this.showError(error.message);
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
        if (!this.state.recursive && !this.facts) {
            this.facts = new FactDemand(entries, this.directory.path, listing.revision,
                event => this.factsChanged(event));
        }
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
        this.updateFeedback();
        // Empty Browse feedback precedes the disclosure; Overview's end marker follows its grid.
        if (this.state.recursive) this.container.after(this.status);
        else this.container.before(this.status);
    }

    async loadPage(reverse = false) {
        if (!this.state.active || this.loadingFolder || this.loadingPage || !this.directory) return;
        const directory = this.directory;
        const scope = this.scope;
        if (!this.state.recursive) return;
        const edge = directory.window.edges[reverse ? 0 : 1];
        if (!directory.window.canLoad(edge)) return;
        const bookmark = this.position();
        const anchor = bookmark && !bookmark.heading ? bookmark.path : this.state.selected;
        const result = await this.data.load(directory, reverse, scope.signal, anchor);
        if (scope.signal.aborted) return;
        if (!result) {
            this.updateFeedback();
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
