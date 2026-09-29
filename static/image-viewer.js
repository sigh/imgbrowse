import {loadOriginal} from './media-cache.js';
import {walkImages} from './api.js';
import {byId, element, TaskScope} from './dom.js';
import {filename, parentPath, joinPath, IMAGE_SIZES} from './state.js';
import {ViewerViewport} from './viewer-viewport.js';
import {WheelGesture} from './wheel-gesture.js';

import {icon} from './icons.js';
import {ThumbnailStrip} from './thumbnail-strip.js';

const NEARBY_COUNT = 16;
const LOADING_DELAY = 700;
const ZOOM_STEPS = IMAGE_SIZES.slice(2).map(Number);

/** Owns image loading and collection navigation; geometry and gestures are separate. */
export class ImageViewer {
    constructor(previews, {selectImage, changeSize, close, folderLink, refresh}) {
        Object.assign(this, {previews, selectImage, changeSize, close, folderLink, refresh});
        this.container = byId('viewer');
        this.canvas = byId('viewer-canvas');
        this.viewport = new ViewerViewport(this.canvas);
        this.wheel = new WheelGesture();
        this.strip = byId('viewer-strip');
        this.status = byId('viewer-status');
        this.closeButton = byId('viewer-close');
        this.previousButton = byId('viewer-prev');
        this.nextButton = byId('viewer-next');
        this.rootName = 'Collection';
        this.key = null;
        this.boundaryDirection = null;
        this.nearbyImages = [];
        this.thumbnailsVisible = sessionStorage.getItem('thumbnails') !== 'false';
        this.filmstrip = new ThumbnailStrip(this.strip, previews, selectImage);
        this.lastWheelTurn = -Infinity;
        this.loadingImage = false;
        this.singleImage = false;
        this.bindControls();
    }

    bindControls() {
        byId('viewer-thumbnails').append(icon('thumbnails'));
        byId('viewer-refresh').append(icon('refresh'));
        byId('viewer-zoom').addEventListener('click', () => this.setSizeMenu(byId('size-menu').hidden));
        for (const button of document.querySelectorAll('[data-size]')) {
            button.addEventListener('click', () => { this.changeSize(button.dataset.size); this.setSizeMenu(false); });
        }
        document.addEventListener('pointerdown', event => {
            if (!event.target.closest('.size-control')) this.setSizeMenu(false, false);
        });
        byId('viewer-zoom-in').addEventListener('click', () => this.zoom(1));
        byId('viewer-zoom-out').addEventListener('click', () => this.zoom(-1));
        byId('viewer-thumbnails').addEventListener('click', () => this.toggleThumbnails());
        byId('viewer-retry').addEventListener('click', () => this.refresh());
        byId('viewer-refresh').addEventListener('click', () => this.refresh());
        this.closeButton.addEventListener('click', this.close);
        this.previousButton.addEventListener('click', () => this.requestMove(true));
        this.nextButton.addEventListener('click', () => this.requestMove(false));
        document.addEventListener('keydown', event => this.onKey(event));
        byId('viewer-stage').addEventListener('wheel', event => this.onWheel(event), {passive: false});
    }

    zoom(direction) {
        if (!this.viewport.ready) return;
        const scale = this.viewport.scale;
        const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
        const next = steps.find(step => direction > 0 ? step > scale + .001 : step < scale - .001);
        if (next != null) this.changeSize(String(next));
    }

    setSizeMenu(open, restoreFocus = true) {
        const wasOpen = !byId('size-menu').hidden;
        byId('size-menu').hidden = !open;
        byId('viewer-zoom').setAttribute('aria-expanded', String(open));
        if (!open && wasOpen && restoreFocus) byId('viewer-zoom').focus({preventScroll: true});
    }

    toggleThumbnails() {
        const point = this.viewport.point();
        this.thumbnailsVisible = !this.thumbnailsVisible;
        sessionStorage.setItem('thumbnails', String(this.thumbnailsVisible));
        this.renderStrip();
        this.viewport.resize(point);
    }

    setRootName(name) {
        this.rootName = name;
        if (this.state?.viewing) this.updateCollectionLabel();
    }

