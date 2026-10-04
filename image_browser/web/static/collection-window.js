/** Bounded collection paths and discovery state; views own elements and geometry. */
export class CollectionWindow {
    constructor(request, {root, image, pageSize, maxPaths, ordering = {}}) {
        Object.assign(this, {request, root, pageSize, maxPaths, ordering});
        this.paths = image ? [image] : [];
        this.windowed = false;
        this.edges = [true, false].map(reverse => ({reverse, cursor:null, done:false, loading:false, failed:false, warning:false}));
    }

    canLoad(edge) { return !edge.done && !edge.loading && !edge.failed; }
    get warning() { return this.edges.some(edge => edge.warning); }

    async load(edge, signal) {
        this.signal = signal;
        edge.loading = true;
        try {
            const result = await this.request({...this.ordering, root:this.root,
                anchor:edge.reverse ? this.paths[0] : this.paths.at(-1),
                reverse:edge.reverse, cursor:edge.cursor, limit:this.pageSize}, signal);
            signal.throwIfAborted();
            const known = new Set(this.paths);
            const added = result.images.filter(path => !known.has(path));
            if (edge.reverse) this.paths.unshift(...added.reverse());
            else this.paths.push(...added);
            const excess = Math.max(0, this.paths.length - this.maxPaths);
            const removed = this.paths.splice(edge.reverse ? this.maxPaths : 0, excess);
            if (removed.length) {
                this.windowed = true;
                const opposite = this.edges[edge.reverse ? 1 : 0];
                opposite.done = false;
                opposite.cursor = null;
            }
            edge.cursor = result.cursor;
            edge.done = result.cursor === null;
            edge.warning ||= result.warnings.length > 0;
            return {added, removed};
        } catch (error) {
            if (error.name !== 'AbortError' && !signal.aborted) {
                edge.failed = true;
                edge.error = error.message;
            }
            return null;
        } finally {
            // A reopened view can reuse paths with a new request lifetime.
            if (this.signal === signal) edge.loading = false;
        }
    }
}
