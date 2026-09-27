import {getFolder, walkImages} from './api.js';
import {byId, element, TaskScope} from './dom.js';
import {GridLayout} from './grid-layout.js';
import {filename, joinPath} from './state.js';

const OVERSCAN = 230;
const DISCOVERY_MARGIN = 400;

/** Owns folder loading, incremental discovery, and the lifetime of visible rows. */
export class FolderGrid {
    constructor(previews, {folderLink, openViewer, folderLoaded}) {
        this.previews = previews;
        this.folderLink = folderLink;
        this.openViewer = openViewer;
        this.folderLoaded = folderLoaded;
        this.viewport = byId('grid-viewport');
        this.container = byId('grid');
        this.status = byId('grid-status');
        this.summary = byId('summary');
        this.moreButton = byId('load-more');
        this.layout = new GridLayout(this.viewport);
        this.rowNodes = new Map();
        this.items = [];
        this.key = null;
        this.rootName = 'Collection';
        this.done = true;
        this.loading = false;
        this.failed = false;
        this.scrollScheduled = false;
        this.viewport.addEventListener('scroll', () => this.scheduleRender());
        this.moreButton.addEventListener('click', () => this.loadPage());
        this.resizeObserver = new ResizeObserver(() => {
            if (!this.state) return;
            if (this.viewport.clientWidth !== this.layout.width) this.relayout();
            else this.renderRows();
        });
        this.resizeObserver.observe(this.viewport);
    }

    show(state, force = false) {
        this.state = state;
        this.viewport.inert = state.viewing;
        const key = JSON.stringify([state.folder, state.recursive, state.filter]);
        if (force || key !== this.key) {
            this.key = key;
            this.loadFolder();
        } else {
            this.scheduleRender();
        }
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
        entry.scope.dispose();
        entry.node.remove();
        this.rowNodes.delete(index);
    }

    clearRows() {
        for (const index of this.rowNodes.keys()) this.removeRow(index);
        this.previews.schedule();
    }

    relayout() {
        this.clearRows();
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

    createCard(item, scope) {
        const node = element('article', 'card');
        const isFolder = item.type === 'folder';
        const picture = isFolder ? this.folderLink(item.path, 'Folder') : element('button', '', 'Loading…');
        picture.className = 'picture';
        picture.setAttribute('aria-label', (isFolder ? 'Open folder ' : 'View image ') + filename(item.path));
        const caption = element('div', 'card-caption');
        let preview;
        if (isFolder) {
            const read = element('button', '', 'View ▶');
            read.title = 'View all images in ' + filename(item.path);
            read.addEventListener('click', () => this.openViewer(null, item.path));
            caption.append(this.folderLink(item.path, filename(item.path)), read);
            preview = this.previews.folder(picture, item.path, scope);
        } else {
            picture.addEventListener('click', () => this.openViewer(item.path, this.state.folder));
            caption.append(element('span', '', filename(item.path)));
            preview = this.previews.image(picture, item.path, scope);
        }
        preview.catch(error => {
            if (error.name !== 'AbortError') picture.textContent = 'Preview unavailable';
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
        else node.append(element('h2', 'folder-heading', row.label));
        this.container.append(node);
        this.rowNodes.set(index, {node, scope});
    }

    renderRows() {
        const start = Math.max(0, this.viewport.scrollTop - OVERSCAN);
        const end = this.viewport.scrollTop + this.viewport.clientHeight + OVERSCAN;
        const [first, last] = this.layout.visibleRange(start, end);
        for (const index of this.rowNodes.keys()) {
            if (index < first || index >= last) this.removeRow(index);
        }
        for (let index = first; index < last; index++) {
            if (!this.rowNodes.has(index)) this.createRow(index);
        }
        this.previews.schedule();
        const needsMore = end >= this.layout.height - DISCOVERY_MARGIN;
        if (needsMore && !this.done && !this.loading && !this.failed && !this.state.viewing) this.loadPage();
    }

    async loadFolder() {
        this.scope?.dispose();
        const scope = this.scope = new TaskScope();
        this.clearRows();
        this.items = [];
        this.done = true;
        this.loading = false;
        this.failed = false;
        this.warning = '';
        this.cursor = null;
        this.viewport.scrollTop = 0;
        this.relayout();
        this.status.textContent = 'Opening folder…';
        this.summary.textContent = '';
        this.moreButton.hidden = true;
        try {
            const listing = await getFolder(this.state.folder, scope.signal);
            scope.signal.throwIfAborted();
            this.rootName = listing.root_name || 'Collection';
            this.folderLoaded(this.rootName);
            if (this.state.recursive) {
                this.layout.rootName = this.rootName;
                this.done = false;
                // Opening a bookmarked image must not trigger background traversal.
                if (!this.state.viewing) this.loadPage();
                else this.status.textContent = '';
            } else {
                this.showListing(listing);
            }
        } catch (error) {
            if (error.name !== 'AbortError') this.status.textContent = error.message + ' — use Refresh to try again.';
        }
    }

    showListing(listing) {
        const filter = this.state.filter.toLocaleLowerCase();
        this.items = [
            ...listing.folders.map(name => ({type: 'folder', path: joinPath(this.state.folder, name)})),
            ...listing.images.map(name => ({type: 'image', path: joinPath(this.state.folder, name)})),
        ].filter(item => filename(item.path).toLocaleLowerCase().includes(filter));
        this.relayout();
        this.status.textContent = this.items.length ? '' : (filter
            ? 'No matching names.' : 'This folder is empty of visible folders and supported images.');
        this.summary.textContent = `${listing.folders.length} folders · ${listing.images.length} direct images`
            + (filter ? ` · ${this.items.length} matches` : '');
    }

    async loadPage() {
        if (this.loading || this.done) return;
        this.loading = true;
        this.failed = false;
        this.moreButton.hidden = true;
        this.status.textContent = 'Finding images…';
        const scope = this.scope;
        try {
            const result = await walkImages({root: this.state.folder, cursor: this.cursor}, scope.signal);
            scope.signal.throwIfAborted();
            const added = result.images.map(path => ({type: 'image', path}));
            this.items.push(...added);
            this.cursor = result.cursor;
            this.done = result.cursor === null;
            if (result.warnings.length) this.warning = 'Some folders could not be read.';
            this.appendRows(added);
            this.summary.textContent = this.items.length + (this.done ? ' images' : ' images discovered')
                + (this.warning ? ' · ' + this.warning : '');
            this.status.textContent = this.done ? (this.items.length ? 'End of folder' : 'No images found.') : '';
        } catch (error) {
            if (error.name !== 'AbortError') {
                this.failed = true;
                this.status.textContent = error.message;
                this.moreButton.hidden = false;
            }
        } finally {
            if (scope === this.scope) {
                this.loading = false;
                if (!this.failed) this.scheduleRender();
            }
        }
    }
}