    updateCollectionLabel() {
        const path = byId('viewer-path');
        const focusedPath = path.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
        path.replaceChildren();
        const folder = this.state.image ? parentPath(this.state.image) : this.state.collection;
        const parts = [{path: '', name: this.rootName}];
        let current = '';
        for (const name of folder.split('/').filter(Boolean)) {
            current = joinPath(current, name);
            parts.push({path: current, name});
        }
        for (const [index, part] of parts.entries()) {
            if (index) path.append(element('span', '', '/'));
            const link = this.folderLink(part.path, part.name);
            if (part.path === this.state.collection) {
                link.classList.add('collection-link');
                link.title = 'Viewing this folder and its subfolders';
            }
            path.append(link);
            if (focusedPath === link.getAttribute('href')) link.focus({preventScroll: true});
        }
    }

    updateControls() {
        const hasImage = Boolean(this.state.image);
        this.previousButton.disabled = !hasImage || this.singleImage || Boolean(this.moveScope);
        this.nextButton.disabled = this.previousButton.disabled;
        // The displayed image remains usable while its replacement loads.
        const sizing = this.viewport.ready;
        byId('viewer-zoom').disabled = !sizing;
        const label = this.state.size === 'page' ? 'Fit' : this.state.size === 'width' ? 'Width' : Math.round(Number(this.state.size) * 100) + '%';
        if (byId('viewer-zoom').dataset.size !== this.state.size) {
            byId('viewer-zoom').textContent = label + ' ▾';
        }
        byId('viewer-zoom').dataset.size = this.state.size;
        byId('zoom-value').textContent = Math.round(this.viewport.scale * 100) + '%';
        for (const button of document.querySelectorAll('[data-size]')) {
            button.setAttribute('aria-pressed', String(button.dataset.size === this.state.size));
            button.disabled = !sizing;
        }
        byId('viewer-zoom-out').disabled = !sizing || this.viewport.scale <= ZOOM_STEPS[0];
        byId('viewer-zoom-in').disabled = !sizing || this.viewport.scale >= ZOOM_STEPS.at(-1);
        for (const [button, reverse] of [[this.previousButton, true], [this.nextButton, false]]) {
            const wrap = this.boundaryDirection === reverse;
            button.querySelector('.nav-label').textContent = wrap ? (reverse ? 'Go to last image' : 'Go to first image')
                : (reverse ? 'Prev' : 'Next');
            button.setAttribute('aria-label', wrap ? (reverse ? 'Go to last image' : 'Go to first image')
                : (reverse ? 'Previous image' : 'Next image'));
            button.classList.toggle('wrap', wrap);
        }
        this.container.setAttribute('aria-busy', String(this.loadingImage || Boolean(this.moveScope)));
    }

    clearBoundary() {
        this.boundaryDirection = null;
        this.status.textContent = '';
        byId('viewer-retry').hidden = true;
    }

    show(state, force = false, entry = 'top') {
        const folderChanged = this.state?.folder !== state.folder;
        this.state = state;
        if (this.viewport.size !== state.size) this.viewport.setSize(state.size);
        const key = JSON.stringify([state.viewing, state.collection, state.image]);
        if (!force && key === this.key) {
            this.updateControls();
            if (state.viewing && folderChanged) this.renderStrip();
            return;
        }
        this.key = key;
        this.scope?.dispose();
        this.moveScope?.dispose();
        this.moveScope = null;
        this.scope = new TaskScope();
        this.loadingImage = false;
        this.singleImage = false;
        this.clearBoundary();
        const wasOpen = !this.container.hidden;
        this.container.hidden = !state.viewing;
        if (!state.viewing) {
            this.prefetchScope?.dispose();
            this.prefetchScope = null;
            this.prefetchPath = null;
            this.nearbyImages = [];
            this.nearbyCollection = null;
            this.viewport.clear();
            this.filmstrip.stop();
            this.setSizeMenu(false, false);
            if (wasOpen) {
                const target = this.opener?.isConnected && this.opener !== document.body && this.opener.getClientRects().length
                    ? this.opener : byId('grid-viewport');
                target.focus({preventScroll: true});
            }
            return;
        }
        if (!wasOpen) {
            this.opener = this.openingFocus || document.activeElement;
            this.openingFocus = null;
            this.canvas.focus({preventScroll: true});
        }
        if (force || this.nearbyCollection !== state.collection) this.nearbyImages = [];
        this.updateCollectionLabel();
        this.updateControls();
        if (state.image) {
            this.loadImage(state.image, this.scope, entry);
            this.loadNeighbors(state.image, state.collection, this.scope);
            this.renderStrip(force);
        } else {
            this.viewport.clear();
            this.updateControls();
            byId('viewer-name').textContent = '';
            this.moveImage();
        }
    }

