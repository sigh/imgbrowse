import {setIconButton} from './icons.js';
import {closeMetadata} from './metadata.js';
import {loadOriginal} from './media-cache.js';
import {walkImages} from './api.js';
import {byId, plainClick, TaskScope} from './dom.js';
import {filename, parentPath, ZOOM, ScreenMode, ReadingLayout, ImageSize, ViewerEntry} from './state.js';
import {ViewerViewport, imageScale} from './viewer-viewport.js';
import {ContinuousReader} from './continuous-reader.js';
import {WheelGesture, WheelMode} from './wheel-gesture.js';

import {ThumbnailStrip} from './thumbnail-strip.js';
import {VideoPlayer} from './video-player.js';
import {isVideo, canRetryMedia} from './media-kind.js';

const NEARBY_COUNT = 16;
const LOADING_DELAY = 700;
const PARTIAL_COLLECTION_MESSAGE = 'Some folders could not be read.';
const KEYBOARD_PAN_STEP = 80;
const ARROW_DIRECTIONS = Object.freeze({
    ArrowLeft: {x:-1, y:0}, ArrowRight: {x:1, y:0},
    ArrowUp: {x:0, y:-1}, ArrowDown: {x:0, y:1},
});

/** Owns image loading and collection navigation; geometry and gestures are separate. */
export class ImageViewer {
    constructor(previews, {selectImage, changeSize, changeLayout, close, renderHeader, refresh}) {
        Object.assign(this, {selectImage, changeSize, changeLayout, close, renderHeader, refresh});
        this.container = byId('viewer');
        this.canvas = byId('viewer-canvas');
        this.singleViewport = new ViewerViewport(this.canvas, () => { if (this.state) this.updateControls(); });
        this.video = new VideoPlayer(this.canvas);
        this.continuous = new ContinuousReader(this.canvas, {selectImage, video:this.video, changed:() => { if (this.state) this.updateControls(); }});
        this.wheel = new WheelGesture();
        this.strip = byId('viewer-strip');
        this.status = byId('viewer-status');
        this.warning = byId('viewer-warning');
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

    get scrolling() { return this.state?.layout === ReadingLayout.SCROLL; }
    get viewport() { return this.scrolling ? this.continuous : this.singleViewport; }

    bindControls() {
        byId('viewer-zoom-in').addEventListener('click', () => this.zoom(1));
        byId('viewer-zoom-out').addEventListener('click', () => this.zoom(-1));
        byId('viewer-retry').addEventListener('click', () => this.retryMove ? this.retryMove() : this.refresh());
        this.previousButton.addEventListener('click', () => this.requestMove(true));
        this.nextButton.addEventListener('click', () => this.requestMove(false));
        document.addEventListener('keydown', event => this.onKey(event));
        this.wheelListener = event => this.onWheel(event);
        this.canvas.addEventListener('click', event => this.inspect(event));
    }

    zoom(direction) {
        if (!this.viewport.ready) return;
        const scale = Math.max(ZOOM.MIN, Math.min(ZOOM.MAX, this.viewport.scale * ZOOM.STEP ** direction));
        this.changeSize(String(scale));
    }

    inspectionTarget(image) {
        const size = this.state.size === ImageSize.DEFAULT ? ImageSize.ORIGINAL : ImageSize.DEFAULT;
        const scale = imageScale(size, this.state.layout, image.naturalWidth, image.naturalHeight, this.canvas.clientWidth, this.canvas.clientHeight);
        const current = image.width / image.naturalWidth;
        return this.state.size === ImageSize.DEFAULT && Math.abs(scale-current) < .001 ? null : {size, scale};
    }

    inspect(event) {
        const image = event.target;
        if (!(image instanceof HTMLImageElement) || !plainClick(event) || event.pointerType === 'touch' || !image.naturalWidth) return;
        const target = this.inspectionTarget(image);
        if (!target) return;
        const rect = image.getBoundingClientRect();
        const enlarging = target.size === ImageSize.ORIGINAL;
        const point = enlarging ? {path:image.dataset.path, x:(event.clientX-rect.left)/(rect.width/image.naturalWidth),
            y:(event.clientY-rect.top)/(rect.height/image.naturalHeight), alignY:.5} : this.viewport.point();
        if (image.dataset.path !== this.state.image) this.selectImage(image.dataset.path, ViewerEntry.KEEP);
        this.changeSize(target.size);
        this.viewport.resize(point);
    }

    setRootName(name) {
        this.rootName = name;
        if (this.state && this.state.mode !== ScreenMode.BROWSE) this.updateCollectionLabel();
    }

    updateCollectionLabel() {
        const image = this.state.mode === ScreenMode.OVERVIEW ? null : this.state.image;
        const folder = image ? parentPath(image) : this.state.collection;
        this.renderHeader({
            folder, image, rootName: this.rootName,
            currentLink: true, collection: this.state.collection, compact: this.state.compact,
        });
    }

    updateControls() {
        if (this.scrolling) this.singleImage = this.continuous.singleImage;
        const warning = this.state.mode === ScreenMode.VIEW && this.scrolling && this.continuous.warning
            ? PARTIAL_COLLECTION_MESSAGE : '';
        if (this.warning.textContent !== warning) this.warning.textContent = warning;
        const unavailable = this.state.mode !== ScreenMode.VIEW || isVideo(this.state.image);
        const sizeControl = document.querySelector('.viewer-tools');
        sizeControl.classList.toggle('unavailable', unavailable);
        sizeControl.inert = unavailable;
        const hasImage = Boolean(this.state.image);
        this.previousButton.disabled = !hasImage || this.singleImage || Boolean(this.moveScope);
        this.nextButton.disabled = this.previousButton.disabled;
        // Sizing is available only once the requested image is displayed.
        const sizing = this.viewport.ready;
        byId('viewer-zoom-out').disabled = !sizing || this.viewport.scale <= ZOOM.MIN;
        byId('viewer-zoom-in').disabled = !sizing || this.viewport.scale >= ZOOM.MAX;
        for (const image of this.canvas.querySelectorAll('img')) {
            if (!image.naturalWidth) continue;
            const target = this.inspectionTarget(image);
            image.style.cursor = !target ? 'default' : target.scale > image.width/image.naturalWidth ? 'zoom-in' : 'zoom-out';
        }
        for (const [button, reverse] of [[this.previousButton, true], [this.nextButton, false]]) {
            const wrap = this.boundaryDirection === reverse;
            const name = wrap ? (reverse ? 'last' : 'first') : (reverse ? 'previous' : 'next');
            const label = wrap ? (reverse ? 'Go to last item' : 'Go to first item')
                : (reverse ? 'Previous item' : 'Next item');
            setIconButton(button, name, label, `${label} (${reverse ? '←' : '→'})`);
            button.classList.toggle('wrap', wrap);
        }
        this.container.setAttribute('aria-busy', String(this.loadingImage || this.scrolling && this.continuous.loading || Boolean(this.moveScope)));
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
        this.singleViewport.clear();
        this.continuous.stop();
        this.filmstrip.stop();
    }

    show(state, force = false, entry = ViewerEntry.TOP) {
        const wasOverview = (this.state?.mode === ScreenMode.OVERVIEW);
        const folderChanged = this.state?.folder !== state.folder;
        const layoutChanged = this.state?.layout !== state.layout;
        const sameImage = this.state?.collection === state.collection && this.state?.image === state.image;
        const anchor = sameImage && layoutChanged && this.state?.mode === ScreenMode.VIEW && state.mode === ScreenMode.VIEW ? this.viewport.point() : null;
        if (!sameImage || state.mode === ScreenMode.BROWSE) this.overviewPoint = null;
        else if (!wasOverview && state.mode === ScreenMode.OVERVIEW) this.overviewPoint = this.viewport.point();
        const point = wasOverview && state.mode === ScreenMode.VIEW ? this.overviewPoint : anchor;
        if (state.mode !== ScreenMode.OVERVIEW) this.overviewPoint = null;
        const wheelEnabled = state.mode === ScreenMode.VIEW && state.layout !== ReadingLayout.SCROLL;
        const wheelWasEnabled = this.state?.mode === ScreenMode.VIEW && this.state?.layout !== ReadingLayout.SCROLL;
        if (wheelEnabled !== wheelWasEnabled) {
            const stage = byId('viewer-stage');
            if (wheelEnabled) stage.addEventListener('wheel', this.wheelListener, {passive:false});
            else stage.removeEventListener('wheel', this.wheelListener);
        }
        this.state = state;
        // Capture the reading point before hiding the canvas, then size new media in the active screen.
        byId('overview').hidden = state.mode !== ScreenMode.OVERVIEW;
        byId('viewer-stage').hidden = state.mode === ScreenMode.OVERVIEW;
        const key = JSON.stringify([state.mode, state.collection, state.image, this.scrolling]);
        if (!force && key === this.key) {
            if (this.viewport.size !== state.size) this.viewport.setSize(state.size);
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
            this.updateControls();
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
        this.canvas.querySelector('.image-surface').hidden = this.scrolling;
        if (!this.scrolling || this.continuous.collection !== state.collection || !state.image) this.continuous.stop();
        this.updateCollectionLabel();
        this.updateControls();
        if (state.image) {
            this.renderStrip(force);
            if (this.scrolling) {
                if (this.singleViewport.image.id) {
                    this.singleViewport.clear();
                    this.singleViewport.image.removeAttribute('id');
                }
                this.continuous.show(state, force, entry, point);
                this.nearbyImages = this.continuous.paths;
                this.nearbyCollection = state.collection;
            } else {
                this.singleViewport.image.id = 'viewer-image';
                this.loadImage(state.image, this.scope, entry, point);
                this.loadNeighbors(state.image, state.collection, this.scope);
            }
        } else {
            this.singleViewport.clear();
            this.updateControls();
            this.moveImage();
        }
        this.updateControls();
    }

    async loadImage(path, scope, entry, point = null) {
        if (isVideo(path)) {
            this.viewport.clear();
            this.video.show(path, scope, error => {
                const retryable = canRetryMedia(error);
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
            if (point) this.viewport.resize(point);
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
        if (this.loadingImage || this.state.mode !== ScreenMode.VIEW || this.scrolling) return;
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
        let warning = this.scrolling && this.continuous.warning;
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
                this.status.textContent = warning ? 'No accessible media found. ' + PARTIAL_COLLECTION_MESSAGE
                    : 'No images or videos in this collection.';
            } else {
                this.boundaryDirection = reverse;
                this.status.textContent = (reverse ? 'Beginning' : 'End') + ' of collection.'
                    + (warning ? ' ' + PARTIAL_COLLECTION_MESSAGE : '');
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
            this.close();
            return;
        }
        if (event.target instanceof Element && event.target.closest('video')) return;
        if (this.state.mode === ScreenMode.OVERVIEW) return;
        if (event.target instanceof Element && event.target.matches('select, input, textarea')) return;
        const direction = ARROW_DIRECTIONS[event.key];
        if (direction) {
            const canvasFocused = event.target === this.canvas;
            // Continuous reading keeps the browser's native vertical keys.
            if (direction.y && this.scrolling && canvasFocused) return;
            const pan = direction.x ? event.shiftKey && canvasFocused
                : !this.filmstrip.container.contains(event.target) && this.canvas.scrollHeight > this.canvas.clientHeight + 2;
            event.preventDefault();
            if (pan) this.canvas.scrollBy({left:direction.x * KEYBOARD_PAN_STEP, top:direction.y * KEYBOARD_PAN_STEP});
            else this.requestMove(direction.x < 0 || direction.y < 0, !event.repeat);
        } else if (['+', '=', '-'].includes(event.key)) {
            event.preventDefault();
            this.zoom(event.key === '-' ? -1 : 1);
        } else if (event.key.toLowerCase() === 'f') this.changeSize(ImageSize.DEFAULT);
        else if (event.key.toLowerCase() === 't') this.changeLayout(this.state.layout === ReadingLayout.STRIP ? ReadingLayout.SINGLE : ReadingLayout.STRIP);
    }

    onWheel(event) {
        if (isVideo(this.state.image)
            || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
            || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        const delta = event.deltaY * (event.deltaMode === 1 ? 16
            : event.deltaMode === 2 ? this.canvas.clientHeight : 1);
        const reverse = event.deltaY < 0;
        const overflow = this.state.size !== ImageSize.DEFAULT && this.viewport.overflows();
        const mode = overflow ? (this.viewport.canScroll(reverse) ? WheelMode.NATIVE_SCROLL : WheelMode.EDGE_TURN) : WheelMode.PAGE_TURN;
        const {native, turn, fresh} = this.wheel.update(delta, performance.now(), mode);
        if (native) return;
        event.preventDefault();
        if (turn) this.requestMove(reverse, fresh, reverse ? 'bottom' : 'top');
    }
}
