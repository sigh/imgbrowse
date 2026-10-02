import {renderItemHeader} from './static/folder-path.js';
import {getInfo, refreshScope} from './static/api.js';
import {icon} from './static/icons.js';
import {originals} from './static/media-cache.js';
import {byId, element, setButtonLabel} from './static/dom.js';
import {FolderGrid} from './static/folder-grid.js';
import {ImageViewer} from './static/image-viewer.js';
import {PreviewLoader} from './static/preview-loader.js';
import {filename, imageSize, readState, stateUrl} from './static/state.js';

const FILTER_DELAY = 150;
const browseId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const screen = state => !state.viewing ? 'browse' : state.overview ? 'overview' : 'view';
const MODES = [
    {mode: 'browse', icon: 'folder', label: 'Browse', ids: ['browse-folder', 'viewer-close']},
    {mode: 'overview', icon: 'grid', label: 'Collection overview', ids: ['overview-folder', 'view-grid']},
    {mode: 'view', icon: 'play', label: 'View', ids: ['read-folder', 'viewer-read']},
];

function focusTarget(node) {
    if (node?.id) return {id: node.id};
    const card = node?.closest('.card');
    if (!card) return {id: 'grid-viewport'};
    const selector = ['list-read', 'list-name', 'picture', 'image-name'].find(name => node.classList.contains(name));
    return {path: card.dataset.path, selector: selector ? '.' + selector : '.card-caption button'};
}

