import {walkImages} from './api.js';
import {element, TaskScope} from './dom.js';
import {filename} from './state.js';

const PAGE_SIZE = 32;

/** An anchored, incremental sequence. Existing buttons survive page turns. */
export class ThumbnailStrip {
    constructor(container, previews, selectImage) {
        Object.assign(this, {container, previews, selectImage});
        this.nodes = new Map();
        this.visible = false;
        this.previewsByPath = new Map();
        this.observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const button = entry.target;
                const path = button.dataset.path;
                if (!entry.isIntersecting || !this.visible) {
                    this.previewsByPath.get(path)?.dispose();
                    this.previewsByPath.delete(path);
                    button.replaceChildren();
                    continue;
                }
                if (this.previewsByPath.has(path)) continue;
                const scope = new TaskScope();
                this.previewsByPath.set(path, scope);
                this.previews.image(button, path, scope).catch(() => {});
            }
        }, {root: container, rootMargin: '100px'});
        container.addEventListener('scroll', () => {
            this.previews.schedule();
            this.discoverEdges();
        });
    }

    reset(collection, image) {
        this.stop();
        this.collection = collection;
        this.nodes.clear();
        this.container.replaceChildren();
        this.edges = [true, false].map(reverse => ({reverse, anchor: image, cursor: null, done: false, loading: false}));
        if (image) this.append([image]);
    }

    stop() {
        this.scope?.dispose();
        this.scope = null;
        this.observer.disconnect();
        for (const scope of this.previewsByPath.values()) scope.dispose();
        this.previewsByPath.clear();
        for (const button of this.nodes.values()) button.replaceChildren();
        for (const edge of this.edges || []) edge.loading = false;
    }

    show(collection, image, visible, force = false) {
        if (force || collection !== this.collection || (image && !this.nodes.has(image))) this.reset(collection, image);
        this.visible = visible;
        this.container.hidden = !visible;
        if (!visible) { this.stop(); return; }
        if (!this.scope) {
            this.scope = new TaskScope();
            for (const button of this.nodes.values()) this.observer.observe(button);
        }
        const changed = this.image !== image;
        this.image = image;
        for (const [path, button] of this.nodes) {
            button.classList.toggle('selected', path === image);
            if (path === image) button.setAttribute('aria-current', 'true');
            else button.removeAttribute('aria-current');
        }
        const selected = this.nodes.get(image);
        if (changed && selected) selected.scrollIntoView({block: 'nearest', inline: 'nearest'});
        this.discoverEdges();
    }

    append(paths, reverse = false) {
        const fragment = document.createDocumentFragment();
        for (const path of paths) {
            if (this.nodes.has(path)) continue;
            const button = element('button');
            button.dataset.path = path;
            button.title = path;
            button.setAttribute('aria-label', 'View ' + filename(path));
            button.addEventListener('click', () => this.selectImage(path, 'top'));
            this.nodes.set(path, button);
            fragment.append(button);
            if (this.scope) this.observer.observe(button);
        }
        if (reverse) this.container.prepend(fragment);
        else this.container.append(fragment);
    }

    discoverEdges() {
        if (!this.visible || !this.scope || !this.nodes.size) return;
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
            const result = await walkImages({root: this.collection, anchor: edge.anchor,
                reverse: edge.reverse, cursor: edge.cursor, limit: PAGE_SIZE}, scope.signal);
            scope.signal.throwIfAborted();
            const first = this.container.firstElementChild;
            const left = first?.getBoundingClientRect().left;
            this.append(edge.reverse ? [...result.images].reverse() : result.images, edge.reverse);
            if (edge.reverse && first) this.container.scrollLeft += first.getBoundingClientRect().left - left;
            edge.cursor = result.cursor;
            edge.done = result.cursor === null;
        } catch (error) {
            if (error.name !== 'AbortError') edge.done = true; // Reader navigation remains available.
        } finally {
            if (scope === this.scope) {
                edge.loading = false;
                this.container.setAttribute('aria-busy', String(this.edges.some(item => item.loading)));
                // Continue only to fill the visible area; never index the collection.
                if (!edge.done) requestAnimationFrame(() => this.discoverEdges());
            }
        }
    }
}
