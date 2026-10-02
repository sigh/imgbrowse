import {renderItemHeader} from './static/folder-path.js';
import {getInfo, refreshScope} from './static/api.js';
import {icon} from './static/icons.js';
import {clearOriginals} from './static/media-cache.js';
import {byId, element, plainClick, setButtonLabel} from './static/dom.js';
import {FolderGrid} from './static/folder-grid.js';
import {ImageViewer} from './static/image-viewer.js';
import {PreviewLoader} from './static/preview-loader.js';
import {filename, imageSize, readState, stateUrl, ScreenMode, ReadingLayout, FolderLayout} from './static/state.js';

const FILTER_DELAY = 150;
const browseId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const MODES = [
    {mode: ScreenMode.BROWSE, icon: 'folder', label: 'Browse', ids: ['browse-folder', 'viewer-close']},
    {mode: ScreenMode.OVERVIEW, icon: 'grid', label: 'Collection overview', ids: ['overview-folder', 'view-grid']},
    {mode: ScreenMode.VIEW, icon: 'play', label: 'View', ids: ['read-folder', 'viewer-read']},
];

function focusTarget(node) {
    if (node?.id) return {id: node.id};
    const card = node?.closest('.card');
    if (!card) return {id: 'grid-viewport'};
    const selector = ['folder-overview', 'folder-view', 'list-name', 'picture', 'image-name'].find(name => node.classList.contains(name));
    return {path: card.dataset.path, selector: selector ? '.' + selector : '.card-caption a'};
}

