import {getMetadata, walkImages} from '../data/api.js';
import {element, TaskScope} from '../shared/dom.js';
import {loadOriginal} from '../data/media-cache.js';
import {isVideo, canRetryMedia} from '../shared/media-kind.js';
import {CollectionWindow} from '../data/collection-window.js';
import {filename, ImageSize, ItemType, ReadingLayout, ViewerEntry, sortKey, sortSettings} from '../shared/state.js';
import {imageScale} from './viewer-viewport.js';

const PAGE_SIZE = 8;
const MAX_ITEMS = 32;

/** A native column with bounded paths and originals mounted near the viewport. */
export class ContinuousReader {
    constructor(canvas, {selectImage, changed, video}) {
        Object.assign(this, {canvas, selectImage, changed, video});
        this.surface = element('div', 'continuous-surface');
        this.surface.hidden = true;
        canvas.append(this.surface);
        this.items = [];
        this.failures = [true, false].map(reverse => {
            const button = element('button', 'reader-discovery ' + (reverse ? 'before' : 'after'), 'Retry');
            button.setAttribute('aria-label', `Retry loading ${reverse ? 'previous' : 'next'} pages`);
            button.hidden = true;
            button.addEventListener('click', () => {
                const edge = this.edges[reverse ? 0 : 1];
                edge.failed = false; button.hidden = true; this.discover(edge);
            });
            this.surface.append(button);
            return button;
        });
        canvas.addEventListener('scroll', () => {
            if (!this.scope) return;
            if (canvas.scrollTop !== this.scrollTop) {
                const current = this.items.find(item => item.top + item.displayHeight > canvas.scrollTop + 1) || this.items.at(-1);
                if (current && current.path !== this.currentPath) this.selectImage(current.path, ViewerEntry.KEEP);
            }
            this.scrollTop = canvas.scrollTop;
            this.schedule();
        });
        new ResizeObserver(() => this.resize()).observe(canvas);
    }

    get paths() { return this.window?.paths || []; }
    get edges() { return this.window?.edges; }
    get warning() { return this.window?.warning || false; }
    get current() { return this.items.find(item => item.path === this.currentPath); }
    get image() { return this.current?.media; }
    get ready() { return this.image instanceof HTMLImageElement && this.image.naturalWidth > 0; }
    get scale() { return this.current?.scale || 1; }
    get loading() { return Boolean(this.current?.scope && !this.current.media && !this.current.failed); }
    get singleImage() { return this.items.length === 1 && this.edges?.every(edge => edge.done && !edge.warning); }

    point() {
        const item = this.current;
        if (!item || !this.box) return null;
        return {path:item.path, x:(this.canvas.scrollLeft + this.box.width/2 - item.left)/item.scale,
            y:(this.canvas.scrollTop - item.top)/item.scale, alignY:0};
    }

    setSize(size) { const point = this.point(); this.size = size; this.resize(point); }

    show(state, force, entry, point) {
        const reset = force || !this.scope || this.collection !== state.collection
            || sortKey(this.ordering) !== sortKey(state) || !this.items.some(item => item.path === state.image);
        if (!reset && entry === ViewerEntry.KEEP && this.size === state.size && !point) {
            this.currentPath = state.image;
            this.identify(); this.changed();
            return;
        }
        if (reset) {
            this.stop();
            this.scope = new TaskScope();
            this.collection = state.collection;
            this.ordering = sortSettings(state);
            this.items = [this.createItem(state.image)];
            this.surface.insertBefore(this.items[0].row, this.failures[1]);
            this.window = new CollectionWindow(walkImages, {root:state.collection, image:state.image, pageSize:PAGE_SIZE, maxPaths:MAX_ITEMS, ordering:this.ordering});
        }
        this.surface.hidden = false;
        this.currentPath = state.image;
        this.size = state.size;
        this.resize(point || (entry === ViewerEntry.KEEP && !reset ? this.point() : {path:state.image, x:null, y:0, alignY:0}));
        if (reset) this.dimensions(this.items, this.scope);
        this.identify();
    }

    createItem(path) {
        const row = element('div', 'reader-item');
        row.dataset.path = path;
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', filename(path));
        const feedback = element('div', 'reader-status');
        feedback.setAttribute('role', 'status');
        row.append(feedback);
        return {path, row, feedback, width:1600, height:isVideo(path) ? 900 : 2400, work:new TaskScope()};
    }

    async dimensions(items, scope) {
        const pending = items.filter(item => !isVideo(item.path));
        const worker = async () => {
            while (pending.length && !scope.signal.aborted) {
                const item = pending.shift();
                try {
                    const info = await getMetadata(item.path, item.work.signal, {kind:ItemType.MEDIA});
                    item.work.signal.throwIfAborted();
                    if (info.width && info.height) {
                        const point = this.point();
                        const rotated = Number(info.exif?.Orientation) >= 5 && Number(info.exif?.Orientation) <= 8;
                        item.width = rotated ? info.height : info.width;
                        item.height = rotated ? info.width : info.height;
                        this.resize(point);
                    }
                } catch (error) {
                    // Original loading supplies dimensions too; a metadata failure does not block reading.
                }
            }
        };
        await Promise.all([worker(), worker()]);
    }

