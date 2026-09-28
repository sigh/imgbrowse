import {getPreview, getThumbnail} from './api.js';
import {element} from './dom.js';

const PREVIEW_CONCURRENCY = 8;
const OFFSCREEN_PRIORITY = 1e9;

/** One job owns discovery and decoding for a card, preserving visual load order. */
export class PreviewLoader {
    constructor(viewport, viewer) {
        this.viewport = viewport;
        this.viewer = viewer;
        this.viewerOpen = false;
        this.jobs = [];
        this.running = 0;
        this.scheduled = false;
        this.active = new Set();
    }

    setViewerOpen(open) {
        this.viewerOpen = open;
        for (const job of this.active) {
            if (open && !this.viewer.contains(job.target)) job.controller.abort();
        }
        this.schedule();
    }

    image(target, path, scope) {
        return this.enqueue(signal => this.attachImage(target, path, scope, signal), target, scope.signal);
    }

    folder(target, path, scope) {
        return this.enqueue(async signal => {
            let result;
            do {
                result = await getPreview(path, signal);
                path = result.continue;
            } while (path !== undefined);
            if (result.image) await this.attachImage(target, result.image, scope, signal);
            else target.textContent = 'Folder';
        }, target, scope.signal);
    }

    async attachImage(target, path, scope, signal) {
        const blob = await getThumbnail(path, signal);
        const image = element('img');
        image.alt = '';
        image.src = scope.objectUrl(blob);
        target.replaceChildren(image);
    }

    enqueue(work, target, signal) {
        return new Promise((resolve, reject) => {
            this.jobs.push({work, target, signal, resolve, reject});
            this.schedule();
        });
    }

    schedule() {
        if (this.scheduled) return;
        this.scheduled = true;
        // Cards must be attached to the DOM before measuring their priorities.
        queueMicrotask(() => {
            this.scheduled = false;
            this.pump();
        });
    }

    priority(target) {
        if (!target.isConnected) return Infinity;
        const rect = target.getBoundingClientRect();
        if (this.viewer.contains(target)) {
            if (!this.viewerOpen) return Infinity;
            return Math.abs((rect.left + rect.right) / 2 - this.viewer.clientWidth / 2);
        }
        if (this.viewerOpen) return Infinity;
        const bounds = this.viewport.getBoundingClientRect();
        const visible = rect.bottom > bounds.top && rect.top < bounds.bottom;
        const distance = visible
            ? Math.max(0, rect.top - bounds.top)
            : Math.abs(rect.top - bounds.top);
        return (visible ? 0 : OFFSCREEN_PRIORITY) + distance * 1000 + rect.left;
    }

    pump() {
        const remaining = [];
        for (const job of this.jobs) {
            if (job.signal.aborted) job.reject(new DOMException('Aborted', 'AbortError'));
            else remaining.push(job);
        }
        // Measure each target once per scheduling pass, rather than during sorting.
        remaining.forEach(job => { job.priority = this.priority(job.target); });
        this.jobs = remaining.sort((a, b) => a.priority - b.priority);
        while (this.running < PREVIEW_CONCURRENCY && this.jobs.length) {
            if (!Number.isFinite(this.jobs[0].priority)) break;
            const job = this.jobs.shift();
            this.running++;
            job.controller = new AbortController();
            const abort = () => job.controller.abort();
            job.signal.addEventListener('abort', abort, {once: true});
            this.active.add(job);
            Promise.resolve().then(() => {
                job.signal.throwIfAborted();
                return job.work(job.controller.signal);
            }).then(job.resolve, error => {
                if (error.name === 'AbortError' && !job.signal.aborted) this.jobs.push(job);
                else job.reject(error);
            }).finally(() => {
                job.signal.removeEventListener('abort', abort);
                this.active.delete(job);
                this.running--;
                this.schedule();
            });
        }
    }
}
