import {getPreview, getThumbnail, cachedThumbnail, getVideoInfo} from './api.js';
import {element} from './dom.js';
import {isVideo} from './media-kind.js';
import {icon} from './icons.js';

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
        this.runningVideos = 0;
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

    duration(target, path, scope) {
        const cached = cachedThumbnail(path);
        if (Number.isFinite(cached?.duration)) {
            target.textContent = durationLabel(cached.duration);
            return;
        }
        this.enqueue(signal => getVideoInfo(path, signal).then(info => {
            if (!scope.signal.aborted) target.textContent = durationLabel(info.duration);
        }), target, scope.signal, true).catch(() => {});
    }

    image(target, path, scope) {
        if (cachedThumbnail(path)) return this.attachImage(target, path, scope, scope.signal);
        if (isVideo(path)) {
            const placeholder = icon('video');
            placeholder.classList.add('video-placeholder');
            target.replaceChildren(placeholder);
        }
        return this.enqueue(signal => this.attachImage(target, path, scope, signal), target, scope.signal, isVideo(path), () => Boolean(cachedThumbnail(path)));
    }

    folder(target, path, scope) {
        return this.enqueue(async signal => {
            let result;
            do {
                result = await getPreview(path, signal);
                path = result.continue;
            } while (path !== undefined);
            return result.image;
        }, target, scope.signal).then(image => {
            if (image) return this.image(target, image, scope);
            target.textContent = 'Folder';
        });
    }

    async attachImage(target, path, scope, signal) {
        let blob;
        try { blob = await getThumbnail(path, signal); }
        catch (error) {
            if (!isVideo(path) || error.name === 'AbortError') throw error;
            return; // Keep the playable placeholder when extraction is unavailable.
        }
        const image = element('img');
        image.alt = '';
        image.src = scope.objectUrl(blob);
        target.replaceChildren(image);
        if (isVideo(path)) {
            const badge = icon('video');
            badge.classList.add('video-badge');
            target.classList.add('video-preview');
            target.append(badge);
            const duration = element('span', 'video-duration', durationLabel(blob.duration));
            target.append(duration);
        }
    }

    enqueue(work, target, signal, video = false, cached = null) {
        return new Promise((resolve, reject) => {
            this.jobs.push({work, target, signal, video, cached, resolve, reject});
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
            const index = this.jobs.findIndex(job => Number.isFinite(job.priority) && (!job.video || !this.runningVideos || job.cached?.()));
            if (index < 0) break;
            const [job] = this.jobs.splice(index, 1);
            if (job.video) this.runningVideos++;
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
                if (job.video) this.runningVideos--;
                this.schedule();
            });
        }
    }
}

export function durationLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    return (minutes >= 60 ? Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') : minutes)
        + ':' + String(total % 60).padStart(2, '0');
}