    async loadImage(path, scope, entry) {
        this.loadingImage = true;
        this.updateControls();
        const timer = setTimeout(() => {
            if (!scope.signal.aborted) this.status.textContent = 'Loading ' + filename(path) + '…';
        }, LOADING_DELAY);
        scope.onDispose(() => clearTimeout(timer));
        try {
            const {image} = await loadOriginal(path, scope.signal);
            scope.signal.throwIfAborted();
            this.viewport.show(image, this.state.size, entry);
            byId('viewer-name').textContent = filename(path);
            byId('viewer-name').title = path;
            if (this.boundaryDirection === null && !this.moveScope) this.status.textContent = '';
        } catch (error) {
            if (error.name !== 'AbortError' && !scope.signal.aborted) {
                this.viewport.clear();
                byId('viewer-name').textContent = filename(path);
                this.status.textContent = 'Unable to open ' + path + '. Retry or move to another image.';
                byId('viewer-retry').hidden = false;
            }
        } finally {
            clearTimeout(timer);
            if (scope === this.scope) {
                this.loadingImage = false;
                this.updateControls();
                this.prefetchNext();
            }
        }
    }

    loadNeighbors(image, collection, scope) {
        const results = new Map();
        for (const reverse of [true, false]) {
            walkImages({root: collection, anchor: image, reverse, limit: NEARBY_COUNT}, scope.signal)
                .then(result => {
                    scope.signal.throwIfAborted();
                    results.set(reverse, result);
                    const before = results.get(true), after = results.get(false);
                    this.nearbyImages = [...(before ? [...before.images].reverse() : []), image, ...(after?.images || [])];
                    this.nearbyCollection = collection;
                    this.singleImage = Boolean(before && after && this.nearbyImages.length === 1
                        && !before.cursor && !after.cursor && !before.warnings.length && !after.warnings.length);
                    this.updateControls();
                    this.prefetchNext();
                }).catch(() => {});
        }
    }

    prefetchNext() {
        if (this.loadingImage || !this.state.viewing) return;
        const index = this.nearbyImages.indexOf(this.state.image);
        const next = index < 0 ? null : this.nearbyImages[index + (this.readingReverse ? -1 : 1)];
        if (!next || this.prefetchPath === next) return;
        this.prefetchScope?.dispose();
        this.prefetchScope = new TaskScope();
        this.prefetchPath = next;
        loadOriginal(next, this.prefetchScope.signal, true).catch(() => {
            if (this.prefetchPath === next) this.prefetchPath = null;
        });
    }

    renderStrip(force = false) {
        byId('viewer-thumbnails').setAttribute('aria-expanded', String(this.thumbnailsVisible));
        this.filmstrip.show(this.state, this.thumbnailsVisible, force);
    }

    requestMove(reverse, fresh = true, source = 'explicit') {
        if (!this.state.viewing || this.moveScope || this.singleImage) return;
        this.readingReverse = reverse;
        if (this.loadingImage && !fresh) return;
        const wrap = this.boundaryDirection === reverse;
        if (wrap && !fresh) return;
        this.clearBoundary();
        this.moveImage(reverse, wrap, source === 'wheel' && reverse ? 'bottom' : 'top');
    }

