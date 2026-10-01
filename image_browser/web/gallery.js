import {renderItemHeader} from './static/folder-path.js';
import {getInfo, refreshScope} from './static/api.js';
import {icon} from './static/icons.js';
import {originals} from './static/media-cache.js';
import {byId, element} from './static/dom.js';
import {FolderGrid} from './static/folder-grid.js';
import {ImageViewer} from './static/image-viewer.js';
import {PreviewLoader} from './static/preview-loader.js';
import {filename, revealInBrowse, readState, stateUrl} from './static/state.js';

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
            changeLayout: layout => this.changeLayout(layout),
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
        for (const [id, name] of [['read-folder', 'play'], ['viewer-close', 'back'], ['layout-previews', 'previews'], ['layout-list', 'list']]) {
            byId(id).append(icon(name));
        }
        for (const button of document.querySelectorAll('[data-layout]')) {
            button.addEventListener('click', () => this.navigate({compact: button.dataset.layout === 'list'}, true));
        }
        for (const [id, name, layout] of [['view-grid', 'grid', 'grid'], ['view-strip', 'thumbnails', 'strip'], ['view-single', 'image', 'single']]) {
            byId(id).append(icon(name));
            byId(id).addEventListener('click', () => this.changeLayout(layout));
        }
        this.grid.viewport.addEventListener('scroll', () => {
            clearTimeout(this.positionTimer);
            this.positionTimer = setTimeout(() => this.savePosition(), 120);
        });
        byId('filter').addEventListener('input', event => {
            const filter = event.target.value;
            clearTimeout(this.filterTimer);
            this.filterTimer = setTimeout(() => this.navigate({filter}, true), FILTER_DELAY);
        });
        byId('read-folder').addEventListener('click', event => this.openViewer(history.state?.selection || null, this.state.folder, event.currentTarget));
        window.addEventListener('popstate', () => this.render(false, true));
    }

    async refresh() {
        if (this.refreshing) return;
        this.refreshing = true;
        this.savePosition();
        try {
            await refreshScope(this.state.viewing ? this.state.collection : this.state.folder);
            originals.clear();
            this.grid.cache.clear();
            this.render(true, true);
        } catch (error) {
            (this.state.viewing ? this.viewer.status : this.grid.status).textContent = error.message;
        } finally {
            this.refreshing = false;
        }
    }

    savePosition() {
        clearTimeout(this.positionTimer);
        if (this.grid.loadingFolder || this.grid.restorePosition || !this.state || (this.state.viewing && !this.state.overview)) return;
        const key = this.state.overview ? 'overviewPosition' : 'position';
        history.replaceState({...history.state, [key]: this.grid.position(),
            ...(this.state.overview ? {overviewImage: this.state.image} : {})}, '');
    }

    openViewer(image, collection, opener) {
        if (this.state.overview && image) {
            this.state = {...this.state, image};
            history.replaceState({...history.state, overviewImage: image}, '', stateUrl(this.state));
        }
        this.viewer.openingFocus = opener || document.activeElement;
        const changes = {viewing: true, layout: 'strip', overview: false, recursive: false, image, collection, folder: collection, size: this.readingSize};
        if (collection !== this.state.folder) changes.filter = '';
        this.navigate(changes);
    }

    closeViewer() {
        if (this.state.viewing) this.navigate({viewing: false, overview: false, recursive: false, image: null});
    }

    changeLayout(layout) {
        const overview = layout === 'grid';
        this.navigate({layout, overview, recursive: overview});
    }

    updateLayoutButtons() {
        for (const layout of ['grid', 'strip', 'single']) {
            byId('view-' + layout).setAttribute('aria-pressed', String(this.state.layout === layout));
        }
    }

    navigate(changes, replace = false, entry = 'top') {
        clearTimeout(this.filterTimer);
        this.savePosition();
        let next = {...this.state, ...changes};
        if (!replace && stateUrl(next) === stateUrl(this.state)) return;
        const sameFolder = next.folder === this.state.folder;
        let position = sameFolder ? (this.state.overview ? history.state?.position : this.grid.position()) : null;
        const selection = next.viewing ? next.image : sameFolder
            ? this.state.image || history.state?.selection || null : null;
        if (this.state.viewing && !next.viewing) {
            ({state: next, position} = revealInBrowse(next, this.state.image));
        }
        const overviewPosition = sameFolder ? (this.state.overview ? this.grid.position() : history.state?.overviewPosition) : null;
        const overviewImage = this.state.overview ? next.image : history.state?.overviewImage;
        const metadata = {position, selection, overviewPosition, overviewImage};
        history[replace ? 'replaceState' : 'pushState'](metadata, '', stateUrl(next));
        if (this.state.viewing && next.viewing && !this.state.overview && !next.overview && sameFolder
            && next.recursive === this.state.recursive && next.compact === this.state.compact) {
            this.state = next;
            this.readingSize = next.size;
            this.updateLayoutButtons();
            this.viewer.show(next, false, entry);
        } else this.render(false, true, entry);
    }

    folderLink(path, label) {
        const changes = {folder: path, collection: path, viewing: false, layout: 'strip', overview: false, recursive: false, image: null, filter: ''};
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
        renderItemHeader(byId('browse-location'), byId('browse-actions'), {
            folder: this.state.folder, rootName: this.rootName,
            folderLink: (path, name) => this.folderLink(path, name),
        });
    }

    render(force = false, restore = false, entry = 'top') {
        clearTimeout(this.filterTimer);
        const previous = this.state;
        this.state = readState();
        if (previous?.viewing && !this.state.viewing && previous.folder === this.state.folder) {
            const result = revealInBrowse(this.state, previous.image);
            this.state = result.state;
            const position = result.position;
            history.replaceState({...history.state, position, selection: previous.image}, '', stateUrl(this.state));
        }
        if (this.state.viewing) this.readingSize = this.state.size;
        for (const button of document.querySelectorAll('[data-layout]')) {
            button.setAttribute('aria-pressed', String((button.dataset.layout === 'list') === this.state.compact));
        }
        byId('filter').value = this.state.filter;
        document.querySelector('.toolbar').inert = this.state.viewing;
        document.querySelector('.app-header').inert = this.state.viewing;
        this.renderBreadcrumbs();
        const overview = this.state.viewing && this.state.overview;
        const host = byId('overview');
        if (overview) {
            host.append(this.grid.viewport, byId('summary'));
        } else {
            document.body.insertBefore(this.grid.viewport, byId('viewer'));
            document.body.insertBefore(byId('summary'), byId('viewer'));
        }
        this.previews.setViewerOpen(this.state.viewing);
        host.hidden = !overview;
        byId('viewer-stage').hidden = overview;
        this.updateLayoutButtons();
        let position = restore ? history.state?.position : null;
        if (overview) {
            position = history.state?.overviewImage === this.state.image ? history.state?.overviewPosition : null;
            if (!position && this.state.image) position = {path: this.state.image, offset: 0, reveal: true};
        }
        this.viewer.show(this.state, force, entry);
        if (overview) document.querySelector('.strip-frame').hidden = true;
        this.grid.show(overview ? {...this.state, folder: this.state.collection, viewing: false, recursive: true, compact: false, filter: ''}
            : {...this.state, recursive: false}, force, position);
    }
}

// A browser reload must refresh server snapshots as well as browser resources.
let reloadError;
if (performance.getEntriesByType('navigation')[0]?.type === 'reload') {
    const state = readState();
    try { await refreshScope(state.viewing ? state.collection : state.folder); }
    catch (error) { reloadError = error; }
}
export const app = new GalleryApp();
if (reloadError) (app.state.viewing ? app.viewer.status : app.grid.status).textContent = reloadError.message;
