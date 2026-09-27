import {byId, element} from './static/dom.js';
import {FolderGrid} from './static/folder-grid.js';
import {ImageViewer} from './static/image-viewer.js';
import {PreviewLoader} from './static/preview-loader.js';
import {filename, joinPath, readState, stateUrl} from './static/state.js';

const FILTER_DELAY = 200;

/** Coordinates URL navigation and the two views; each view owns its own work. */
class GalleryApp {
    constructor() {
        this.rootName = 'Collection';
        this.previews = new PreviewLoader(byId('grid-viewport'), byId('viewer'));
        this.grid = new FolderGrid(this.previews, {
            folderLink: (path, label) => this.folderLink(path, label),
            openViewer: (image, collection) => this.navigate({viewing: true, image, collection}),
            folderLoaded: name => this.folderLoaded(name),
        });
        this.viewer = new ImageViewer(this.previews, {
            selectImage: image => this.navigate({image}, true),
            close: () => this.navigate({viewing: false, image: null}),
        });
        history.scrollRestoration = 'manual';
        this.bindControls();
        this.render();
    }

    bindControls() {
        byId('compact').addEventListener('change', event => this.navigate({compact: event.target.checked}));
        this.grid.viewport.addEventListener('scroll', () => {
            if (this.grid.restoreTop == null) this.savePosition();
        });
        byId('recursive').addEventListener('change', event => this.navigate({recursive: event.target.checked}));
        byId('filter').addEventListener('input', event => {
            const filter = event.target.value;
            clearTimeout(this.filterTimer);
            this.filterTimer = setTimeout(() => this.navigate({filter}, true), FILTER_DELAY);
        });
        byId('refresh').addEventListener('click', () => this.render(true));
        byId('read-folder').addEventListener('click', () => {
            this.navigate({viewing: true, image: null, collection: this.state.folder});
        });
        window.addEventListener('popstate', () => this.render());
    }

    savePosition() {
        history.replaceState({...history.state, gridTop: this.grid.viewport.scrollTop}, '');
    }

    navigate(changes, replace = false) {
        clearTimeout(this.filterTimer);
        this.savePosition();
        const next = {...this.state, ...changes};
        const sameGrid = ['folder', 'recursive', 'filter', 'compact'].every(key => next[key] === this.state[key]);
        const position = sameGrid ? history.state : {gridTop: 0};
        const url = stateUrl(next);
        history[replace ? 'replaceState' : 'pushState'](position, '', url);
        this.render();
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
        breadcrumbs.replaceChildren(this.folderLink('', this.rootName));
        let path = '';
        for (const name of this.state.folder.split('/').filter(Boolean)) {
            path = joinPath(path, name);
            breadcrumbs.append(element('span', '', '/'), this.folderLink(path, name));
        }
    }

    render(force = false) {
        clearTimeout(this.filterTimer);
        this.state = readState();
        byId('compact').checked = this.state.compact;
        byId('recursive').checked = this.state.recursive;
        const filter = byId('filter');
        filter.value = this.state.filter;
        filter.disabled = this.state.recursive;
        filter.placeholder = this.state.recursive
            ? 'Name filtering is available in folder view' : 'Filter this folder by name';
        document.querySelector('.toolbar').inert = this.state.viewing;
        document.querySelector('.app-header').inert = this.state.viewing;
        this.renderBreadcrumbs();
        this.previews.setViewerOpen(this.state.viewing);
        this.grid.show(this.state, force, history.state?.gridTop || 0);
        this.viewer.show(this.state, force);
    }
}

new GalleryApp();