    async moveImage(reverse = false, wrap = false, entry = 'top') {
        const index = this.nearbyCollection === this.state.collection ? this.nearbyImages.indexOf(this.state.image) : -1;
        const neighbor = !wrap && index >= 0 ? this.nearbyImages[index + (reverse ? -1 : 1)] : null;
        if (neighbor) {
            this.selectImage(neighbor, entry);
            return;
        }
        const scope = this.moveScope = new TaskScope();
        this.updateControls();
        scope.delay(() => { this.status.textContent = 'Finding the next image…'; }, LOADING_DELAY);
        let cursor = null;
        let warning = false;
        try {
            do {
                const result = await walkImages({root: this.state.collection,
                    anchor: wrap ? null : this.state.image, reverse, cursor, limit: 1}, scope.signal);
                scope.signal.throwIfAborted();
                warning ||= result.warnings.length > 0;
                if (result.images.length) {
                    if (wrap && result.images[0] === this.state.image) {
                        this.singleImage = true;
                        this.status.textContent = 'This is the only image in the collection.';
                    } else this.selectImage(result.images[0], entry);
                    return;
                }
                cursor = result.cursor;
            } while (cursor !== null);
            if (!this.state.image) {
                this.status.textContent = warning ? 'No accessible images found. Some folders could not be read.'
                    : 'No images in this collection. Close to return to the folder.';
            } else {
                this.boundaryDirection = reverse;
                this.status.textContent = (reverse ? 'Beginning' : 'End') + ' of collection.'
                    + (warning ? ' Some folders could not be read.' : '');
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                this.status.textContent = error.message;
                byId('viewer-retry').hidden = false;
            }
        } finally {
            scope.dispose();
            if (this.moveScope === scope) {
                this.moveScope = null;
                this.updateControls();
            }
        }
    }

    onKey(event) {
        if (!this.state?.viewing || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            if (!byId('size-menu').hidden) this.setSizeMenu(false);
            else this.close();
            return;
        }
        if (event.key === 'Tab') {
            const controls = [...this.container.querySelectorAll('a[href], button, select, [tabindex="0"]')]
                .filter(node => node.getClientRects().length && !node.disabled);
            const index = controls.indexOf(document.activeElement);
            const next = (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
            event.preventDefault();
            controls[next]?.focus();
            return;
        }
        if (event.target instanceof Element && event.target.matches('select, input, textarea')) return;
        if (!byId('size-menu').hidden) return;
        const vertical = ['ArrowUp', 'ArrowDown'].includes(event.key);
        if (vertical && this.canvas.scrollHeight > this.canvas.clientHeight + 2) {
            event.preventDefault();
            this.viewport.scroll(event.key === 'ArrowUp' ? -80 : 80);
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            this.requestMove(['ArrowLeft', 'ArrowUp'].includes(event.key), !event.repeat);
        } else if (['+', '=', '-'].includes(event.key)) {
            event.preventDefault();
            this.zoom(event.key === '-' ? -1 : 1);
        } else if (event.key.toLowerCase() === 'f') this.changeSize('page');
        else if (event.key.toLowerCase() === 'w') this.changeSize('width');
        else if (event.key.toLowerCase() === 't') this.toggleThumbnails();
    }

    onWheel(event) {
        if (!this.state?.viewing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
            || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        const now = performance.now();
        const fresh = this.wheel.update(event.deltaY, now);
        const reverse = event.deltaY < 0;
        const overflow = this.viewport.overflows();
        if (this.loadingImage || this.moveScope) { event.preventDefault(); return; }
        if (fresh) { this.scrollingGesture = false; this.edgeTurn = false; }
        if (this.edgeTurn && !fresh) { event.preventDefault(); return; }
        if (overflow) {
            if (this.scrollingGesture) return;
            if (this.wheel.consumed) { event.preventDefault(); return; }
            if (this.viewport.canScroll(reverse)) {
                // Native scrolling owns movement; reaching an edge consumes this gesture.
                this.wheel.consume();
                // Allow the rest of the gesture to scroll, but not to turn a page.
                this.scrollingGesture = true;
                return;
            }
            if (!fresh) { event.preventDefault(); return; }
        } else if (!fresh && now - this.lastWheelTurn < 350) {
            event.preventDefault(); return;
        }
        event.preventDefault();
        if (this.boundaryDirection === reverse && !fresh) return;
        this.wheel.consume();
        this.lastWheelTurn = now;
        this.edgeTurn = overflow;
        this.requestMove(reverse, fresh, 'wheel');
    }
}
