/** Bounded collection paths and discovery state; views own elements and geometry. */
export class CollectionWindow {
    constructor(request, {root, image, pageSize, maxPaths, ordering = {}}) {
        Object.assign(this, {request, root, pageSize, maxPaths, ordering});
        this.paths = image ? [image] : [];
        this.windowed = false;
        this.revisions = {};
        this.edges = [true, false].map(reverse => ({reverse, cursor:null, done:false, loading:false, failed:false, warning:false}));
    }

    canLoad(edge) { return !edge.done && !edge.loading && !edge.failed; }
    get warning() { return this.edges.some(edge => edge.warning); }

    async load(edge, signal, {anchor = null} = {}) {
        this.signal = signal;
        edge.loading = true;
        try {
            let result;
            const options = {...this.ordering, root:this.root,
                anchor:edge.reverse ? this.paths[0] : this.paths.at(-1),
                reverse:edge.reverse, cursor:edge.cursor, limit:this.pageSize};
            const fresh = async () => {
                try { return await this.request({...options, cursor:null}, signal); }
                catch (error) {
                    if (!['invalid_request','not_found'].includes(error.code) || !options.anchor) throw error;
                    // The selected anchor was removed. Rebuild at the collection
                    // boundary rather than retaining an inaccessible old window.
                    options.anchor = null;
                    return this.request({...options, cursor:null}, signal);
                }
            };
            let reconciled = false;
            try { result = await this.request(options, signal); }
            catch (error) {
                if (error.code !== 'stale_view'
                    && !(options.anchor && ['invalid_request','not_found'].includes(error.code))) throw error;
                options.anchor = anchor || options.anchor;
                result = await fresh();
                reconciled = true;
            }
            signal.throwIfAborted();
            if (Object.entries(result.revisions || {}).some(([path, revision]) => this.revisions[path] && this.revisions[path] !== revision)) {
                if (!reconciled && anchor && anchor !== options.anchor) {
                    options.anchor = anchor;
                    result = await fresh();
                    signal.throwIfAborted();
                }
                reconciled = true;
            }
            if (result.anchor_missing) {
                // Natural traversal can seek past a deleted name. Its returned
                // neighbors remain useful, but the old anchor cannot be retained.
                options.anchor = null;
                reconciled = true;
            }
            const removedOld = reconciled ? this.paths.filter(path => path !== options.anchor) : [];
            if (reconciled) {
                this.paths = options.anchor ? [options.anchor] : [];
                this.revisions = {};
                for (const side of this.edges) { side.done = false; side.cursor = null; side.failed = false; side.warning = false; }
            }
            this.revisions = {...this.revisions, ...result.revisions};
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
            return {added, removed:[...removedOld, ...removed], ...(reconciled ? {reconciled:true} : {})};
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
