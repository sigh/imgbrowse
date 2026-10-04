import {TaskScope} from './dom.js';
import {isVideo} from './media-kind.js';
import {sortKey, sortSettings, ViewerEntry} from './state.js';

export const NavigationOutcome = Object.freeze({
    FINDING:'finding', ONLY:'only', ERROR:'error', EMPTY:'empty', BOUNDARY:'boundary',
});

const NEARBY_COUNT = 16;

/** Collection discovery, movement and prefetching; no DOM or display messages. */
export class CollectionNavigator {
    constructor({walk, loadOriginal, select, changed, loadingDelay = 700}) {
        Object.assign(this, {walk, loadOriginal, select, changed, loadingDelay});
        this.paths = [];
        this.boundary = null;
        this.singleImage = false;
    }

    get moving() { return Boolean(this.moveScope); }

    configure(state, force = false) {
        this.moveScope?.dispose();
        this.moveScope = null;
        this.clearOutcome();
        this.singleImage = false;
        if (force || this.collection !== state.collection || sortKey(this.state) !== sortKey(state)) {
            this.paths = [];
            this.stopPrefetch();
        }
        this.state = state;
        this.prefetchEnabled = false;
    }

    clearOutcome() {
        this.outcome = null;
        this.retryMove = null;
        this.boundary = null;
    }

    stopPrefetch() {
        this.prefetchScope?.dispose();
        this.prefetchScope = null;
        this.prefetchPath = null;
        this.prefetchEnabled = false;
    }

    setPaths(paths, collection) {
        this.paths = paths;
        this.collection = collection;
    }

    discover(image, collection, signal) {
        const index = this.collection === collection ? this.paths.indexOf(image) : -1;
        if (index > 1 && index < this.paths.length - 2) return;
        const results = new Map();
        for (const reverse of [true, false]) {
            this.walk({...sortSettings(this.state), root:collection, anchor:image, reverse, limit:NEARBY_COUNT}, signal)
                .then(result => {
                    signal.throwIfAborted();
                    results.set(reverse, result);
                    const before = results.get(true), after = results.get(false);
                    this.setPaths([...(before ? [...before.images].reverse() : []), image, ...(after?.images || [])], collection);
                    this.singleImage = Boolean(before && after && this.paths.length === 1
                        && !before.cursor && !after.cursor && !before.warnings.length && !after.warnings.length);
                    this.changed();
                    this.prefetch();
                }).catch(() => {});
        }
    }

    prefetch(enabled = this.prefetchEnabled) {
        this.prefetchEnabled = enabled;
        if (!enabled) return;
        const index = this.paths.indexOf(this.state.image);
        const next = index < 0 ? null : this.paths[index + (this.reverse ? -1 : 1)];
        if (!next || isVideo(next) || this.prefetchPath === next) return;
        this.prefetchScope?.dispose();
        this.prefetchScope = new TaskScope();
        this.prefetchPath = next;
        Promise.resolve(this.loadOriginal(next, this.prefetchScope.signal, true)).catch(() => {
            if (this.prefetchPath === next) this.prefetchPath = null;
        });
    }

    request(reverse, fresh, entry, warning = false) {
        if (this.moving || this.singleImage) return;
        this.reverse = reverse;
        const wrap = this.boundary === reverse;
        if (wrap && !fresh) return;
        this.clearOutcome();
        this.changed(true);
        return this.move(reverse, wrap, entry, warning);
    }

    retry() {
        const retry = this.retryMove;
        if (!retry) return false;
        this.clearOutcome();
        this.changed(true);
        this.move(...retry);
        return true;
    }

    async move(reverse = false, wrap = false, entry = ViewerEntry.TOP, warning = false) {
        const index = this.collection === this.state.collection ? this.paths.indexOf(this.state.image) : -1;
        const neighbor = !wrap && index >= 0 ? this.paths[index + (reverse ? -1 : 1)] : null;
        if (neighbor) {
            this.select(neighbor, entry);
            return;
        }
        const scope = this.moveScope = new TaskScope();
        this.changed();
        scope.delay(() => {
            this.outcome = {kind:NavigationOutcome.FINDING, reverse};
            this.changed(true);
        }, this.loadingDelay);
        let cursor = null;
        try {
            do {
                const result = await this.walk({...sortSettings(this.state), root:this.state.collection,
                    anchor:wrap ? null : this.state.image, reverse, cursor, limit:1}, scope.signal);
                scope.signal.throwIfAborted();
                warning ||= result.warnings.length > 0;
                if (result.images.length) {
                    if (wrap && result.images[0] === this.state.image) {
                        this.singleImage = true;
                        this.outcome = {kind:NavigationOutcome.ONLY};
                    } else this.select(result.images[0], entry);
                    return;
                }
                cursor = result.cursor;
            } while (cursor !== null);
            if (this.state.image) this.boundary = reverse;
            this.outcome = {kind:this.state.image ? NavigationOutcome.BOUNDARY : NavigationOutcome.EMPTY, reverse, warning};
        } catch (error) {
            if (error.name !== 'AbortError' && !scope.signal.aborted) {
                this.outcome = {kind:NavigationOutcome.ERROR, reverse};
                this.retryMove = [reverse, wrap, entry, warning];
            }
        } finally {
            scope.dispose();
            if (this.moveScope === scope) {
                this.moveScope = null;
                this.changed(Boolean(this.outcome));
            }
        }
    }
}