/** Coordinates browser history and independent folder/reader views. */
class GalleryApp {
    constructor() {
        this.rootName = 'Collection';
        this.preferences = {
            layout: sessionStorage.getItem('readingLayout') === ReadingLayout.SINGLE ? ReadingLayout.SINGLE : ReadingLayout.STRIP,
            size: imageSize(sessionStorage.getItem('readingSize')),
        };
        this.buildNavigation();
        this.previews = new PreviewLoader(byId('grid-viewport'), byId('viewer'));
        this.grid = new FolderGrid(this.previews, {
            folderLink: (path, label) => this.folderLink(path, label),
            mediaLink: (image, collection, label, mode) => this.mediaLink(image, collection, label, mode),
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
                const button = element('a', 'control-link');
                button.id = ids[index];
                button.dataset.mode = mode;
                button.dataset.icon = name;
                setButtonLabel(button, label);
                if (mode === ScreenMode.BROWSE) button.title = 'Browse (Escape)';
                group.append(button);
            }
        });
    }

    bindControls() {
        for (const button of document.querySelectorAll('[data-icon]')) {
            button.append(icon(button.dataset.icon));
        }
        for (const button of document.querySelectorAll('[data-layout]')) {
            button.addEventListener('click', () => this.navigate({compact: button.dataset.layout === FolderLayout.LIST}, true));
        }
        for (const button of document.querySelectorAll('[data-mode]')) {
            button.addEventListener('click', event => {
                if (!plainClick(event)) return;
                event.preventDefault();
                this.setMode(button.dataset.mode, button);
            });
        }
        byId('view-strip').addEventListener('click', () => this.changeLayout(this.state.layout === ReadingLayout.STRIP ? ReadingLayout.SINGLE : ReadingLayout.STRIP));
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
            await refreshScope(this.state.mode !== ScreenMode.BROWSE ? this.state.collection : this.state.folder);
            clearOriginals();
            this.grid.cache.clear();
            this.render(true, true);
        } catch (error) {
            (this.state.mode !== ScreenMode.BROWSE ? this.viewer.status : this.grid.status).textContent = error.message;
        } finally {
            this.refreshing = false;
        }
    }

    savePosition() {
        clearTimeout(this.positionTimer);
        if (this.grid.loadingFolder || this.grid.restorePosition || !this.state || this.state.mode === ScreenMode.VIEW) return;
        const key = this.state.mode === ScreenMode.OVERVIEW ? 'overviewPosition' : 'position';
        history.replaceState({...history.state, [key]: this.grid.position(),
            ...(this.state.mode === ScreenMode.OVERVIEW ? {overviewImage: this.state.image} : {})}, '');
    }

    readingOptions() {
        if (this.state.mode === ScreenMode.BROWSE) return this.preferences;
        return {
            layout: this.state.mode === ScreenMode.OVERVIEW ? history.state?.readingLayout || this.preferences.layout : this.state.layout,
            size: this.state.size,
        };
    }

    openViewer(image, collection, opener) {
        if (this.state.mode === ScreenMode.OVERVIEW && image) {
            this.state = {...this.state, image};
            history.replaceState({...history.state, overviewImage: image}, '', stateUrl(this.state));
        }
        this.navigate(this.destination(ScreenMode.VIEW, image, collection),
            false, 'top', opener);
    }

    closeViewer() {
        if (this.state.mode === ScreenMode.BROWSE || this.returning) return;
        if (history.state?.browseOrigin) {
            // Every owned viewing entry records its distance from the opener.
            // Return reverses those entries; it never adds a synthetic close entry.
            this.returning = true;
            history.go(-history.state.viewerDepth);
        } else {
            // A bookmarked viewer has no owned Browse entry to traverse to.
            this.navigate({mode: ScreenMode.BROWSE, image: null}, true);
        }
    }

    changeLayout(layout) {
        if (this.state.mode !== ScreenMode.VIEW) return;
        this.preferences.layout = layout;
        sessionStorage.setItem('readingLayout', layout);
        this.navigate({layout}, true);
    }

    changeSize(size) {
        if (this.state.mode !== ScreenMode.VIEW) return;
        this.preferences.size = imageSize(size);
        sessionStorage.setItem('readingSize', this.preferences.size);
        this.navigate({size: this.preferences.size}, true);
    }

    setMode(mode, opener) {
        if (mode === this.state.mode) return;
        if (mode === ScreenMode.BROWSE) { this.closeViewer(); return; }
        const image = this.state.mode !== ScreenMode.BROWSE ? this.state.image : history.state?.selection || null;
        const collection = this.state.mode !== ScreenMode.BROWSE ? this.state.collection : this.state.folder;
        if (mode === ScreenMode.VIEW) { this.openViewer(image, collection, opener); return; }
        this.openOverview(collection, opener, image);
    }

    destination(mode, image, collection) {
        return {...this.state, ...this.readingOptions(), mode,
            image: mode === ScreenMode.BROWSE ? null : image, collection};
    }

    openOverview(collection, opener, image = null) {
        this.navigate(this.destination(ScreenMode.OVERVIEW, image, collection), false, 'top', opener);
    }

    mediaLink(image, collection, label, mode = ScreenMode.VIEW) {
        const link = element('a', 'control-link', label);
        link.href = stateUrl(this.destination(mode, image, collection));
        link.addEventListener('click', event => {
            if (!plainClick(event)) return;
            event.preventDefault();
            if (mode === ScreenMode.OVERVIEW) this.openOverview(collection, link, image);
            else this.openViewer(image, collection, link);
        });
        return link;
    }

    updateControls() {
        for (const button of document.querySelectorAll('[data-mode]')) {
            button.setAttribute('aria-current', button.dataset.mode === this.state.mode ? 'page' : 'false');
            button.href = button.dataset.mode === ScreenMode.BROWSE && history.state?.browseOrigin?.url
                ? history.state.browseOrigin.url
                : stateUrl(this.destination(button.dataset.mode,
                    this.state.mode !== ScreenMode.BROWSE ? this.state.image : history.state?.selection || null,
                    this.state.mode !== ScreenMode.BROWSE ? this.state.collection : this.state.folder));
        }
        document.querySelector('.viewer-tools').hidden = this.state.mode !== ScreenMode.VIEW;
        byId('view-strip').setAttribute('aria-pressed', String(this.state.layout === ReadingLayout.STRIP));
    }

    /** Calculate return context without writing history or updating the views. */
    historyEntry(next, replace, opener) {
        const sameFolder = next.folder === this.state.folder;
        const position = sameFolder ? history.state?.position : null;
        const selection = next.mode !== ScreenMode.BROWSE ? next.image : sameFolder
            ? this.state.image || history.state?.selection || null : null;
        const sameCollection = next.collection === this.state.collection;
        const overviewPosition = sameFolder && sameCollection
            ? (this.state.mode === ScreenMode.OVERVIEW ? this.grid.position() : history.state?.overviewPosition) : null;
        const overviewImage = sameCollection ? (this.state.mode === ScreenMode.OVERVIEW ? next.image : history.state?.overviewImage) : null;
        const readingLayout = next.mode === ScreenMode.OVERVIEW ? this.readingOptions().layout : next.layout;
        const metadata = {...history.state, position, selection, overviewPosition, overviewImage, readingLayout};
        if (next.mode !== ScreenMode.BROWSE && this.state.mode === ScreenMode.BROWSE) {
            metadata.browseOrigin = {id: history.state.browseId, focus: focusTarget(opener), url: location.pathname + location.search};
            metadata.viewerDepth = 1;
        } else if (next.mode !== ScreenMode.BROWSE && metadata.browseOrigin && !replace) {
            metadata.viewerDepth++;
        } else if (next.mode === ScreenMode.BROWSE) {
            delete metadata.browseOrigin;
            delete metadata.viewerDepth;
            if (!sameFolder || this.state.mode !== ScreenMode.BROWSE) metadata.browseId = browseId();
        }
        return metadata;
    }

    navigate(changes, replace = false, entry = 'top', opener = document.activeElement) {
        clearTimeout(this.filterTimer);
        // Keep the text already entered in Browse when opening before debounce.
        if (this.state.mode === ScreenMode.BROWSE && (changes.mode && changes.mode !== ScreenMode.BROWSE) && byId('filter').value !== this.state.filter) {
            this.navigate({filter: byId('filter').value}, true);
        }
        this.savePosition();
        const next = {...this.state, ...changes};
        if (!replace && stateUrl(next) === stateUrl(this.state)) return;
        const metadata = this.historyEntry(next, replace, opener);
        history[replace ? 'replaceState' : 'pushState'](metadata, '', stateUrl(next));
        if (this.state.mode === ScreenMode.VIEW && next.mode === ScreenMode.VIEW && next.folder === this.state.folder
            && next.compact === this.state.compact) {
            this.state = next;
            this.entry = metadata;
            this.updateControls();
            this.viewer.show(next, false, entry);
        } else this.render(false, true, entry);
    }

    folderLink(path, label) {
        const changes = {folder: path, collection: path, mode: ScreenMode.BROWSE, image: null, filter: ''};
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
            folder: this.state.folder, rootName: this.rootName, compact: this.state.compact,
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
        if (this.state.mode === ScreenMode.BROWSE) {
            const returningToOrigin = (previous && previous.mode !== ScreenMode.BROWSE) && origin?.id === history.state?.browseId;
            if (returningToOrigin) returningFocus = origin.focus;
            else if ((previous && previous.mode !== ScreenMode.BROWSE)) returningFocus = {id: 'grid-viewport'};
            history.replaceState({...history.state, browseId: history.state?.browseId || browseId(),
                ...(returningToOrigin ? {selection: previous.image} : {})}, '');
        }
        this.entry = history.state;
        for (const button of document.querySelectorAll('[data-layout]')) {
            button.setAttribute('aria-pressed', String((button.dataset.layout === FolderLayout.LIST) === this.state.compact));
        }
        byId('filter').value = this.state.filter;
        document.querySelector('.toolbar').inert = this.state.mode !== ScreenMode.BROWSE;
        document.querySelector('.app-header').inert = this.state.mode !== ScreenMode.BROWSE;
        if (force || !previous || previous.folder !== this.state.folder || previous.compact !== this.state.compact) this.renderBreadcrumbs();
        const overview = this.state.mode === ScreenMode.OVERVIEW;
        const host = byId('overview');
        if (overview && this.grid.viewport.parentNode !== host) {
            host.append(this.grid.viewport, byId('summary'));
        } else if (!overview && this.grid.viewport.parentNode !== document.body) {
            document.body.insertBefore(this.grid.viewport, byId('viewer'));
            document.body.insertBefore(byId('summary'), byId('viewer'));
        }
        this.previews.setViewerOpen(this.state.mode !== ScreenMode.BROWSE);
        this.grid.viewport.hidden = this.state.mode === ScreenMode.VIEW;
        byId('summary').hidden = this.state.mode === ScreenMode.VIEW;
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
        const gridState = {folder: overview ? this.state.collection : this.state.folder,
            active: this.state.mode !== ScreenMode.VIEW, recursive: overview,
            compact: overview ? false : this.state.compact, filter: overview ? '' : this.state.filter,
            selected: overview ? this.state.image : null};
        this.grid.show({...gridState, linkPresentation: JSON.stringify(this.readingOptions())}, force, position);
        if (overview && !(previous?.mode === ScreenMode.OVERVIEW)) this.grid.viewport.focus({preventScroll: true});
        if (returningFocus?.path && this.grid.focusPath) this.grid.viewport.focus({preventScroll: true});
        if (returningFocus?.id) (byId(returningFocus.id) || this.grid.viewport).focus({preventScroll: true});
    }
}

// A browser reload must refresh server snapshots as well as browser resources.
let reloadError;
if (performance.getEntriesByType('navigation')[0]?.type === 'reload') {
    const state = readState();
    try { await refreshScope(state.mode !== ScreenMode.BROWSE ? state.collection : state.folder); }
    catch (error) { reloadError = error; }
}
export const app = new GalleryApp();
if (reloadError) (app.state.mode !== ScreenMode.BROWSE ? app.viewer.status : app.grid.status).textContent = reloadError.message;