/** Coordinates browser history and independent folder/reader views. */
class GalleryApp {
    constructor() {
        this.rootName = 'Collection';
        this.preferences = {
            layout: sessionStorage.getItem('readingLayout') === 'single' ? 'single' : 'strip',
            size: imageSize(sessionStorage.getItem('readingSize')),
        };
        this.buildNavigation();
        this.previews = new PreviewLoader(byId('grid-viewport'), byId('viewer'));
        this.grid = new FolderGrid(this.previews, {
            folderLink: (path, label) => this.folderLink(path, label),
            openViewer: (image, collection, opener) => this.openViewer(image, collection, opener),
            folderLoaded: name => this.folderLoaded(name),
            refresh: () => this.refresh(),
        });
        this.viewer = new ImageViewer(this.previews, {
            selectImage: (image, entry) => this.navigate({image}, true, entry),
            changeSize: size => this.changeSize(size),
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

    buildNavigation() {
        document.querySelectorAll('.mode-navigation').forEach((group, index) => {
            for (const {mode, icon: name, label, ids} of MODES) {
                const button = element('button');
                button.id = ids[index];
                button.dataset.mode = mode;
                button.dataset.icon = name;
                setButtonLabel(button, label);
                if (mode === 'browse') button.title = 'Browse (Escape)';
                group.append(button);
            }
        });
    }

    bindControls() {
        for (const button of document.querySelectorAll('[data-icon]')) {
            button.append(icon(button.dataset.icon));
        }
        for (const button of document.querySelectorAll('[data-layout]')) {
            button.addEventListener('click', () => this.navigate({compact: button.dataset.layout === 'list'}, true));
        }
        for (const button of document.querySelectorAll('[data-mode]')) {
            button.addEventListener('click', () => this.setMode(button.dataset.mode, button));
        }
        byId('view-strip').addEventListener('click', () => this.changeLayout(this.state.layout === 'strip' ? 'single' : 'strip'));
        this.grid.viewport.addEventListener('scroll', () => {
            clearTimeout(this.positionTimer);
            this.positionTimer = setTimeout(() => this.savePosition(), 120);
        });
        byId('filter').addEventListener('input', event => {
            const filter = event.target.value;
            clearTimeout(this.filterTimer);
            this.filterTimer = setTimeout(() => this.navigate({filter}, true), FILTER_DELAY);
        });
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

    readingOptions() {
        if (!this.state.viewing) return this.preferences;
        return {
            layout: this.state.overview ? history.state?.readingLayout || this.preferences.layout : this.state.layout,
            size: this.state.size,
        };
    }

    openViewer(image, collection, opener) {
        if (this.state.overview && image) {
            this.state = {...this.state, image};
            history.replaceState({...history.state, overviewImage: image}, '', stateUrl(this.state));
        }
        this.navigate({viewing: true, ...this.readingOptions(), overview: false, recursive: false, image, collection},
            false, 'top', opener);
    }

    closeViewer() {
        if (!this.state.viewing || this.returning) return;
        if (history.state?.browseOrigin) {
            // Every owned viewing entry records its distance from the opener.
            // Return reverses those entries; it never adds a synthetic close entry.
            this.returning = true;
            history.go(-history.state.viewerDepth);
        } else {
            // A bookmarked viewer has no owned Browse entry to traverse to.
            this.navigate({viewing: false, layout: 'strip', overview: false, recursive: false, image: null}, true);
        }
    }

    changeLayout(layout) {
        if (screen(this.state) !== 'view') return;
        this.preferences.layout = layout;
        sessionStorage.setItem('readingLayout', layout);
        this.navigate({layout}, true);
    }

    changeSize(size) {
        if (screen(this.state) !== 'view') return;
        this.preferences.size = imageSize(size);
        sessionStorage.setItem('readingSize', this.preferences.size);
        this.navigate({size: this.preferences.size}, true);
    }

    setMode(mode, opener) {
        if (mode === screen(this.state)) return;
        if (mode === 'browse') { this.closeViewer(); return; }
        const image = this.state.viewing ? this.state.image : history.state?.selection || null;
        const collection = this.state.viewing ? this.state.collection : this.state.folder;
        if (mode === 'view') { this.openViewer(image, collection, opener); return; }
        this.navigate({viewing: true, layout: 'grid', overview: true, recursive: true,
            collection, image, size: this.readingOptions().size}, false, 'top', opener);
    }

    updateControls() {
        for (const button of document.querySelectorAll('[data-mode]')) {
            button.setAttribute('aria-pressed', String(button.dataset.mode === screen(this.state)));
        }
        document.querySelector('.viewer-tools').hidden = screen(this.state) !== 'view';
        byId('view-strip').setAttribute('aria-pressed', String(this.state.layout === 'strip'));
    }

    navigate(changes, replace = false, entry = 'top', opener = document.activeElement) {
        clearTimeout(this.filterTimer);
        // Keep the text already entered in Browse when opening before debounce.
        if (!this.state.viewing && changes.viewing && byId('filter').value !== this.state.filter) {
            this.navigate({filter: byId('filter').value}, true);
        }
        this.savePosition();
        const next = {...this.state, ...changes};
        if (!replace && stateUrl(next) === stateUrl(this.state)) return;
        const sameFolder = next.folder === this.state.folder;
        const position = sameFolder ? history.state?.position : null;
        const selection = next.viewing ? next.image : sameFolder
            ? this.state.image || history.state?.selection || null : null;
        const sameCollection = next.collection === this.state.collection;
        const overviewPosition = sameFolder && sameCollection
            ? (this.state.overview ? this.grid.position() : history.state?.overviewPosition) : null;
        const overviewImage = sameCollection ? (this.state.overview ? next.image : history.state?.overviewImage) : null;
        const readingLayout = next.overview ? this.readingOptions().layout : next.layout;
        const metadata = {...history.state, position, selection, overviewPosition, overviewImage, readingLayout};
        if (next.viewing && !this.state.viewing) {
            metadata.browseOrigin = {id: history.state.browseId, focus: focusTarget(opener)};
            metadata.viewerDepth = 1;
        } else if (next.viewing && metadata.browseOrigin && !replace) {
            metadata.viewerDepth++;
        } else if (!next.viewing) {
            delete metadata.browseOrigin;
            delete metadata.viewerDepth;
            if (!sameFolder || this.state.viewing) metadata.browseId = browseId();
        }
        history[replace ? 'replaceState' : 'pushState'](metadata, '', stateUrl(next));
        if (this.state.viewing && next.viewing && !this.state.overview && !next.overview && sameFolder
            && next.recursive === this.state.recursive && next.compact === this.state.compact) {
            this.state = next;
            this.entry = metadata;
            this.updateControls();
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
        const origin = this.entry?.browseOrigin;
        this.state = readState();
        this.returning = false;
        let returningFocus;
        if (!this.state.viewing) {
            const returningToOrigin = previous?.viewing && origin?.id === history.state?.browseId;
            if (returningToOrigin) returningFocus = origin.focus;
            else if (previous?.viewing) returningFocus = {id: 'grid-viewport'};
            history.replaceState({...history.state, browseId: history.state?.browseId || browseId(),
                ...(returningToOrigin ? {selection: previous.image} : {})}, '');
        }
        this.entry = history.state;
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
        this.updateControls();
        let position = restore ? history.state?.position : null;
        if (overview) {
            position = history.state?.overviewImage === this.state.image ? history.state?.overviewPosition : null;
            if (!position && this.state.image) position = {path: this.state.image, offset: 0, reveal: true};
        }
        this.viewer.show(this.state, force, entry);
        if (overview) document.querySelector('.strip-frame').hidden = true;
        if (returningFocus?.path) {
            this.grid.focusPath = returningFocus.path;
            this.grid.focusSelector = returningFocus.selector;
        }
        this.grid.show(overview ? {...this.state, folder: this.state.collection, viewing: false, recursive: true, compact: false, filter: ''}
            : {...this.state, recursive: false}, force, position);
        if (overview && !previous?.overview) this.grid.viewport.focus({preventScroll: true});
        if (returningFocus?.path && this.grid.focusPath) this.grid.viewport.focus({preventScroll: true});
        if (returningFocus?.id) (byId(returningFocus.id) || this.grid.viewport).focus({preventScroll: true});
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
