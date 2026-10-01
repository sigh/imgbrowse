import {icon} from './icons.js';
import {renderItemHeader} from './folder-path.js';
import {closeMetadata} from './metadata.js';
import {loadOriginal} from './media-cache.js';
import {walkImages} from './api.js';
import {byId, TaskScope} from './dom.js';
import {filename, parentPath, IMAGE_SIZES} from './state.js';
import {ViewerViewport} from './viewer-viewport.js';
import {WheelGesture} from './wheel-gesture.js';

import {ThumbnailStrip} from './thumbnail-strip.js';
import {VideoPlayer} from './video-player.js';
import {isVideo} from './media-kind.js';

const NEARBY_COUNT = 16;
const LOADING_DELAY = 700;
const ZOOM_STEPS = IMAGE_SIZES.slice(2).map(Number);

/** Owns image loading and collection navigation; geometry and gestures are separate. */
export class ImageViewer {
    constructor(previews, {selectImage, changeSize, changeLayout, close, folderLink, refresh}) {
        Object.assign(this, {previews, selectImage, changeSize, changeLayout, close, folderLink, refresh});
        this.container = byId('viewer');
        this.canvas = byId('viewer-canvas');
        this.viewport = new ViewerViewport(this.canvas);
        this.video = new VideoPlayer(this.canvas);
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
        this.filmstrip = new ThumbnailStrip(this.strip, previews, selectImage);
        this.lastWheelTurn = -Infinity;
        this.loadingImage = false;
        this.singleImage = false;
        this.bindControls();
    }

    bindControls() {
        byId('viewer-zoom').addEventListener('click', () => this.setSizeMenu(byId('size-menu').hidden));
        for (const button of document.querySelectorAll('[data-size]')) {
            button.addEventListener('click', () => { this.changeSize(button.dataset.size); this.setSizeMenu(false); });
        }
        document.addEventListener('pointerdown', event => {
            if (!event.target.closest('.size-control')) this.setSizeMenu(false, false);
        });
        byId('viewer-zoom-in').addEventListener('click', () => this.zoom(1));
        byId('viewer-zoom-out').addEventListener('click', () => this.zoom(-1));
        byId('viewer-retry').addEventListener('click', () => this.refresh());
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

    setRootName(name) {
        this.rootName = name;
        if (this.state?.viewing) this.updateCollectionLabel();
    }

    updateCollectionLabel() {
        const folder = !this.state.overview && this.state.image ? parentPath(this.state.image) : this.state.collection;
        const image = !this.state.overview && this.state.image;
        renderItemHeader(byId('viewer-location'), byId('viewer-actions'), {
            folder, image, rootName: this.rootName, folderLink: this.folderLink,
            currentLink: true, browseFolder: this.state.folder,
        });
    }

    updateControls() {
        const unavailable = this.state.overview || isVideo(this.state.image);
        const sizeControl = document.querySelector('.size-control');
        sizeControl.classList.toggle('unavailable', unavailable);
        sizeControl.inert = unavailable;
        if (unavailable) this.setSizeMenu(false, false);
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
            const name = wrap ? (reverse ? 'last' : 'first') : (reverse ? 'previous' : 'next');
            if (button.dataset.icon !== name) {
                button.replaceChildren(icon(name));
                button.dataset.icon = name;
            }
            const label = wrap ? (reverse ? 'Go to last item' : 'Go to first item')
                : (reverse ? 'Previous item' : 'Next item');
            button.setAttribute('aria-label', label);
            button.title = `${label} (${reverse ? '←' : '→'})`;
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
        const layoutChanged = this.state?.layout !== state.layout;
        const anchor = layoutChanged && this.viewport.ready ? this.viewport.point() : null;
        this.state = state;
        if (this.viewport.size !== state.size) this.viewport.setSize(state.size);
        const key = JSON.stringify([state.viewing, state.collection, state.image, state.overview]);
        if (!force && key === this.key) {
            this.updateControls();
            if (state.viewing && folderChanged) this.updateCollectionLabel();
            if (state.viewing && (folderChanged || layoutChanged)) {
                this.renderStrip();
                if (anchor) this.viewport.resize(anchor);
            }
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
            closeMetadata();
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
        if (state.overview) {
            this.updateControls();
            this.prefetchScope?.dispose();
            this.prefetchPath = null;
            this.viewport.clear();
            this.filmstrip.stop();
            this.setSizeMenu(false, false);
            this.updateCollectionLabel();
            byId('viewer-name').textContent = '';
            return;
        }
        if (!wasOpen) {
            closeMetadata();
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
        if (isVideo(path)) {
            this.viewport.clear();
            this.setSizeMenu(false, false);
            byId('viewer-name').textContent = filename(path);
            byId('viewer-name').title = path;
            this.video.show(path, scope, () => {
                this.status.textContent = 'Unable to play this video. Its format may not be supported by this browser.';
                byId('viewer-retry').hidden = false;
            });
            this.updateControls();
            return;
        }
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
        if (!next || isVideo(next) || this.prefetchPath === next) return;
        this.prefetchScope?.dispose();
        this.prefetchScope = new TaskScope();
        this.prefetchPath = next;
        loadOriginal(next, this.prefetchScope.signal, true).catch(() => {
            if (this.prefetchPath === next) this.prefetchPath = null;
        });
    }

    renderStrip(force = false) {
        this.filmstrip.show(this.state, this.state.layout === 'strip', force);
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
        scope.delay(() => { this.status.textContent = 'Finding the next item…'; }, LOADING_DELAY);
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
                        this.status.textContent = 'This is the only item in the collection.';
                    } else this.selectImage(result.images[0], entry);
                    return;
                }
                cursor = result.cursor;
            } while (cursor !== null);
            if (!this.state.image) {
                this.status.textContent = warning ? 'No accessible media found. Some folders could not be read.'
                    : 'No images or videos in this collection. Close to return to the folder.';
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
        if (document.fullscreenElement) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            if (!byId('size-menu').hidden) this.setSizeMenu(false);
            else this.close();
            return;
        }
        if (this.state.overview) {
            if (event.key.toLowerCase() === 't') this.changeLayout('strip');
            return;
        }
        if (event.composedPath().includes(this.video.element)) return;
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
        else if (event.key.toLowerCase() === 't') this.changeLayout(this.state.layout === 'strip' ? 'single' : 'strip');
    }

    onWheel(event) {
        if (this.state?.overview || isVideo(this.state?.image)) return;
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
