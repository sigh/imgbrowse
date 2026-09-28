import {getInfo, refreshScope} from './static/api.js';
import {originals} from './static/media-cache.js';
import {byId, element} from './static/dom.js';
import {FolderGrid} from './static/folder-grid.js';
import {ImageViewer} from './static/image-viewer.js';
import {PreviewLoader} from './static/preview-loader.js';
import {filename, joinPath, readState, stateUrl} from './static/state.js';

const FILTER_DELAY = 150;

/** Coordinates browser history and independent folder/reader views. */
class GalleryApp {
    constructor() {
        this.rootName = 'Collection';
        this.readingSize = 'page';
        this.previews = new PreviewLoader(byId('grid-viewport'), byId('viewer'));
        this.grid = new FolderGrid(this.previews, {
            folderLink: (path, label) => this.folderLink(path, label),
            openViewer: (image, collection, opener) => this.openViewer(image, collection, opener),
            folderLoaded: name => this.folderLoaded(name),
            refresh: () => this.refresh(),
        });
        this.viewer = new ImageViewer(this.previews, {
            selectImage: (image, entry) => this.navigate({image}, true, entry),
            changeSize: size => this.navigate({size}, true),
            close: () => this.closeViewer(),
            refresh: () => this.refresh(),
            folderLink: (path, label) => this.folderLink(path, label),
        });
        history.scrollRestoration = 'manual';
        this.bindControls();
        this.render(false, true);
        getInfo().then(info => this.folderLoaded(info.root_name)).catch(() => {});
    }

    bindControls() {
        for (const button of document.querySelectorAll('[data-layout]')) {
            button.addEventListener('click', () => this.navigate({compact: button.dataset.layout === 'list'}));
        }
        byId('scope-all').addEventListener('click', () => this.navigate({recursive: !this.state.recursive}));
        this.grid.viewport.addEventListener('scroll', () => {
            clearTimeout(this.positionTimer);
            this.positionTimer = setTimeout(() => this.savePosition(), 120);
        });
        byId('filter').addEventListener('input', event => {
            const filter = event.target.value;
            clearTimeout(this.filterTimer);
            this.filterTimer = setTimeout(() => this.navigate({filter}, true), FILTER_DELAY);
        });
        byId('refresh').addEventListener('click', () => this.refresh());
        byId('read-folder').addEventListener('click', event => this.openViewer(null, this.state.folder, event.currentTarget));
        window.addEventListener('popstate', () => this.render(false, true));
    }

    async refresh() {
        if (this.refreshing) return;
        this.refreshing = true;
        byId('refresh').disabled = true;
        this.savePosition();
        try {
            await refreshScope(this.state.viewing ? this.state.collection : this.state.folder);
            originals.clear();
            this.grid.cache.clear();
            if (this.state.viewing) this.viewer.show(this.state, true);
            else this.render(true, true);
        } catch (error) {
            (this.state.viewing ? this.viewer.status : this.grid.status).textContent = error.message;
        } finally {
            this.refreshing = false;
            if (!this.grid.loadingFolder) byId('refresh').disabled = false;
        }
    }

    savePosition() {
        clearTimeout(this.positionTimer);
        if (this.grid.loadingFolder || this.grid.restorePosition || !this.state) return;
        history.replaceState({...history.state, position: this.grid.position()}, '');
    }

    openViewer(image, collection, opener) {
        this.viewer.openingFocus = opener || document.activeElement;
        this.navigate({viewing: true, image, collection, size: this.readingSize});
    }

    closeViewer() {
        if (!this.state.viewing || this.closing) return;
        clearTimeout(this.filterTimer);
        if (history.state?.openedFromGrid) {
            this.closing = true;
            history.back();
        } else {
            // A direct viewer URL has no app-owned grid entry to go back to.
            this.navigate({viewing: false, image: null}, true);
        }
    }

    navigate(changes, replace = false, entry = 'top') {
        clearTimeout(this.filterTimer);
        this.savePosition();
        const next = {...this.state, ...changes};
        if (!replace && stateUrl(next) === stateUrl(this.state)) return;
        const opening = next.viewing && !this.state.viewing;
        const sameFolder = next.folder === this.state.folder;
        let position = sameFolder ? this.grid.position() : null;
        if (this.state.viewing && !next.viewing && this.state.image) {
            const relative = this.state.image.slice(next.folder ? next.folder.length + 1 : 0);
            const path = next.recursive ? this.state.image : joinPath(next.folder, relative.split('/')[0]);
            position = {path, offset: 0};
        }
        const metadata = {
            position,
            openedFromGrid: opening || (next.viewing && Boolean(history.state?.openedFromGrid)),
        };
        history[replace ? 'replaceState' : 'pushState'](metadata, '', stateUrl(next));
        if (this.state.viewing && next.viewing && sameFolder
            && next.recursive === this.state.recursive && next.compact === this.state.compact) {
            this.state = next;
            this.readingSize = next.size;
            this.viewer.show(next, false, entry);
        } else this.render(false, true, entry);
    }

    folderLink(path, label) {
        const changes = {folder: path, viewing: false, image: null, filter: ''};
        const link = element('a', '', label);
        link.href = stateUrl({...this.state, ...changes});
        link.addEventListener('click', event => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            this.navigate(changes);
        });
        return link;
    }

    folderLoaded(name) {
        this.rootName = name;
        document.title = (filename(this.state.folder) || name) + ' · Image Browser';
        this.viewer.setRootName(name);
        this.renderBreadcrumbs();
    }

    renderBreadcrumbs() {
        const breadcrumbs = byId('breadcrumbs');
        breadcrumbs.replaceChildren();
        const parts = [{path: '', name: this.rootName}];
        let path = '';
        for (const name of this.state.folder.split('/').filter(Boolean)) {
            path = joinPath(path, name);
            parts.push({path, name});
        }
        parts.forEach((part, index) => {
            if (index) breadcrumbs.append(element('span', '', '/'));
            const node = index === parts.length - 1 ? element('span', '', part.name) : this.folderLink(part.path, part.name);
            if (index === parts.length - 1) node.setAttribute('aria-current', 'page');
            breadcrumbs.append(node);
        });
    }

    render(force = false, restore = false, entry = 'top') {
        clearTimeout(this.filterTimer);
        this.closing = false;
        this.state = readState();
        if (this.state.viewing) this.readingSize = this.state.size;
        for (const button of document.querySelectorAll('[data-layout]')) {
            button.setAttribute('aria-pressed', String((button.dataset.layout === 'list') === this.state.compact));
        }
        byId('scope-all').setAttribute('aria-pressed', String(this.state.recursive));
        byId('scope-note').hidden = !this.state.recursive;
        byId('filter').value = this.state.filter;
        byId('filter').hidden = this.state.recursive;
        byId('filter-note').hidden = !this.state.recursive;
        document.querySelector('.toolbar').inert = this.state.viewing;
        document.querySelector('.app-header').inert = this.state.viewing;
        this.renderBreadcrumbs();
        this.previews.setViewerOpen(this.state.viewing);
        this.grid.show(this.state, force, restore ? history.state?.position : null);
        this.viewer.show(this.state, force, entry);
    }
}

export const app = new GalleryApp();
