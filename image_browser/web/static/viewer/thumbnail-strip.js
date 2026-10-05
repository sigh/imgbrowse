import {isVideo} from '../shared/media-kind.js';
import {walkImages} from '../data/api.js';
import {CollectionWindow} from '../data/collection-window.js';
import {element, TaskScope} from '../shared/dom.js';
import {icon} from '../shared/icons.js';
import {filename, sortKey, sortSettings, ViewerEntry} from '../shared/state.js';
import {ThumbnailLayout} from './thumbnail-layout.js';

const PAGE_SIZE = 32;
const MAX_PATHS = 2048;

/** Stable native scroller with a bounded path window and virtual button elements. */
export class ThumbnailStrip {
    constructor(container, previews, selectImage) {
        Object.assign(this, {container, previews, selectImage});
        this.nodes = new Map();
        this.window = new CollectionWindow(walkImages, {pageSize:PAGE_SIZE, maxPaths:MAX_PATHS});
        this.frame = element('div', 'strip-frame');
        container.before(this.frame); this.frame.append(container);
        this.content = element('div', 'strip-content');
        container.append(this.content);
        const style = getComputedStyle(container);
        this.gap = parseFloat(style.columnGap);
        this.paddingStart = parseFloat(style.paddingLeft);
        this.paddingEnd = parseFloat(style.paddingRight);
        this.defaultSize = parseFloat(style.getPropertyValue('--thumbnail-default-height'));
        this.defaultWidth = parseFloat(style.getPropertyValue('--thumbnail-default-width'));
        this.folderWidth = parseFloat(style.getPropertyValue('--strip-folder-width'));
        this.folderGap = parseFloat(style.getPropertyValue('--strip-folder-gap'));
        this.createResizer();
        this.failures = [true, false].map(reverse => {
            const button = element('button', 'strip-error ' + (reverse ? 'before' : 'after'));
            button.append(icon('brokenImage')); button.hidden = true;
            button.title = 'Could not load more thumbnails. Retry';
            button.setAttribute('aria-label', button.title);
            button.addEventListener('click', () => {
                const edge = this.edges[reverse ? 0 : 1];
                edge.failed = false; this.discover(edge);
            });
            this.frame.append(button); return button;
        });
        container.addEventListener('wheel', event => {
            if (event.ctrlKey || event.metaKey || event.deltaX || !event.deltaY) return;
            event.preventDefault();
            container.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientWidth : 1);
        }, {passive: false});
        container.addEventListener('focusin', event => {
            if (event.target === container) {
                this.show({...this.ordering, collection: this.collection, folder: this.labelRoot, image: this.image}, true, true);
                return;
            }
            if (event.target.dataset.path === this.image) {
                const bounds = event.target.getBoundingClientRect();
                const viewport = container.getBoundingClientRect();
                if (bounds.left < viewport.left || bounds.right > viewport.right) this.centerImage();
            }
        });
        container.addEventListener('scroll', () => {
            if (Math.abs(container.scrollLeft - (this.followScroll || 0)) > 1) this.followImage = false;
            if (this.scheduled) return;
            this.scheduled = true;
            requestAnimationFrame(() => {
                this.scheduled = false; this.render(); this.discoverEdges();
            });
        });
        this.resizeObserver = new ResizeObserver(() => {
            if (!this.visible || !this.scope) return;
            if (this.size > this.maxSize()) this.setSize(this.size);
            else if (this.followImage) this.centerImage();
            else this.render();
            this.discoverEdges();
        });
        this.resizeObserver.observe(container);
    }

    get paths() { return this.window.paths; }
    get edges() { return this.window.edges; }

    createResizer() {
        this.size = this.defaultSize;
        const handle = element('div', 'strip-resizer');
        this.handle = handle;
        handle.tabIndex = 0;
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-label', 'Thumbnail size');
        handle.setAttribute('aria-orientation', 'horizontal');
        handle.title = 'Thumbnail size (drag or ↑/↓)';
        this.frame.prepend(handle);
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            this.drag = {y: event.clientY, size: this.size};
            handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener('pointermove', event => {
            if (this.drag) this.setSize(this.drag.size + this.drag.y - event.clientY);
        });
        const finish = () => {
            this.drag = null;
            sessionStorage.setItem('thumbnailSize', String(this.size));
        };
        handle.addEventListener('lostpointercapture', finish);
        handle.addEventListener('keydown', event => {
            const steps = {ArrowUp: 16, ArrowDown: -16};
            if (!(event.key in steps)) return;
            event.preventDefault();
            this.setSize(this.size + steps[event.key]); finish();
        });
        const saved = Number(sessionStorage.getItem('thumbnailSize'));
        this.setSize(saved || this.defaultSize);
    }

    maxSize() {
        return Math.max(48, Math.min(240, Math.floor(window.innerHeight * .35)));
    }

    captureAnchor(options) {
        if (!this.visible || !this.scope) return null;
        return this.layout?.anchor(this.container.scrollLeft, this.container.clientWidth, options);
    }

    reflow(anchor) {
        this.layout = new ThumbnailLayout(this.paths, {
            width:this.width, gap:this.gap, folderWidth:this.folderWidth, folderGap:this.folderGap,
            labelRoot:this.labelRoot || '', leadingKnown:this.edges[0].done,
            paddingStart:this.paddingStart, paddingEnd:this.paddingEnd,
        });
        this.content.style.width = this.layout.contentWidth + 'px';
        const point = this.followImage ? {path:this.image, fraction:.5, x:this.container.clientWidth / 2} : anchor;
        this.render(this.layout.scrollLeft(point, this.container.clientWidth) ?? this.container.scrollLeft);
    }

    setSize(size) {
        const max = this.maxSize();
        const anchor = !this.followImage ? this.captureAnchor() : null;
        this.size = Math.round(Math.max(48, Math.min(max, size)));
        this.width = Math.round(this.size * this.defaultWidth / this.defaultSize);
        this.frame.style.setProperty('--thumbnail-height', this.size + 'px');
        this.frame.style.setProperty('--thumbnail-width', this.width + 'px');
        this.handle.setAttribute('aria-valuemin', '48');
        this.handle.setAttribute('aria-valuemax', String(max));
        this.handle.setAttribute('aria-valuenow', String(this.size));
        if (!this.scope) return;
        this.reflow(anchor);
    }

    stop() {
        this.scope?.dispose(); this.scope = null;
        for (const {scope} of this.nodes.values()) scope.dispose();
        this.nodes.clear(); this.content.replaceChildren(); this.layout = null;
        for (const edge of this.edges || []) edge.loading = false;
    }

    reset(collection, image, ordering) {
        this.stop(); this.collection = collection;
        this.ordering = ordering;
        this.window = new CollectionWindow(walkImages, {root:collection, image, pageSize:PAGE_SIZE, maxPaths:MAX_PATHS, ordering});
        this.scrollTo(0);
    }

    show(state, visible, force = false) {
        const {collection, folder, image} = state;
        const hadFocus = this.container.contains(document.activeElement);
        const reset = force || collection !== this.collection || sortKey(this.ordering) !== sortKey(state)
            || (image && !this.paths.includes(image));
        const followImage = this.followImage || !this.visible || image !== this.image || reset;
        const anchor = visible && !followImage ? this.captureAnchor({preferred:folder !== this.labelRoot ? image : null}) : null;
        // Collection controls traversal; the URL folder controls displayed paths.
        this.labelRoot = folder;
        if (reset) this.reset(collection, image, sortSettings(state));
        this.visible = visible; this.container.hidden = !visible; this.frame.hidden = !visible;
        if (!visible) { this.stop(); return; }
        if (!this.scope) this.scope = new TaskScope();
        this.image = image;
        this.followImage = Boolean(followImage);
        this.reflow(anchor);
        if (hadFocus) this.nodes.get(image)?.button.focus({preventScroll: true});
        this.discoverEdges();
    }

    scrollTo(left) {
        this.container.scrollLeft = left;
        this.followScroll = this.container.scrollLeft;
    }

    centerImage() {
        const left = this.layout?.scrollLeft({path:this.image, fraction:.5, x:this.container.clientWidth / 2}, this.container.clientWidth);
        if (left != null) this.render(left);
    }

    updateEdges() {
        const {scrollLeft, scrollWidth, clientWidth} = this.container;
        const more = [scrollLeft > 1 || !this.edges[0].done,
            scrollLeft + clientWidth < scrollWidth - 1 || !this.edges[1].done];
        this.container.classList.toggle('more-before', more[0]);
        this.container.classList.toggle('more-after', more[1]);
        this.failures.forEach((button, index) => {
            button.hidden = !this.edges[index].failed;
        });
    }

    render(left = this.container.scrollLeft) {
        if (!this.visible || !this.scope || !this.layout) return;
        // Discovery can move the bounded path window past the current image.
        this.container.tabIndex = this.layout.byPath.has(this.image) ? -1 : 0;
        const focused = document.activeElement;
        const visible = new Map(this.layout.visible(left, this.container.clientWidth).map(item => [item.path, item]));
        // Keep the tab stop and focused tile mounted outside the virtual window.
        for (const path of [this.image, focused?.dataset.path]) {
            const item = this.layout.byPath.get(path);
            if (item) visible.set(path, item);
        }
        for (const [path, item] of this.nodes) {
            if (!visible.has(path)) { item.scope.dispose(); item.tile.remove(); this.nodes.delete(path); }
        }
        let cursor = this.content.firstChild;
        for (const geometry of [...visible.values()].sort((a, b) => a.index - b.index)) {
            const {path} = geometry;
            let item = this.nodes.get(path);
            if (!item) {
                const button = element('button');
                button.dataset.path = path; button.title = path;
                button.setAttribute('aria-label', `View ${isVideo(path) ? 'video' : 'image'} ${filename(path)}`);
                button.addEventListener('click', () => this.selectImage(path, ViewerEntry.TOP));
                const tile = element('div', 'strip-tile');
                const label = element('span', 'strip-folder');
                tile.append(label, button);
                item = {button, tile, label, scope: new TaskScope()}; this.nodes.set(path, item);
                this.previews.thumbnail(button, path, item.scope).catch(error => {
                    if (item.scope.signal.aborted) return;
                    button.replaceChildren(icon('brokenImage'));
                    button.title = 'Thumbnail unavailable: ' + path;
                });
            }
            item.tile.style.setProperty('--strip-tile-width', geometry.right - geometry.left + 'px');
            item.tile.style.setProperty('--thumbnail-offset', geometry.left + 'px');
            item.button.tabIndex = path === this.image ? 0 : -1;
            item.button.classList.toggle('selected', path === this.image);
            if (path === this.image) item.button.setAttribute('aria-current', 'true');
            else item.button.removeAttribute('aria-current');
            item.tile.classList.toggle('folder-start', geometry.boundary);
            const {label} = geometry;
            item.label.textContent = label;
            item.label.title = label;
            item.label.hidden = !label;
            if (item.tile !== cursor) this.content.insertBefore(item.tile, cursor);
            cursor = item.tile.nextSibling;
        }
        if (focused?.isConnected && visible.has(focused.dataset.path) && document.activeElement !== focused) {
            focused.focus({preventScroll: true});
        }
        this.scrollTo(left);
        this.updateEdges();
        this.previews.schedule();
    }

    discoverEdges() {
        if (!this.visible || !this.scope || !this.paths.length) return;
        const {scrollLeft, clientWidth, scrollWidth} = this.container;
        if (scrollLeft < 120) this.discover(this.edges[0]);
        if (scrollLeft + clientWidth > scrollWidth - 120) this.discover(this.edges[1]);
    }

    async discover(edge) {
        if (!this.window.canLoad(edge)) return;
        const scope = this.scope;
        this.container.setAttribute('aria-busy', 'true');
        try {
            const change = await this.window.load(edge, scope.signal, {anchor:this.image});
            if (!change) return;
            const anchor = !this.followImage ? this.captureAnchor({retained:new Set(this.paths)}) : null;
            this.reflow(anchor);
        } finally {
            if (scope === this.scope) {
                this.container.setAttribute('aria-busy', String(this.edges.some(item => item.loading)));
                this.updateEdges();
                if (!edge.done && !edge.failed) requestAnimationFrame(() => this.discoverEdges());
            }
        }
    }
}
