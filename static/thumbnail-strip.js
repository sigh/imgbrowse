import {walkImages} from './api.js';
import {element, TaskScope} from './dom.js';
import {filename} from './state.js';

const PAGE_SIZE = 32;
const MAX_PATHS = 2048;
const STRIDE = 64; // 58px button plus 6px gap in gallery.css.

/** Stable native scroller with a bounded path window and virtual button elements. */
export class ThumbnailStrip {
    constructor(container, previews, selectImage) {
        Object.assign(this, {container, previews, selectImage});
        this.paths = [];
        this.nodes = new Map();
        container.addEventListener('scroll', () => {
            if (this.scheduled) return;
            this.scheduled = true;
            requestAnimationFrame(() => {
                this.scheduled = false; this.render(); this.discoverEdges();
            });
        });
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
        this.container.scrollLeft = 0;
    }

    show(collection, image, visible, force = false) {
        if (force || collection !== this.collection || (image && !this.paths.includes(image))) this.reset(collection, image);
        this.visible = visible; this.container.hidden = !visible;
        if (!visible) { this.stop(); return; }
        if (!this.scope) this.scope = new TaskScope();
        const previous = this.image;
        this.image = image;
        const index = this.paths.indexOf(image);
        this.render();
        if (previous !== image && index >= 0) {
            const left = index * STRIDE;
            if (left < this.container.scrollLeft) this.container.scrollLeft = left;
            else if (left + STRIDE > this.container.scrollLeft + this.container.clientWidth) {
                this.container.scrollLeft = left + STRIDE - this.container.clientWidth;
            }
            this.render();
        }
        this.discoverEdges();
    }

    render() {
        if (!this.visible || !this.scope) return;
        const first = Math.max(0, Math.floor(this.container.scrollLeft / STRIDE) - 3);
        const last = Math.min(this.paths.length, Math.ceil((this.container.scrollLeft + this.container.clientWidth) / STRIDE) + 3);
        const visible = new Set(this.paths.slice(first, last));
        for (const [path, item] of this.nodes) {
            if (!visible.has(path)) { item.scope.dispose(); item.button.remove(); this.nodes.delete(path); }
        }
        if (!this.leading?.isConnected) {
            this.leading = element('span', 'strip-spacer'); this.trailing = element('span', 'strip-spacer');
            this.leading.setAttribute('aria-hidden', 'true'); this.trailing.setAttribute('aria-hidden', 'true');
            this.container.prepend(this.leading); this.container.append(this.trailing);
        }
        this.leading.style.width = Math.max(0, first * STRIDE - 6) + 'px';
        this.leading.hidden = first === 0;
        this.trailing.style.width = Math.max(0, (this.paths.length - last) * STRIDE - 6) + 'px';
        this.trailing.hidden = last === this.paths.length;
        for (let index = first; index < last; index++) {
            const path = this.paths[index];
            let item = this.nodes.get(path);
            if (!item) {
                const button = element('button');
                button.dataset.path = path; button.title = path;
                button.setAttribute('aria-label', 'View ' + filename(path));
                button.addEventListener('click', () => this.selectImage(path, 'top'));
                item = {button, scope: new TaskScope()}; this.nodes.set(path, item);
                this.previews.image(button, path, item.scope).catch(() => {});
            }
            item.button.classList.toggle('selected', path === this.image);
            if (path === this.image) item.button.setAttribute('aria-current', 'true');
            else item.button.removeAttribute('aria-current');
            this.container.insertBefore(item.button, this.trailing);
        }
        this.previews.schedule();
    }

    discoverEdges() {
        if (!this.visible || !this.scope || !this.paths.length) return;
        const {scrollLeft, clientWidth, scrollWidth} = this.container;
        if (scrollLeft < 120) this.discover(this.edges[0]);
        if (scrollLeft + clientWidth > scrollWidth - 120) this.discover(this.edges[1]);
    }

    async discover(edge) {
        if (edge.done || edge.loading) return;
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
            if (edge.reverse) this.paths.unshift(...added.reverse());
            else this.paths.push(...added);
            const excess = Math.max(0, this.paths.length - MAX_PATHS);
            if (excess) {
                if (edge.reverse) this.paths.splice(MAX_PATHS);
                else this.paths.splice(0, excess);
                const other = this.edges[edge.reverse ? 1 : 0];
                other.done = false; other.cursor = null;
            }
            edge.cursor = result.cursor; edge.done = result.cursor === null;
            this.render();
            this.container.scrollLeft = Math.max(0, left + (edge.reverse ? added.length : -excess) * STRIDE);
            this.render();
        } catch (error) {
            if (error.name !== 'AbortError') edge.done = true;
        } finally {
            if (scope === this.scope) {
                edge.loading = false;
                this.container.setAttribute('aria-busy', String(this.edges.some(item => item.loading)));
                if (!edge.done) requestAnimationFrame(() => this.discoverEdges());
            }
        }
    }
}
