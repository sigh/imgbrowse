import {setIconButton} from '../shared/icons.js';
import {loadOriginal} from '../data/media-cache.js';
import {walkImages} from '../data/api.js';
import {byId, plainClick, TaskScope} from '../shared/dom.js';
import {filename, parentPath, ZOOM, ScreenMode, ReadingLayout, ImageSize, ViewerEntry, sortKey, sortSettings} from '../shared/state.js';
import {ViewerViewport, imageScale} from './viewer-viewport.js';
import {ContinuousReader} from './continuous-reader.js';
import {WheelGesture, WheelMode} from './wheel-gesture.js';

import {ThumbnailStrip} from './thumbnail-strip.js';
import {VideoPlayer} from './video-player.js';
import {CollectionNavigator, NavigationOutcome} from '../data/collection-navigator.js';
import {isVideo, canRetryMedia} from '../shared/media-kind.js';

const LOADING_DELAY = 700;
const PARTIAL_COLLECTION_MESSAGE = 'Some folders could not be read.';
const KEYBOARD_PAN_STEP = 80;
const ARROW_DIRECTIONS = Object.freeze({
    ArrowLeft: {x:-1, y:0}, ArrowRight: {x:1, y:0},
    ArrowUp: {x:0, y:-1}, ArrowDown: {x:0, y:1},
});