    resize(point = this.point()) {
        if (!this.scope || !this.canvas.clientWidth || !this.canvas.clientHeight) return;
        const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
        const gap = parseFloat(getComputedStyle(this.surface).rowGap);
        for (const item of this.items) {
            item.scale = imageScale(isVideo(item.path) ? ImageSize.DEFAULT : this.size, ReadingLayout.SCROLL, item.width, item.height, width, height);
            item.displayWidth = Math.max(1, Math.floor(item.width * item.scale));
            item.displayHeight = Math.max(1, Math.floor(item.height * item.scale));
        }
        const surfaceWidth = Math.max(width, ...this.items.map(item => item.displayWidth));
        this.surface.style.width = surfaceWidth + 'px';
        let top = 0;
        for (const item of this.items) {
            item.top = top; item.left = (surfaceWidth - item.displayWidth) / 2;
            item.row.style.height = item.displayHeight + 'px';
            if (item.media) {
                item.media.style.width = item.displayWidth + 'px';
                item.media.style.height = item.displayHeight + 'px';
                if (item.media instanceof HTMLImageElement) {
                    item.media.width = item.displayWidth; item.media.height = item.displayHeight;
                }
            }
            top += item.displayHeight + gap;
        }
        this.box = {width, height};
        const anchor = point && this.items.find(item => item.path === point.path);
        if (anchor) {
            this.canvas.scrollLeft = anchor.left + (point.x ?? anchor.width/2)*anchor.scale - width/2;
            this.canvas.scrollTop = anchor.top + point.y*anchor.scale - height*(point.alignY ?? 0);
        }
        // Layout corrections preserve the selected item; native reading movement changes it.
        this.scrollTop = this.canvas.scrollTop;
        this.schedule();
        this.changed();
    }

    schedule() {
        if (!this.scope || this.scheduled) return;
        this.scheduled = true;
        requestAnimationFrame(() => { this.scheduled = false; if (this.scope) this.update(); });
    }

    update() {
        const top = this.canvas.scrollTop, height = this.canvas.clientHeight;
        for (const item of this.items) {
            if (item.top + item.displayHeight >= top - height && item.top <= top + 2*height) this.mount(item);
            else this.unmount(item);
        }
        this.identify();
        if (top < 2*height) this.discover(this.edges[0]);
        if (top + 3*height > this.surface.scrollHeight) this.discover(this.edges[1]);
        this.changed();
    }

    identify() {
        for (const item of this.items) {
            if (!item.media) continue;
            if (item.path === this.currentPath) item.media.id = isVideo(item.path) ? 'viewer-video' : 'viewer-image';
            else item.media.removeAttribute('id');
        }
    }

    async mount(item) {
        if (item.scope) return;
        const scope = item.scope = new TaskScope();
        item.failed = false;
        scope.delay(() => { if (!item.media && !item.failed) item.feedback.textContent = 'Loading…'; }, 700);
        try {
            let point;
            if (isVideo(item.path)) {
                const video = this.video.create(item.path, scope, error => this.failure(item, error));
                item.media = video;
                video.addEventListener('loadedmetadata', () => {
                    if (video.videoWidth && video.videoHeight) {
                        const point = this.point();
                        item.width = video.videoWidth; item.height = video.videoHeight;
                        this.resize(point);
                    }
                });
                for (const name of ['pointerdown', 'focusin']) video.addEventListener(name, () => this.selectImage(item.path, ViewerEntry.KEEP));
            } else {
                const {image} = await loadOriginal(item.path, scope.signal);
                scope.signal.throwIfAborted();
                item.media = image;
                image.draggable = false;
                point = this.point();
                item.width = image.naturalWidth; item.height = image.naturalHeight;
                scope.onDispose(() => { image.removeAttribute('id'); image.remove(); });
            }
            item.feedback.replaceChildren();
            item.row.prepend(item.media);
            this.identify();
            this.resize(point);
        } catch (error) {
            if (error.name !== 'AbortError' && !scope.signal.aborted) this.failure(item, error);
        }
    }

    failure(item, error) {
        item.failed = true;
        item.feedback.textContent = 'Unable to open ' + filename(item.path) + '. ';
        if (canRetryMedia(error)) {
            const retry = element('button', '', 'Retry');
            retry.addEventListener('click', () => { this.unmount(item); this.mount(item); });
            item.feedback.append(retry);
        }
        this.changed();
    }

    unmount(item) {
        item.scope?.dispose(); item.scope = null; item.media = null;
        item.feedback.replaceChildren();
    }

    async discover(edge) {
        if (!this.window.canLoad(edge)) return;
        const scope = this.scope;
        try {
            const change = await this.window.load(edge, scope.signal, {anchor:this.currentPath});
            if (!change) return;
            const point = this.point();
            let added;
            if (change.reconciled) {
                const retained = new Map(this.items.map(item => [item.path, item]));
                const wanted = new Set(this.paths);
                for (const item of this.items) if (!wanted.has(item.path)) {
                    this.unmount(item); item.work.dispose(); item.row.remove();
                }
                added = [];
                this.items = this.paths.map(path => {
                    if (retained.has(path)) return retained.get(path);
                    const item = this.createItem(path); added.push(item); return item;
                });
                this.failures[0].after(...this.items.map(item => item.row));
            } else {
                added = change.added.map(path => this.createItem(path));
                if (edge.reverse) { this.items.unshift(...added); this.failures[0].after(...added.map(item => item.row)); }
                else { this.items.push(...added); this.failures[1].before(...added.map(item => item.row)); }
                if (change.removed.length) {
                    const retired = this.items.splice(edge.reverse ? this.paths.length : 0, change.removed.length);
                    for (const item of retired) { this.unmount(item); item.work.dispose(); item.row.remove(); }
                }
            }
            this.resize(point);
            this.dimensions(added, scope);
        } finally {
            if (scope === this.scope) {
                this.failures[edge.reverse ? 0 : 1].hidden = !edge.failed;
                this.schedule();
            }
        }
    }

    stop() {
        this.scope?.dispose(); this.scope = null;
        for (const item of this.items) { this.unmount(item); item.work.dispose(); item.row.remove(); }
        this.items = []; this.box = null;
        this.window = null;
        this.surface.hidden = true;
        for (const button of this.failures) button.hidden = true;
    }
}
