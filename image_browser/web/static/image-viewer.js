import {icon} from './icons.js';
import {renderItemHeader} from './folder-path.js';
import {closeMetadata} from './metadata.js';
import {loadOriginal} from './media-cache.js';
import {walkImages} from './api.js';
import {byId, setButtonLabel, TaskScope} from './dom.js';
import {filename, parentPath, IMAGE_SIZES, ScreenMode, ReadingLayout, ImageSize} from './state.js';
import {ViewerViewport} from './viewer-viewport.js';
import {WheelGesture, WheelMode} from './wheel-gesture.js';

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
        this.previousButton = byId('viewer-prev');
        this.nextButton = byId('viewer-next');
        this.rootName = 'Collection';
        this.key = null;
        this.boundaryDirection = null;
        this.nearbyImages = [];
        this.filmstrip = new ThumbnailStrip(this.strip, previews, selectImage);
        this.loadingImage = false;
        this.singleImage = false;
        this.bindControls();
    }

    bindControls() {
        byId('viewer-zoom').addEventListener('click', () => this.setSizeMenu(byId('size-menu').hidden));
        for (const button of document.querySelectorAll('#size-menu [data-size]')) {
            button.addEventListener('click', () => { this.changeSize(button.dataset.size); this.setSizeMenu(false); });
        }
        document.addEventListener('pointerdown', event => {
            if (!event.target.closest('.size-control')) this.setSizeMenu(false, false);
        });
        byId('viewer-zoom-in').addEventListener('click', () => this.zoom(1));
        byId('viewer-zoom-out').addEventListener('click', () => this.zoom(-1));
        byId('viewer-retry').addEventListener('click', () => this.retryMove ? this.retryMove() : this.refresh());
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
        if (this.state && this.state.mode !== ScreenMode.BROWSE) this.updateCollectionLabel();
    }

    updateCollectionLabel() {
        const image = this.state.mode === ScreenMode.OVERVIEW ? null : this.state.image;
        const folder = image ? parentPath(image) : this.state.collection;
        renderItemHeader(byId('viewer-location'), byId('viewer-actions'), {
            folder, image, rootName: this.rootName, folderLink: this.folderLink,
            currentLink: true, collection: this.state.collection, compact: this.state.compact,
        });
    }

    updateControls() {
        const unavailable = this.state.mode === ScreenMode.OVERVIEW || isVideo(this.state.image);
        const sizeControl = document.querySelector('.size-control');
        sizeControl.classList.toggle('unavailable', unavailable);
        sizeControl.inert = unavailable;
        if (unavailable) this.setSizeMenu(false, false);
        const hasImage = Boolean(this.state.image);
        this.previousButton.disabled = !hasImage || this.singleImage || Boolean(this.moveScope);
        this.nextButton.disabled = this.previousButton.disabled;
        // Sizing is available only once the requested image is displayed.
        const sizing = this.viewport.ready;
        byId('viewer-zoom').disabled = !sizing;
        const label = this.state.size === ImageSize.FIT_PAGE ? 'Fit' : this.state.size === ImageSize.FIT_WIDTH ? 'Width' : Math.round(Number(this.state.size) * 100) + '%';
        if (byId('viewer-zoom').dataset.size !== this.state.size) {
            byId('viewer-zoom').textContent = label + ' ▾';
        }
        byId('viewer-zoom').dataset.size = this.state.size;
        byId('zoom-value').textContent = Math.round(this.viewport.scale * 100) + '%';
        for (const button of document.querySelectorAll('#size-menu [data-size]')) {
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
            setButtonLabel(button, label, `${label} (${reverse ? '←' : '→'})`);
            button.classList.toggle('wrap', wrap);
        }
        this.container.setAttribute('aria-busy', String(this.loadingImage || Boolean(this.moveScope)));
    }

    clearBoundary() {
        this.retryMove = null;
        this.boundaryDirection = null;
        this.status.textContent = '';
        byId('viewer-retry').hidden = true;
    }

    stopReading() {
        this.prefetchScope?.dispose();
        this.prefetchScope = null;
        this.prefetchPath = null;
        this.viewport.clear();
        this.filmstrip.stop();
        this.setSizeMenu(false, false);
    }

    show(state, force = false, entry = 'top') {
        const wasOverview = (this.state?.mode === ScreenMode.OVERVIEW);
        const folderChanged = this.state?.folder !== state.folder;
        const layoutChanged = this.state?.layout !== state.layout;
        const anchor = layoutChanged && this.viewport.ready ? this.viewport.point() : null;
        this.state = state;
        if (this.viewport.size !== state.size) this.viewport.setSize(state.size);
        const key = JSON.stringify([state.mode, state.collection, state.image]);
        if (!force && key === this.key) {
            this.updateControls();
            if (state.mode !== ScreenMode.BROWSE && folderChanged) this.updateCollectionLabel();
            if (state.mode !== ScreenMode.BROWSE && (folderChanged || layoutChanged)) {
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
        this.container.hidden = state.mode === ScreenMode.BROWSE;
        if (state.mode !== ScreenMode.VIEW) this.stopReading();
        if (state.mode === ScreenMode.BROWSE) {
            closeMetadata();
            this.nearbyImages = [];
            this.nearbyCollection = null;
            return;
        }
        if (!wasOpen) {
            closeMetadata();
            if (state.mode !== ScreenMode.OVERVIEW) this.canvas.focus({preventScroll: true});
        } else if (wasOverview && state.mode !== ScreenMode.OVERVIEW) this.canvas.focus({preventScroll: true});
        if (state.mode === ScreenMode.OVERVIEW) {
            this.updateControls();
            this.updateCollectionLabel();
            return;
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
            this.moveImage();
        }
    }

    async loadImage(path, scope, entry) {
        if (isVideo(path)) {
            this.viewport.clear();
            this.setSizeMenu(false, false);
            this.video.show(path, scope, error => {
                const retryable = ![MediaError.MEDIA_ERR_DECODE, MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED].includes(error?.code);
                this.status.textContent = retryable ? 'Unable to load this video.' : 'Unable to play this video.';
                byId('viewer-retry').hidden = !retryable;
            });
            this.updateControls();
            return;
        }
        let timer;
        try {
            const original = loadOriginal(path, scope.signal);
            if (original instanceof Promise) {
                this.viewport.clear();
                this.loadingImage = true;
                this.updateControls();
                timer = setTimeout(() => {
                    if (!scope.signal.aborted) this.status.textContent = 'Loading ' + filename(path) + '…';
                }, LOADING_DELAY);
                scope.onDispose(() => clearTimeout(timer));
            }
            const {image} = original instanceof Promise ? await original : original;
            scope.signal.throwIfAborted();
            this.viewport.show(image, this.state.size, entry);
            if (this.boundaryDirection === null && !this.moveScope) this.status.textContent = '';
        } catch (error) {
            if (error.name !== 'AbortError' && !scope.signal.aborted) {
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
        const index = this.nearbyCollection === collection ? this.nearbyImages.indexOf(image) : -1;
        if (index > 1 && index < this.nearbyImages.length - 2) return;
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
        if (this.loadingImage || this.state.mode === ScreenMode.BROWSE) return;
        const index = this.nearbyImages.indexOf(this.state.image);
        const next = index < 0 ? null : this.nearbyImages[index + (this.readingReverse ? -1 : 1)];
        if (!next || isVideo(next) || this.prefetchPath === next) return;
        this.prefetchScope?.dispose();
        this.prefetchScope = new TaskScope();
        this.prefetchPath = next;
        Promise.resolve(loadOriginal(next, this.prefetchScope.signal, true)).catch(() => {
            if (this.prefetchPath === next) this.prefetchPath = null;
        });
    }

    renderStrip(force = false) {
        this.filmstrip.show(this.state, this.state.mode === ScreenMode.VIEW && this.state.layout === ReadingLayout.STRIP, force);
    }

    requestMove(reverse, fresh = true, entry = 'top') {
        if (this.state.mode === ScreenMode.BROWSE || this.moveScope || this.singleImage) return;
        this.readingReverse = reverse;
        const wrap = this.boundaryDirection === reverse;
        if (wrap && !fresh) return;
        this.clearBoundary();
        this.moveImage(reverse, wrap, entry);
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
        scope.delay(() => { this.status.textContent = reverse ? 'Finding the previous item…' : 'Finding the next item…'; }, LOADING_DELAY);
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
                    : 'No images or videos in this collection.';
            } else {
                this.boundaryDirection = reverse;
                this.status.textContent = (reverse ? 'Beginning' : 'End') + ' of collection.'
                    + (warning ? ' Some folders could not be read.' : '');
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                this.status.textContent = 'Unable to find the ' + (reverse ? 'previous' : 'next') + ' item.';
                this.retryMove = () => { this.clearBoundary(); this.moveImage(reverse, wrap, entry); };
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
        if (!this.state || this.state.mode === ScreenMode.BROWSE || event.ctrlKey || event.metaKey || event.altKey) return;
        if (document.fullscreenElement || event.target instanceof Element && event.target.closest('#metadata-popover')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            if (!byId('size-menu').hidden) this.setSizeMenu(false);
            else this.close();
            return;
        }
        if (event.composedPath().includes(this.video.element)) return;
        if (this.state.mode === ScreenMode.OVERVIEW) return;
        if (event.target instanceof Element && event.target.matches('select, input, textarea')) return;
        if (!byId('size-menu').hidden) return;
        const vertical = ['ArrowUp', 'ArrowDown'].includes(event.key);
        if (vertical && !this.filmstrip.container.contains(event.target) && this.canvas.scrollHeight > this.canvas.clientHeight + 2) {
            event.preventDefault();
            this.viewport.scroll(event.key === 'ArrowUp' ? -80 : 80);
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            this.requestMove(['ArrowLeft', 'ArrowUp'].includes(event.key), !event.repeat);
        } else if (['+', '=', '-'].includes(event.key)) {
            event.preventDefault();
            this.zoom(event.key === '-' ? -1 : 1);
        } else if (event.key.toLowerCase() === 'f') this.changeSize(ImageSize.FIT_PAGE);
        else if (event.key.toLowerCase() === 'w') this.changeSize(ImageSize.FIT_WIDTH);
        else if (event.key.toLowerCase() === 't') this.changeLayout(this.state.layout === ReadingLayout.STRIP ? ReadingLayout.SINGLE : ReadingLayout.STRIP);
    }

    onWheel(event) {
        if (this.state?.mode !== ScreenMode.VIEW || isVideo(this.state.image)
            || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
            || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        const delta = event.deltaY * (event.deltaMode === 1 ? 16
            : event.deltaMode === 2 ? this.canvas.clientHeight : 1);
        const reverse = event.deltaY < 0;
        const overflow = this.state.size !== ImageSize.FIT_PAGE && this.viewport.overflows();
        const mode = overflow ? (this.viewport.canScroll(reverse) ? WheelMode.NATIVE_SCROLL : WheelMode.EDGE_TURN) : WheelMode.PAGE_TURN;
        const {native, turn, fresh} = this.wheel.update(delta, performance.now(), mode);
        if (native) return;
        event.preventDefault();
        if (turn) this.requestMove(reverse, fresh, reverse ? 'bottom' : 'top');
    }
}
