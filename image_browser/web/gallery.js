import {ItemHeader} from './static/item-header.js';
import {getInfo, refreshScope} from './static/api.js';
import {icon} from './static/icons.js';
import {clearOriginals} from './static/media-cache.js';
import {byId, element, bindNavigation} from './static/dom.js';
import {FolderGrid} from './static/folder-grid.js';
import {FolderTree} from './static/folder-tree.js';
import {ImageViewer} from './static/image-viewer.js';
import {closeMetadata} from './static/metadata.js';
import {PreviewLoader} from './static/preview-loader.js';
import {SortControls} from './static/sort-controls.js';
import {currentFolder, filename, imageSize, readingLayout, readState, stateUrl, ScreenMode, ReadingLayout, FolderLayout, sortSettings, sortKey} from './static/state.js';

const FILTER_DELAY = 150;

function focusTarget(node) {
    if (node?.id) return {id: node.id};
    const card = node?.closest('.card');
    if (!card) return {id: 'grid-viewport'};
    const selector = ['folder-overview', 'folder-view', 'list-name', 'picture', 'image-name'].find(name => node.classList.contains(name));
    return {path: card.dataset.path, selector: selector ? '.' + selector : '.card-caption a'};
}

/** Coordinates browser history and presentation of the current folder. */
class GalleryApp {
    constructor() {
        this.rootName = 'Collection';
        this.preferences = {
            layout: readingLayout(sessionStorage.getItem('readingLayout')),
            size: imageSize(sessionStorage.getItem('readingSize')),
        };
        this.previews = new PreviewLoader(byId('grid-viewport'), byId('viewer'));
        this.header = new ItemHeader(byId('item-location'), byId('item-actions'), (path, label) => this.folderLink(path, label));
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
            close: () => this.setMode(ScreenMode.BROWSE),
            refresh: () => this.refresh(),
            renderHeader: options => this.header.update({...options, ...sortSettings(this.state)}),
        });
        this.tree = new FolderTree({
            destination: path => stateUrl(this.treeDestination(path)),
            select: (path, opener) => this.navigate(this.treeDestination(path), false, 'top', opener),
            closeTransient: closeMetadata,
        });
        history.scrollRestoration = 'manual';
        this.sortControls = new SortControls(byId('sort-popover'), changes => this.navigate(changes));
        this.bindControls();
        this.render(false, true);
        this.tree.setOpen(!this.tree.narrow.matches && sessionStorage.getItem('foldersOpen') === '1', false);
        getInfo().then(info => this.folderLoaded(info.root_name)).catch(() => {});
    }

    bindControls() {
        for (const button of document.querySelectorAll('[data-icon]')) {
            button.append(icon(button.dataset.icon));
        }
        for (const button of document.querySelectorAll('[data-layout]')) {
            button.addEventListener('click', () => this.navigate({compact: button.dataset.layout === FolderLayout.LIST}, true));
        }
        for (const button of document.querySelectorAll('[data-mode]')) {
            bindNavigation(button, () => this.setMode(button.dataset.mode, button));
        }
        for (const link of document.querySelectorAll('[data-reading-layout]')) {
            bindNavigation(link, () => this.changeLayout(link.dataset.readingLayout, link));
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
        window.addEventListener('popstate', () => this.render(false, true));
    }

    async refresh() {
        if (this.refreshing) return;
        this.refreshing = true;
        this.savePosition();
        try {
            await refreshScope(currentFolder(this.state));
            clearOriginals();
            this.grid.cache.clear();
            this.tree.refresh();
            this.render(true, true);
        } catch (error) {
            (this.state.mode !== ScreenMode.BROWSE ? this.viewer.status : this.grid.status).textContent = error.message;
        } finally {
            this.refreshing = false;
        }
    }

    savePosition(opener) {
        clearTimeout(this.positionTimer);
        if (this.grid.loadingFolder || this.grid.restorePosition || !this.state || this.state.mode === ScreenMode.VIEW) return;
        const key = this.state.mode === ScreenMode.OVERVIEW ? 'overviewPosition' : 'position';
        history.replaceState({...history.state, [key]: this.grid.position(),
            ...(opener && this.state.mode === ScreenMode.BROWSE ? {focus: focusTarget(opener)} : {}),
            ...(this.state.mode === ScreenMode.OVERVIEW ? {overviewImage: this.state.image} : {})}, '');
    }

    readingOptions() {
        if (this.state.mode === ScreenMode.BROWSE) return this.preferences;
        return {
            layout: this.state.mode === ScreenMode.OVERVIEW ? history.state?.readingLayout || this.preferences.layout : this.state.layout,
            size: this.state.size,
        };
    }

    changeLayout(layout, opener = document.activeElement) {
        this.preferences.layout = layout;
        sessionStorage.setItem('readingLayout', layout);
        this.navigate({...this.modeDestination(ScreenMode.VIEW), layout}, this.state.mode === ScreenMode.VIEW, 'top', opener);
    }

    changeSize(size) {
        if (this.state.mode !== ScreenMode.VIEW) return;
        this.preferences.size = imageSize(size);
        sessionStorage.setItem('readingSize', this.preferences.size);
        this.navigate({size: this.preferences.size}, true);
    }

    setMode(mode, opener) {
        if (mode === this.state.mode) return;
        this.navigate(this.modeDestination(mode), false, 'top', opener);
    }

    modeDestination(mode) {
        const image = this.state.mode !== ScreenMode.BROWSE ? this.state.image : history.state?.selection || null;
        return this.destination(mode, image, currentFolder(this.state));
    }

    destination(mode, image, collection) {
        const filter = this.state.mode === ScreenMode.BROWSE ? byId('filter').value : this.state.filter;
        return {...this.state, ...this.readingOptions(), mode, folder: collection,
            filter: collection === this.state.folder ? filter : '',
            image: mode === ScreenMode.BROWSE ? null : image, collection};
    }

    mediaLink(image, collection, label, mode = ScreenMode.VIEW) {
        return this.navigationLink(() => this.destination(mode, image, collection), label, 'control-link');
    }

    folderLink(path, label) {
        return this.navigationLink(() => ({folder: path, collection: path,
            mode: ScreenMode.BROWSE, image: null, filter: ''}), label);
    }

    /** Resolve again on activation so pending filter input and reading choices stay current. */
    navigationLink(destination, label, className = '') {
        const link = element('a', className, label);
        link.href = stateUrl({...this.state, ...destination()});
        bindNavigation(link, () => this.navigate(destination(), false, 'top', link));
        return link;
    }

    updateControls() {
        this.sortControls.update(this.state);
        for (const button of document.querySelectorAll('[data-mode]')) {
            button.setAttribute('aria-current', button.dataset.mode === this.state.mode ? 'page' : 'false');
            button.href = stateUrl(this.modeDestination(button.dataset.mode));
        }
        for (const link of document.querySelectorAll('[data-reading-layout]')) {
            link.setAttribute('aria-current', this.state.mode === ScreenMode.VIEW && link.dataset.readingLayout === this.state.layout ? 'page' : 'false');
            link.href = stateUrl({...this.modeDestination(ScreenMode.VIEW), layout: link.dataset.readingLayout});
        }
        this.tree.update(this.state, this.rootName);
    }

    treeDestination(path) {
        return {...this.destination(this.state.mode, null, path), filter: ''};
    }

    /** Carry presentation context only while the location stays the same. */
    historyEntry(next) {
        const sameFolder = next.folder === this.state.folder;
        const sameCollection = next.collection === this.state.collection;
        const position = sameFolder ? history.state?.position : null;
        const selection = next.mode !== ScreenMode.BROWSE ? next.image : sameCollection
            ? this.state.image || history.state?.selection || null : null;
        const overviewPosition = sameFolder && sameCollection
            ? (this.state.mode === ScreenMode.OVERVIEW ? this.grid.position() : history.state?.overviewPosition) : null;
        const overviewImage = sameCollection ? (this.state.mode === ScreenMode.OVERVIEW ? next.image : history.state?.overviewImage) : null;
        const readingLayout = next.mode === ScreenMode.OVERVIEW ? this.readingOptions().layout : next.layout;
        return {position, selection, overviewPosition, overviewImage, readingLayout,
            focus: sameFolder ? history.state?.focus : null};
    }

    navigate(changes, replace = false, entry = 'top', opener = document.activeElement) {
        clearTimeout(this.filterTimer);
        // Save pending filter input in the entry being left.
        if (this.state.mode === ScreenMode.BROWSE && byId('filter').value !== this.state.filter) {
            this.state = {...this.state, filter: byId('filter').value};
            history.replaceState(history.state, '', stateUrl(this.state));
        }
        this.savePosition(opener);
        const next = {...this.state, ...changes};
        if (!replace && stateUrl(next) === stateUrl(this.state)) return;
        const metadata = this.historyEntry(next);
        history[replace ? 'replaceState' : 'pushState'](metadata, '', stateUrl(next));
        if (this.state.mode === ScreenMode.VIEW && next.mode === ScreenMode.VIEW && next.folder === this.state.folder
            && next.compact === this.state.compact) {
            this.state = next;
            this.updateControls();
            this.viewer.show(next, false, entry);
        } else this.render(false, true, entry);
    }

    folderLoaded(name) {
        this.rootName = name;
        document.title = (filename(this.state.folder) || name) + ' · Image Browser';
        this.viewer.setRootName(name);
        this.renderBreadcrumbs();
        this.tree.update(this.state, name);
    }

    renderBreadcrumbs() {
        if (this.state.mode !== ScreenMode.BROWSE) return;
        this.header.update({
            folder: this.state.folder, rootName: this.rootName, compact: this.state.compact,
            ...sortSettings(this.state),
        });
    }

    render(force = false, restore = false, entry = 'top') {
        clearTimeout(this.filterTimer);
        const previous = this.state;
        this.state = readState();
        const browseFocus = previous && this.state.mode === ScreenMode.BROWSE && previous.mode !== ScreenMode.BROWSE
            ? history.state?.focus || {id: 'grid-viewport'} : null;
        for (const button of document.querySelectorAll('[data-layout]')) {
            button.setAttribute('aria-pressed', String((button.dataset.layout === FolderLayout.LIST) === this.state.compact));
        }
        byId('filter').value = this.state.filter;
        document.querySelector('.toolbar').inert = this.state.mode !== ScreenMode.BROWSE;
        document.querySelector('.toolbar').hidden = this.state.mode !== ScreenMode.BROWSE;
        if (force || !previous || previous.mode !== this.state.mode || previous.folder !== this.state.folder
            || previous.compact !== this.state.compact || sortKey(previous) !== sortKey(this.state)) this.renderBreadcrumbs();
        const overview = this.state.mode === ScreenMode.OVERVIEW;
        const host = byId('overview');
        if (overview && this.grid.viewport.parentNode !== host) {
            host.append(this.grid.viewport, byId('summary'));
        } else if (!overview && this.grid.viewport.parentNode !== byId('workspace-content')) {
            byId('workspace-content').insertBefore(this.grid.viewport, byId('viewer'));
            byId('workspace-content').insertBefore(byId('summary'), byId('viewer'));
        }
        this.previews.setViewerOpen(this.state.mode !== ScreenMode.BROWSE);
        this.grid.viewport.hidden = this.state.mode === ScreenMode.VIEW;
        byId('summary').hidden = this.state.mode === ScreenMode.VIEW;
        this.updateControls();
        let position = restore ? history.state?.position : null;
        if (overview) {
            position = history.state?.overviewImage === this.state.image ? history.state?.overviewPosition : null;
            if (!position && this.state.image) position = {path: this.state.image, offset: 0, reveal: true};
        }
        this.viewer.show(this.state, force, entry);
        if (overview) document.querySelector('.strip-frame').hidden = true;
        if (browseFocus?.path) {
            this.grid.focusPath = browseFocus.path;
            this.grid.focusSelector = browseFocus.selector;
        }
        const gridState = {folder: overview ? this.state.collection : this.state.folder,
            ...sortSettings(this.state),
            active: this.state.mode !== ScreenMode.VIEW, recursive: overview,
            compact: overview ? false : this.state.compact, filter: overview ? '' : this.state.filter,
            selected: overview ? this.state.image : null};
        this.grid.show({...gridState, linkPresentation: JSON.stringify(this.readingOptions())}, force, position);
        if (overview && !(previous?.mode === ScreenMode.OVERVIEW)) this.grid.viewport.focus({preventScroll: true});
        if (browseFocus?.path && this.grid.focusPath) this.grid.viewport.focus({preventScroll: true});
        if (browseFocus?.id) (byId(browseFocus.id) || this.grid.viewport).focus({preventScroll: true});
    }
}

// A browser reload must refresh server snapshots as well as browser resources.
let reloadError;
if (performance.getEntriesByType('navigation')[0]?.type === 'reload') {
    const state = readState();
    try { await refreshScope(currentFolder(state)); }
    catch (error) { reloadError = error; }
}
export const app = new GalleryApp();
if (reloadError) (app.state.mode !== ScreenMode.BROWSE ? app.viewer.status : app.grid.status).textContent = reloadError.message;
