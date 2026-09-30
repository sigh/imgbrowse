import {imageUrl, cachedThumbnail} from './api.js';

/** A streaming video owns its element and releases it when the view changes. */
export class VideoPlayer {
    constructor(canvas) {
        this.canvas = canvas;
        this.element = null;
        this.resume = null;
    }

    show(path, scope, onError) {
        const video = document.createElement('video');
        video.id = 'viewer-video';
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.tabIndex = 0;
        video.dataset.path = path;
        video.setAttribute('aria-label', path.split('/').pop());
        video.addEventListener('error', () => {
            if (!scope.signal.aborted) onError();
        });
        const poster = cachedThumbnail(path);
        if (poster) video.poster = scope.objectUrl(poster);
        const fit = () => {
            const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
            const width = Math.min(this.canvas.clientWidth, this.canvas.clientHeight * ratio);
            video.style.width = width + 'px';
            video.style.height = width / ratio + 'px';
        };
        video.addEventListener('loadedmetadata', () => {
            fit();
            if (this.resume?.path === path && Number.isFinite(video.duration)) {
                video.currentTime = Math.min(this.resume.time, video.duration);
            }
        });
        const observer = new ResizeObserver(fit);
        observer.observe(this.canvas);
        video.src = imageUrl(path);
        this.element = video;
        this.canvas.classList.add('showing-video');
        this.canvas.append(video);
        fit();
        video.focus({preventScroll: true});
        scope.onDispose(() => {
            this.resume = {path, time: video.currentTime};
            observer.disconnect();
            video.pause();
            video.removeAttribute('src');
            video.load();
            video.remove();
            this.canvas.classList.remove('showing-video');
            this.element = null;
        });
    }
}
