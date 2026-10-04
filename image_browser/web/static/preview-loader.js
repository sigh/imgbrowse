import {getThumbnail, cachedThumbnail, getVideoInfo} from './api.js';
import {element} from './dom.js';
import {isVideo, durationLabel} from './media-kind.js';
import {icon} from './icons.js';

const PREVIEW_CONCURRENCY = 8;

/** One visible card owns one thumbnail request, including any server-side discovery. */
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

    thumbnail(target, path, scope) {
        if (cachedThumbnail(path)) return this.attachImage(target, path, scope, scope.signal);
        if (isVideo(path)) {
            const placeholder = icon('video');
            placeholder.classList.add('video-placeholder');
            target.replaceChildren(placeholder);
        }
        return this.enqueue(signal => this.attachImage(target, path, scope, signal), target, scope.signal, isVideo(path), () => Boolean(cachedThumbnail(path)));
    }

    async attachImage(target, path, scope, signal) {
        let result;
        try { result = await getThumbnail(path, signal); }
        catch (error) {
            signal.throwIfAborted();
            if (error.code !== 'video_preview_unavailable') throw error;
            const placeholder = icon('video');
            placeholder.classList.add('video-placeholder');
            target.replaceChildren(placeholder);
            return;
        }
        signal.throwIfAborted();
        if (!result.blob) return; // Preserve the folder placeholder for an empty branch.
        const image = element('img');
        image.alt = '';
        image.src = scope.objectUrl(result.blob);
        target.replaceChildren(image);
        if (result.mediaKind === 'video') {
            const badge = icon('video');
            badge.classList.add('video-badge');
            target.classList.add('video-preview');
            target.append(badge);
            const duration = element('span', 'video-duration', durationLabel(result.duration));
            target.append(duration);
        }
    }

    enqueue(work, target, signal, video = false, cached = null) {
        return new Promise((resolve, reject) => {
            const finish = (settle, value) => {
                signal.removeEventListener('abort', abort);
                settle(value);
            };
            const job = {work, target, signal, video, cached,
                resolve: value => finish(resolve, value), reject: error => finish(reject, error)};
            const abort = () => {
                const index = this.jobs.indexOf(job);
                if (index >= 0) this.jobs.splice(index, 1);
                job.controller?.abort();
                job.reject(new DOMException('Aborted', 'AbortError'));
            };
            signal.addEventListener('abort', abort, {once: true});
            if (signal.aborted) { abort(); return; }
            this.jobs.push(job);
            this.schedule();
        });
    }

    schedule() {
        if (this.scheduled) return;
        this.scheduled = true;
        // Yield to input and paint before measuring cards or restarting paused work.
        // A chain of immediately cancelled promises must not monopolize microtasks.
        setTimeout(() => {
            this.scheduled = false;
            this.pump();
        }, 0);
    }

    priority(target) {
        if (!target.isConnected || target.getClientRects?.().length === 0) return Infinity;
        const rect = target.getBoundingClientRect();
        const inStrip = this.viewer.contains(target) && !this.viewport.contains(target);
        if (inStrip && !this.viewerOpen) return Infinity;
        if (!inStrip && this.viewerOpen && !this.viewer.contains(this.viewport)) return Infinity;
        const bounds = (inStrip ? target.closest('.viewer-strip') : this.viewport).getBoundingClientRect();
        if (rect.bottom <= bounds.top || rect.top >= bounds.bottom
            || rect.right <= bounds.left || rect.left >= bounds.right) return Infinity;
        return inStrip ? Math.abs((rect.left + rect.right - bounds.left - bounds.right) / 2)
            : Math.max(0, rect.top - bounds.top) * 1000 + rect.left;
    }

    pump() {
        for (const job of this.active) {
            if (!Number.isFinite(this.priority(job.target))) job.controller.abort();
        }
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
            this.active.add(job);
            Promise.resolve().then(() => {
                job.signal.throwIfAborted();
                return job.work(job.controller.signal);
            }).then(job.resolve, error => {
                if (error.name === 'AbortError' && job.controller.signal.aborted && !job.signal.aborted) this.jobs.push(job);
                else job.reject(error);
            }).finally(() => {
                this.active.delete(job);
                this.running--;
                if (job.video) this.runningVideos--;
                this.schedule();
            });
        }
    }
}