/** Coordinates media presentation and input; navigation and geometry are separate. */
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
        this.navigation = new CollectionNavigator({
            walk:walkImages, loadOriginal, select:selectImage,
            changed:outcomeChanged => this.navigationChanged(outcomeChanged), loadingDelay:LOADING_DELAY,
        });
        this.filmstrip = new ThumbnailStrip(this.strip, previews, selectImage);
        this.loadingImage = false;
        this.bindControls();
    }

    get scrolling() { return this.state?.layout === ReadingLayout.SCROLL; }
    get viewport() { return this.scrolling ? this.continuous : this.singleViewport; }

    showError(message) { this.status.textContent = message; }

    bindControls() {
        byId('viewer-zoom-in').addEventListener('click', () => this.zoom(1));
        byId('viewer-zoom-out').addEventListener('click', () => this.zoom(-1));
        byId('viewer-retry').addEventListener('click', () => { if (!this.navigation.retry()) this.refresh(); });
        this.previousButton.addEventListener('click', () => this.requestMove(true));
        this.nextButton.addEventListener('click', () => this.requestMove(false));
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
        const singleImage = this.scrolling ? this.continuous.singleImage : this.navigation.singleImage;
        const warning = this.state.mode === ScreenMode.VIEW && this.scrolling && this.continuous.warning
            ? PARTIAL_COLLECTION_MESSAGE : '';
        if (this.warning.textContent !== warning) this.warning.textContent = warning;
        const unavailable = this.state.mode !== ScreenMode.VIEW || isVideo(this.state.image);
        const sizeControl = document.querySelector('.viewer-tools');
        sizeControl.classList.toggle('unavailable', unavailable);
        sizeControl.inert = unavailable;
        const hasImage = Boolean(this.state.image);
        this.previousButton.disabled = !hasImage || singleImage || this.navigation.moving;
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
            const wrap = this.navigation.boundary === reverse;
            const name = wrap ? (reverse ? 'last' : 'first') : (reverse ? 'previous' : 'next');
            const label = wrap ? (reverse ? 'Go to last item' : 'Go to first item')
                : (reverse ? 'Previous item' : 'Next item');
            setIconButton(button, name, label, `${label} (${reverse ? '←' : '→'})`);
            button.classList.toggle('wrap', wrap);
        }
        this.container.setAttribute('aria-busy', String(this.loadingImage || this.scrolling && this.continuous.loading || this.navigation.moving));
    }

    navigationChanged(outcomeChanged) {
        if (!outcomeChanged) { this.updateControls(); return; }
        const outcome = this.navigation.outcome;
        if (outcome) {
            const {kind, reverse, warning} = outcome;
            const direction = reverse ? 'previous' : 'next';
            switch (kind) {
                case NavigationOutcome.FINDING:
                    this.status.textContent = `Finding the ${direction} item…`;
                    break;
                case NavigationOutcome.ONLY:
                    this.status.textContent = 'This is the only item in the collection.';
                    break;
                case NavigationOutcome.ERROR:
                    this.status.textContent = `Unable to find the ${direction} item.`;
                    break;
                case NavigationOutcome.EMPTY:
                    this.status.textContent = warning ? 'No accessible media found. ' + PARTIAL_COLLECTION_MESSAGE
                        : 'No images or videos in this collection.';
                    break;
                case NavigationOutcome.BOUNDARY:
                    this.status.textContent = (reverse ? 'Beginning' : 'End') + ' of collection.'
                        + (warning ? ' ' + PARTIAL_COLLECTION_MESSAGE : '');
                    break;
            }
        } else this.status.textContent = '';
        byId('viewer-retry').hidden = !this.navigation.retryMove;
        this.updateControls();
    }

    stopReading() {
        this.navigation.stopPrefetch();
        this.singleViewport.clear();
        this.continuous.stop();
    }

    /** Preserve source coordinates before the app changes screen geometry. */
    prepareTransition(state) {
        const wasOverview = (this.state?.mode === ScreenMode.OVERVIEW);
        const layoutChanged = this.state?.layout !== state.layout;
        const orderingChanged = sortKey(this.state) !== sortKey(state);
        const sameImage = this.state?.collection === state.collection && this.state?.image === state.image;
        const anchor = sameImage && (layoutChanged || orderingChanged) && this.state?.mode === ScreenMode.VIEW && state.mode === ScreenMode.VIEW ? this.viewport.point() : null;
        if (!sameImage || state.mode === ScreenMode.BROWSE) this.overviewPoint = null;
        else if (!wasOverview && state.mode === ScreenMode.OVERVIEW) this.overviewPoint = this.viewport.point();
        const point = wasOverview && state.mode === ScreenMode.VIEW ? this.overviewPoint : anchor;
        if (state.mode !== ScreenMode.OVERVIEW) this.overviewPoint = null;
        return point;
    }

    show(state, force = false, entry = ViewerEntry.TOP, point = null) {
        const wasOverview = this.state?.mode === ScreenMode.OVERVIEW;
        const wasOpen = Boolean(this.state && this.state.mode !== ScreenMode.BROWSE);
        const folderChanged = this.state?.folder !== state.folder;
        const layoutChanged = this.state?.layout !== state.layout;
        const orderingChanged = sortKey(this.state) !== sortKey(state);
        const wheelEnabled = state.mode === ScreenMode.VIEW && state.layout !== ReadingLayout.SCROLL;
        const wheelWasEnabled = this.state?.mode === ScreenMode.VIEW && this.state?.layout !== ReadingLayout.SCROLL;
        if (wheelEnabled !== wheelWasEnabled) {
            const stage = byId('viewer-stage');
            if (wheelEnabled) stage.addEventListener('wheel', this.wheelListener, {passive:false});
            else stage.removeEventListener('wheel', this.wheelListener);
        }
        this.state = state;
        const key = JSON.stringify([state.mode, state.collection, state.image, this.scrolling, sortKey(state)]);
        if (!force && key === this.key) {
            if (this.viewport.size !== state.size) this.viewport.setSize(state.size);
            this.updateControls();
            if (state.mode !== ScreenMode.BROWSE && folderChanged) this.updateCollectionLabel();
            if (state.mode !== ScreenMode.BROWSE && (folderChanged || layoutChanged)) {
                this.renderStrip();
                if (point) this.viewport.resize(point);
            }
            return;
        }
        this.key = key;
        this.scope?.dispose();
        this.navigation.configure(state, force);
        this.scope = new TaskScope();
        this.loadingImage = false;
        this.status.textContent = '';
        byId('viewer-retry').hidden = true;
        if (state.mode !== ScreenMode.VIEW) {
            this.stopReading();
            this.renderStrip();
        }
        if (state.mode === ScreenMode.BROWSE) {
            this.navigation.setPaths([], null);
            this.updateControls();
            return;
        }
        if (!wasOpen) {
            if (state.mode !== ScreenMode.OVERVIEW) this.canvas.focus({preventScroll: true});
        } else if (wasOverview && state.mode !== ScreenMode.OVERVIEW) this.canvas.focus({preventScroll: true});
        if (state.mode === ScreenMode.OVERVIEW) {
            this.updateControls();
            this.updateCollectionLabel();
            return;
        }
        this.canvas.querySelector('.image-surface').hidden = this.scrolling;
        if (!this.scrolling || this.continuous.collection !== state.collection || !state.image) this.continuous.stop();
        this.updateCollectionLabel();
        this.updateControls();
        if (state.image) {
            this.renderStrip(force || orderingChanged);
            if (this.scrolling) {
                if (this.singleViewport.image.id) {
                    this.singleViewport.clear();
                    this.singleViewport.image.removeAttribute('id');
                }
                this.continuous.show(state, force || orderingChanged, entry, point);
                this.navigation.setPaths(this.continuous.paths, state.collection);
            } else {
                this.singleViewport.image.id = 'viewer-image';
                this.loadImage(state.image, this.scope, entry, point);
                this.navigation.discover(state.image, state.collection, this.scope.signal);
            }
        } else {
            this.singleViewport.clear();
            this.updateControls();
            this.navigation.move();
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
            if (this.navigation.boundary === null && !this.navigation.moving) this.status.textContent = '';
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
                this.navigation.prefetch(this.state.mode === ScreenMode.VIEW && !this.scrolling);
            }
        }
    }

    renderStrip(force = false) {
        this.filmstrip.show(this.state, this.state.mode === ScreenMode.VIEW && this.state.layout === ReadingLayout.STRIP, force);
    }

    requestMove(reverse, fresh = true, entry = ViewerEntry.TOP) {
        if (this.state.mode === ScreenMode.BROWSE || this.scrolling && this.continuous.singleImage) return;
        this.navigation.request(reverse, fresh, entry, this.scrolling && this.continuous.warning);
    }

    onKey(event) {
        if (!this.state || this.state.mode === ScreenMode.BROWSE || event.ctrlKey || event.metaKey || event.altKey) return;
        if (document.fullscreenElement) return;
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
            const stripFocused = this.filmstrip.container.contains(event.target);
            if (direction.y && !canvasFocused && !stripFocused) return;
            // Continuous reading keeps the browser's native vertical keys.
            if (direction.y && this.scrolling && canvasFocused) return;
            const pan = direction.x ? event.shiftKey && canvasFocused
                : !stripFocused && this.canvas.scrollHeight > this.canvas.clientHeight + 2;
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
        if (turn) this.requestMove(reverse, fresh, reverse ? ViewerEntry.BOTTOM : ViewerEntry.TOP);
    }
}
