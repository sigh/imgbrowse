import {imageUrl, cachedThumbnail} from './api.js';
import {filename} from './state.js';

/** Shared native video elements, cleanup, and one temporary playback point. */
export class VideoPlayer {
    constructor(canvas) {
        this.canvas = canvas;
        this.resume = null;
    }

    create(path, scope, onError) {
        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.tabIndex = 0;
        video.dataset.path = path;
        video.setAttribute('aria-label', filename(path));
        video.addEventListener('error', () => {
            if (!scope.signal.aborted) onError(video.error);
        });
        const poster = cachedThumbnail(path);
        if (poster?.blob) video.poster = scope.objectUrl(poster.blob);
        video.addEventListener('loadedmetadata', () => {
            if (this.resume?.path === path && Number.isFinite(video.duration)) video.currentTime = Math.min(this.resume.time, video.duration);
        });
        video.addEventListener('seeked', () => {
            if (!scope.signal.aborted) this.resume = {path, time:video.currentTime};
        });
        video.src = imageUrl(path);
        scope.onDispose(() => {
            // Loading a passive neighbour must not erase the last playback point.
            if (video.currentTime > 0) this.resume = {path, time:video.currentTime};
            video.pause();
            video.removeAttribute('src');
            video.load();
            video.remove();
        });
        return video;
    }

    show(path, scope, onError) {
        const video = this.create(path, scope, onError);
        video.id = 'viewer-video';
        const fit = () => {
            const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
            const width = Math.min(this.canvas.clientWidth, this.canvas.clientHeight * ratio);
            video.style.width = width + 'px';
            video.style.height = width / ratio + 'px';
        };
        video.addEventListener('loadedmetadata', fit);
        const observer = new ResizeObserver(fit);
        observer.observe(this.canvas);
        this.canvas.classList.add('showing-video');
        this.canvas.append(video);
        fit();
        if (document.activeElement === this.canvas || document.activeElement === document.body) {
            video.focus({preventScroll: true});
        }
        scope.onDispose(() => {
            observer.disconnect();
            this.canvas.classList.remove('showing-video');
        });
    }
}
