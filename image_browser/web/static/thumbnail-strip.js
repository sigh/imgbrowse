import {isVideo} from './media-kind.js';
import {walkImages} from './api.js';
import {element, TaskScope} from './dom.js';
import {icon} from './icons.js';
import {filename, parentPath, relativePath} from './state.js';

const PAGE_SIZE = 32;
const MAX_PATHS = 2048;
const GAP = 6;
const DEFAULT_SIZE = 64;

/** Stable native scroller with a bounded path window and virtual button elements. */
export class ThumbnailStrip {
    constructor(container, previews, selectImage) {
        Object.assign(this, {container, previews, selectImage});
        this.frame = element('div', 'strip-frame');
        container.before(this.frame); this.frame.append(container);
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
        container.addEventListener('pointerdown', () => { this.followImage = false; });
        container.addEventListener('wheel', event => {
            this.followImage = false;
            if (event.ctrlKey || event.metaKey || event.deltaX || !event.deltaY) return;
            event.preventDefault();
            container.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientWidth : 1);
        }, {passive: false});
        container.addEventListener('focusin', event => {
            if (event.target === container) {
                this.show({collection: this.collection, folder: this.labelRoot, image: this.image}, true, true);
                return;
            }
            if (event.target.dataset.path === this.image) {
                const bounds = event.target.getBoundingClientRect();
                const viewport = container.getBoundingClientRect();
                if (bounds.left < viewport.left || bounds.right > viewport.right) this.centerImage();
            }
        });
        this.paths = [];
        this.nodes = new Map();
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

