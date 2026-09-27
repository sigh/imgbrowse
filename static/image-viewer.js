import {imageUrl, walkImages} from './api.js';
import {byId, element, TaskScope} from './dom.js';
import {filename, parentPath} from './state.js';

const ZOOM_STEPS = [.1, .25, .5, .75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const NEARBY_COUNT = 4;
const LOADING_DELAY = 700;
const WHEEL_INTERVAL = 220;
const WHEEL_GESTURE_GAP = 300;
const PREVIOUS_KEYS = ['ArrowLeft', 'ArrowUp'];
const NEXT_KEYS = ['ArrowRight', 'ArrowDown'];

/** Single-image viewing, neighbor discovery, and deliberate boundary wrapping. */
export class ImageViewer {
    constructor(previews, {selectImage, close}) {
        this.previews = previews;
        this.selectImage = selectImage;
        this.close = close;
        this.container = byId('viewer');
        this.image = byId('viewer-image');
        this.canvas = byId('viewer-canvas');
        this.fit = 'page';
        this.zoom = 1;
        this.controlsHidden = false;
        this.thumbnailsVisible = true;
        this.strip = byId('viewer-strip');
        this.status = byId('viewer-status');
        this.collectionLabel = byId('viewer-collection');
        this.nameLabel = byId('viewer-name');
        this.closeButton = byId('viewer-close');
        this.wrapButton = byId('viewer-wrap');
        this.key = null;
        this.rootName = 'Collection';
        this.nearbyImages = [];
        this.nearbyCollection = null;
        this.boundaryDirection = null;
        this.lastWheel = 0;
        this.lastWheelEvent = -Infinity;
        this.bindControls();
        new ResizeObserver(() => this.sizeImage()).observe(this.canvas);
        this.image.addEventListener('load', () => this.sizeImage());
    }

    bindControls() {
        byId('viewer-zoom').addEventListener('change', event => {
            const value = event.target.value;
            if (value === 'page' || value === 'width') this.setFit(value);
            else {
                this.fit = 'manual';
                this.zoom = Number(value);
                this.sizeImage();
            }
        });
        byId('viewer-zoom-in').addEventListener('click', () => this.changeZoom(1));
        byId('viewer-zoom-out').addEventListener('click', () => this.changeZoom(-1));
        byId('viewer-thumbnails').addEventListener('change', () => this.toggleThumbnails());
        byId('viewer-controls').addEventListener('click', () => this.toggleControls());
        byId('viewer-show-controls').addEventListener('click', () => this.toggleControls());
        this.container.addEventListener('click', event => {
            if (!event.target.closest('#viewer-options')) byId('viewer-options').open = false;
        });
        this.closeButton.addEventListener('click', this.close);
        byId('viewer-prev').addEventListener('click', () => this.requestMove(true));
        byId('viewer-next').addEventListener('click', () => this.requestMove(false));
        this.wrapButton.addEventListener('click', () => {
            if (this.boundaryDirection === null) return;
            const reverse = this.boundaryDirection;
            this.clearBoundary();
            this.moveImage(reverse, true);
        });
        document.addEventListener('keydown', event => this.onKey(event));
        this.container.addEventListener('wheel', event => this.onWheel(event), {passive: false});
    }

    setFit(fit) {
        this.fit = fit;
        this.zoom = 1;
        this.canvas.scrollTo(0, 0);
        this.sizeImage();
    }

    changeZoom(direction) {
        const current = this.imageScale();
        const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
        this.zoom = steps.find(step => direction > 0 ? step > current + .001 : step < current - .001)
            ?? (direction > 0 ? ZOOM_STEPS.at(-1) : ZOOM_STEPS[0]);
        this.fit = 'manual';
        this.sizeImage();
    }

    imageScale() {
        if (this.fit === 'manual') return this.zoom;
        const width = this.image.naturalWidth || 1;
        const height = this.image.naturalHeight || 1;
        return this.fit === 'width' ? this.canvas.clientWidth / width
            : Math.min(this.canvas.clientWidth / width, this.canvas.clientHeight / height);
    }

    sizeImage() {
        const {naturalWidth: width, naturalHeight: height} = this.image;
        if (!width || !height || this.container.hidden) return;
        const scale = this.imageScale();
        this.image.style.width = Math.max(1, Math.floor(width * scale)) + 'px';
        this.image.style.height = Math.max(1, Math.floor(height * scale)) + 'px';
        byId('viewer-zoom').value = this.fit === 'manual' ? String(this.zoom) : this.fit;
        byId('viewer-zoom-out').disabled = scale <= ZOOM_STEPS[0];
        byId('viewer-zoom-in').disabled = scale >= ZOOM_STEPS.at(-1);
    }

    toggleThumbnails() {
        this.thumbnailsVisible = !this.thumbnailsVisible;
        this.strip.hidden = !this.thumbnailsVisible;
        byId('viewer-thumbnails').checked = this.thumbnailsVisible;
    }

    toggleControls() {
        this.controlsHidden = !this.controlsHidden;
        this.container.classList.toggle('controls-hidden', this.controlsHidden);
        byId('viewer-show-controls').hidden = !this.controlsHidden;
        byId('viewer-options').open = false;
        (this.controlsHidden ? byId('viewer-show-controls') : this.closeButton).focus();
    }

    setRootName(name) {
        this.rootName = name;
        if (this.state?.viewing) this.updateCollectionLabel();
    }

    updateCollectionLabel() {
        this.collectionLabel.textContent = (this.state.collection || this.rootName) + ' · all subfolders';
    }

    clearBoundary() {
        this.boundaryDirection = null;
        this.wrapButton.hidden = true;
        this.status.textContent = '';
    }

    clearNeighbors() {
        this.nearbyImages = [];
        this.nearbyCollection = null;
    }

    show(state, force = false) {
        this.state = state;
        const key = JSON.stringify([state.viewing, state.collection, state.image]);
        if (!force && key === this.key) return;
        this.key = key;
        this.scope?.dispose();
        this.moveScope?.dispose();
        this.moveScope = null;
        this.scope = new TaskScope();
        this.strip.replaceChildren();
        this.clearBoundary();
        this.container.setAttribute('aria-busy', 'false');
        if (force) this.clearNeighbors();
        const wasOpen = !this.container.hidden;
        this.container.hidden = !state.viewing;
        if (!state.viewing) {
            this.clearNeighbors();
            this.image.removeAttribute('src');
            if (wasOpen && this.previousFocus?.isConnected) this.previousFocus.focus({preventScroll: true});
            return;
        }
        if (!wasOpen) {
            if (this.controlsHidden) this.toggleControls();
            this.previousFocus = document.activeElement;
            this.closeButton.focus();
        }
        this.updateCollectionLabel();
        this.nameLabel.textContent = filename(state.image || '');
        this.nameLabel.title = state.image || '';
        byId('viewer-chapter').textContent = parentPath(state.image || '');
        this.canvas.scrollTo(0, 0);
        if (state.image) {
            // A bookmarked image loads directly, independent of neighbor discovery.
            const scope = this.scope;
            this.image.alt = filename(state.image);
            this.image.src = imageUrl(state.image);
            this.image.onerror = () => {
                if (!scope.signal.aborted) this.status.textContent = 'Image unavailable. You can still navigate to another image.';
            };
            this.loadStrip(state.image, state.collection, scope);
        } else {
            this.image.removeAttribute('src');
            this.moveImage();
        }
    }

    async loadStrip(image, collection, scope) {
        const request = reverse => walkImages({root: collection, anchor: image, reverse, limit: NEARBY_COUNT}, scope.signal);
        try {
            const [before, after] = await Promise.all([request(true), request(false)]);
            scope.signal.throwIfAborted();
            this.nearbyImages = [...before.images.reverse(), image, ...after.images];
            this.nearbyCollection = collection;
            for (const path of this.nearbyImages) {
                const button = element('button', path === image ? 'selected' : '');
                button.title = path;
                button.setAttribute('aria-label', 'View ' + filename(path));
                button.addEventListener('click', () => this.selectImage(path));
                this.strip.append(button);
                // An unavailable preview must not prevent selecting the image.
                this.previews.image(button, path, scope).catch(() => {});
            }
            this.strip.querySelector('.selected')?.scrollIntoView({block: 'nearest', inline: 'center'});
        } catch (error) {
            if (error.name !== 'AbortError') this.status.textContent = 'Nearby previews unavailable. ' + error.message;
        }
    }

    requestMove(reverse, freshGesture = true) {
        if (this.moveScope || !this.state.viewing) return;
        const wrap = this.boundaryDirection === reverse;
        if (wrap && !freshGesture) return;
        this.clearBoundary();
        this.moveImage(reverse, wrap);
    }

    cachedNeighbor(reverse) {
        if (this.nearbyCollection !== this.state.collection) return null;
        const index = this.nearbyImages.indexOf(this.state.image);
        return index < 0 ? null : this.nearbyImages[index + (reverse ? -1 : 1)];
    }

    async moveImage(reverse = false, wrap = false) {
        if (this.moveScope || !this.state.viewing) return;
        const neighbor = wrap ? null : this.cachedNeighbor(reverse);
        if (neighbor) {
            this.selectImage(neighbor);
            return;
        }
        const scope = this.moveScope = new TaskScope();
        this.container.setAttribute('aria-busy', 'true');
        this.clearBoundary();
        scope.delay(() => { this.status.textContent = 'Loading…'; }, LOADING_DELAY);
        const root = this.state.collection;
        const anchor = wrap ? null : this.state.image;
        let cursor = null;
        let warning = false;
        try {
            do {
                const page = await walkImages({root, anchor, reverse, cursor, limit: 1}, scope.signal);
                scope.signal.throwIfAborted();
                warning ||= page.warnings.length > 0;
                if (page.images.length) {
                    this.status.textContent = '';
                    this.selectImage(page.images[0]);
                    return;
                }
                cursor = page.cursor;
            } while (cursor !== null);
            this.showBoundary(reverse, warning);
        } catch (error) {
            if (error.name !== 'AbortError') this.status.textContent = error.message;
        } finally {
            scope.dispose();
            if (this.moveScope === scope) {
                this.moveScope = null;
                this.container.setAttribute('aria-busy', 'false');
            }
        }
    }

    showBoundary(reverse, warning) {
        if (!this.state.image) {
            this.status.textContent = warning
                ? 'No accessible images found; some folders could not be read.'
                : 'No images in this folder.';
            return;
        }
        this.status.textContent = (reverse ? 'Beginning of folder.' : 'End of folder.')
            + ' Press again or start a new scroll to wrap.'
            + (warning ? ' Some folders could not be read.' : '');
        this.boundaryDirection = reverse;
        this.wrapButton.textContent = reverse ? 'Go to last image' : 'Go to first image';
        this.wrapButton.hidden = false;
    }

    onKey(event) {
        if (!this.state?.viewing) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Escape') {
            if (byId('viewer-options').open) {
                byId('viewer-options').open = false;
                byId('viewer-options').querySelector('summary').focus();
            } else this.close();
        }
        else if (event.target instanceof Element && event.target.matches('select, input') && event.key !== 'Tab') return;
        else if (['+', '='].includes(event.key)) this.changeZoom(1);
        else if (event.key === '-') this.changeZoom(-1);
        else if (event.key.toLowerCase() === 'f') this.setFit('page');
        else if (event.key.toLowerCase() === 'w') this.setFit('width');
        else if (event.key.toLowerCase() === 't') this.toggleThumbnails();
        else if (event.key.toLowerCase() === 'h') this.toggleControls();
        else if (PREVIOUS_KEYS.includes(event.key) || NEXT_KEYS.includes(event.key)) {
            if ((this.fit !== 'page' || this.zoom !== 1) && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
                event.preventDefault();
                this.canvas.scrollBy({top: event.key === 'ArrowUp' ? -80 : 80});
                return;
            }
            event.preventDefault();
            this.requestMove(PREVIOUS_KEYS.includes(event.key), !event.repeat);
        } else if (event.key === 'Tab') {
            const buttons = [...this.container.querySelectorAll('button, select, input, summary')]
                .filter(node => node.getClientRects().length && !node.disabled && (!node.closest('details') || node.matches('summary') || node.closest('details').open));
            const index = buttons.indexOf(document.activeElement);
            const next = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
            event.preventDefault();
            buttons[next]?.focus();
        }
    }

    onWheel(event) {
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (this.fit !== 'page' || this.zoom !== 1) return;
        if (!this.state?.viewing || event.target.closest('.viewer-strip, .viewer-tools') || !event.deltaY) return;
        event.preventDefault();
        const now = performance.now();
        const freshGesture = now - this.lastWheelEvent > WHEEL_GESTURE_GAP;
        this.lastWheelEvent = now;
        if (now - this.lastWheel < WHEEL_INTERVAL) return;
        this.lastWheel = now;
        this.requestMove(event.deltaY < 0, freshGesture);
    }
}