    createResizer() {
        this.size = DEFAULT_SIZE;
        this.width = this.size - GAP;
        this.stride = this.size;
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
            event.preventDefault(); event.stopPropagation();
            this.setSize(this.size + steps[event.key]); finish();
        });
        const saved = Number(sessionStorage.getItem('thumbnailSize'));
        this.setSize(saved || DEFAULT_SIZE);
    }

    maxSize() {
        return Math.max(48, Math.min(240, Math.floor(window.innerHeight * .35)));
    }

    tileWidth(path) { return isVideo(path) ? Math.round(this.size * 16 / 9) : this.width; }

    offsets() {
        const offsets = [0];
        for (const path of this.paths || []) offsets.push(offsets.at(-1) + this.tileWidth(path) + GAP);
        return offsets;
    }

    setSize(size) {
        const max = this.maxSize();
        const oldOffsets = this.offsets();
        const left = Math.max(0, this.container.scrollLeft - 12);
        const anchor = Math.max(0, oldOffsets.findIndex(offset => offset > left) - 1);
        const fraction = (left - oldOffsets[anchor]) / ((oldOffsets[anchor + 1] - oldOffsets[anchor]) || 1);
        this.size = Math.round(Math.max(48, Math.min(max, size)));
        this.width = Math.round(this.size * 58 / 64);
        this.stride = this.width + GAP;
        this.frame.style.setProperty('--thumbnail-height', this.size + 'px');
        this.frame.style.setProperty('--thumbnail-width', this.width + 'px');
        this.handle.setAttribute('aria-valuemin', '48');
        this.handle.setAttribute('aria-valuemax', String(max));
        this.handle.setAttribute('aria-valuenow', String(this.size));
        if (!this.scope) return;
        this.render();
        if (this.followImage) this.centerImage();
        else {
            const offsets = this.offsets();
            const width = (offsets[anchor + 1] - offsets[anchor]) || 1;
            this.scrollTo(offsets[anchor] + fraction * width + 12);
            this.render();
        }
    }

    stop() {
        this.scope?.dispose(); this.scope = null;
        for (const {scope} of this.nodes.values()) scope.dispose();
        this.nodes.clear(); this.container.replaceChildren();
        for (const edge of this.edges || []) edge.loading = false;
    }

    reset(collection, image) {
        this.stop(); this.collection = collection;
        this.paths = image ? [image] : [];
        this.edges = [true, false].map(reverse => ({reverse, cursor: null, done: false, loading: false}));
        this.scrollTo(0);
    }

    show({collection, folder, image}, visible, force = false) {
        const hadFocus = this.container.contains(document.activeElement);
        // Collection controls traversal; the URL folder controls displayed paths.
        this.labelRoot = folder;
        if (force || collection !== this.collection || (image && !this.paths.includes(image))) this.reset(collection, image);
        const opening = !this.visible;
        this.visible = visible; this.container.hidden = !visible; this.frame.hidden = !visible;
        if (!visible) { this.stop(); return; }
        if (!this.scope) this.scope = new TaskScope();
        const previous = this.image;
        this.image = image;
        if (previous !== image || opening || force) this.followImage = true;
        this.render();
        if (this.followImage) this.centerImage();
        if (hadFocus) this.nodes.get(image)?.button.focus({preventScroll: true});
        this.discoverEdges();
    }

    scrollTo(left) {
        this.container.scrollLeft = left;
        this.followScroll = this.container.scrollLeft;
    }

    centerImage() {
        const index = this.paths.indexOf(this.image);
        if (index < 0) return;
        this.scrollTo(12 + this.offsets()[index] + this.tileWidth(this.image) / 2 - this.container.clientWidth / 2);
        this.render();
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

    render() {
        if (!this.visible || !this.scope) return;
        // Discovery can move the bounded path window past the current image.
        this.container.tabIndex = this.paths.includes(this.image) ? -1 : 0;
        const offsets = this.offsets();
        let first = 0;
        while (first < this.paths.length && offsets[first + 1] < this.container.scrollLeft) first++;
        let last = first;
        while (last < this.paths.length && offsets[last] < this.container.scrollLeft + this.container.clientWidth) last++;
        first = Math.max(0, first - 3);
        last = Math.min(this.paths.length, last + 3);
        const focused = document.activeElement;
        const indices = new Set(Array.from({length: last - first}, (_, index) => first + index));
        // Keep the tab stop and focused tile mounted outside the virtual window.
        for (const path of [this.image, focused?.dataset.path]) {
            const index = this.paths.indexOf(path);
            if (index >= 0) indices.add(index);
        }
        const visible = new Set([...indices].map(index => this.paths[index]));
        for (const [path, item] of this.nodes) {
            if (!visible.has(path)) { item.scope.dispose(); item.tile.remove(); this.nodes.delete(path); }
        }
        if (!this.leading?.isConnected) {
            this.leading = element('span', 'strip-spacer'); this.trailing = element('span', 'strip-spacer');
            this.leading.setAttribute('aria-hidden', 'true'); this.trailing.setAttribute('aria-hidden', 'true');
            this.container.prepend(this.leading); this.container.append(this.trailing);
        }
        this.leading.style.width = Math.max(0, offsets[first] - GAP) + 'px';
        this.leading.hidden = first === 0;
        this.trailing.style.width = Math.max(0, offsets.at(-1) - offsets[last] - GAP) + 'px';
        this.trailing.hidden = last === this.paths.length;
        let cursor = this.leading.nextSibling;
        for (const index of [...indices].sort((a, b) => a - b)) {
            const path = this.paths[index];
            let item = this.nodes.get(path);
            if (!item) {
                const button = element('button');
                button.dataset.path = path; button.title = path;
                button.setAttribute('aria-label', `View ${isVideo(path) ? 'video' : 'image'} ${filename(path)}`);
                button.addEventListener('click', () => this.selectImage(path, 'top'));
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
            item.tile.style.setProperty('--thumbnail-width', this.tileWidth(path) + 'px');
            const pinned = index < first || index >= last;
            item.tile.classList.toggle('pinned', pinned);
            item.tile.style.setProperty('--thumbnail-offset', offsets[index] + 12 + 'px');
            item.button.tabIndex = path === this.image ? 0 : -1;
            item.button.classList.toggle('selected', path === this.image);
            if (path === this.image) item.button.setAttribute('aria-current', 'true');
            else item.button.removeAttribute('aria-current');
            const folder = parentPath(path);
            const boundary = index > 0 ? parentPath(this.paths[index - 1]) !== folder : this.edges[0].done;
            item.tile.classList.toggle('folder-start', boundary);
            const label = relativePath(this.labelRoot, folder);
            item.label.textContent = boundary ? label : '';
            item.label.title = label;
            if (boundary) {
                let end = index + 1;
                while (end < this.paths.length && parentPath(this.paths[end]) === folder) end++;
                const groupWidth = offsets[end] - offsets[index] - GAP;
                // The last heading can also use the empty space after its images.
                const remainingWidth = end === this.paths.length
                    ? this.container.clientWidth - 24 - offsets[index] + this.container.scrollLeft : 0;
                item.label.style.width = Math.max(groupWidth, remainingWidth) + 'px';
            }
            if (pinned) {
                if (!item.tile.isConnected) this.container.append(item.tile);
            } else {
                while (cursor?.classList.contains('pinned')) cursor = cursor.nextSibling;
                if (item.tile !== cursor) this.container.insertBefore(item.tile, cursor);
                cursor = item.tile.nextSibling;
            }
        }
        if (focused?.isConnected && visible.has(focused.dataset.path) && document.activeElement !== focused) {
            focused.focus({preventScroll: true});
        }
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
        if (edge.done || edge.loading || edge.failed) return;
        edge.loading = true;
        const scope = this.scope;
        this.container.setAttribute('aria-busy', 'true');
        try {
            const result = await walkImages({root: this.collection,
                anchor: edge.reverse ? this.paths[0] : this.paths.at(-1),
                reverse: edge.reverse, cursor: edge.cursor, limit: PAGE_SIZE}, scope.signal);
            scope.signal.throwIfAborted();
            const known = new Set(this.paths);
            const added = result.images.filter(path => !known.has(path));
            const left = this.container.scrollLeft;
            const oldFirst = this.paths[0];
            let removedWidth = 0;
            if (edge.reverse) this.paths.unshift(...added.reverse());
            else this.paths.push(...added);
            const excess = Math.max(0, this.paths.length - MAX_PATHS);
            if (excess) {
                if (edge.reverse) this.paths.splice(MAX_PATHS);
                else { removedWidth = this.offsets()[excess]; this.paths.splice(0, excess); }
                const other = this.edges[edge.reverse ? 1 : 0];
                other.done = false; other.cursor = null;
            }
            edge.cursor = result.cursor; edge.done = result.cursor === null;
            this.render();
            this.scrollTo(Math.max(0, left + (edge.reverse ? this.offsets()[Math.max(0, this.paths.indexOf(oldFirst))] : -removedWidth)));
            if (this.followImage) this.centerImage();
            else this.render();
        } catch (error) {
            if (error.name !== 'AbortError' && scope === this.scope) edge.failed = true;
        } finally {
            if (scope === this.scope) {
                edge.loading = false;
                this.container.setAttribute('aria-busy', String(this.edges.some(item => item.loading)));
                this.updateEdges();
                if (!edge.done && !edge.failed) requestAnimationFrame(() => this.discoverEdges());
            }
        }
    }
}
