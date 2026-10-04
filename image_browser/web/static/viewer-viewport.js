import {ImageSize, ReadingLayout} from './state.js';

export function imageScale(size, layout, naturalWidth, naturalHeight, width, height) {
    if (size !== ImageSize.DEFAULT) return Number(size);
    return layout === ReadingLayout.SCROLL ? width / naturalWidth : Math.min(1, width / naturalWidth, height / naturalHeight);
}

/** Image geometry: fitting, zoom anchors, scroll edges, and native scrolling. */
export class ViewerViewport {
    constructor(canvas, changed = () => {}) {
        this.canvas = canvas;
        this.changed = changed;
        this.image = canvas.querySelector('img');
        this.ready = false;
        this.size = ImageSize.DEFAULT;
        this.scale = 1;
        this.box = null;
        new ResizeObserver(() => this.resize()).observe(canvas);
    }

    point() {
        if (!this.ready || !this.box) return null;
        const {width, height} = this.box;
        return {
            path: this.image.dataset.path,
            x: (this.canvas.scrollLeft + width / 2 - Math.max(0, (width - this.image.width) / 2)) / this.scale,
            y: (this.canvas.scrollTop + height / 2 - Math.max(0, (height - this.image.height) / 2)) / this.scale,
            alignY: .5,
        };
    }

    setSize(size) {
        const point = this.point();
        this.size = size;
        this.resize(point);
    }

    show(image, size, entry = 'top') {
        this.image.replaceWith(image);
        this.image = image;
        this.image.id = 'viewer-image';
        this.image.draggable = false;
        this.image.hidden = false;
        this.image.style.removeProperty('width');
        this.image.style.removeProperty('height');
        this.ready = true;
        this.size = size;
        this.box = null;
        this.resize(null);
        this.canvas.scrollLeft = 0;
        this.canvas.scrollTop = entry === 'bottom' ? this.canvas.scrollHeight : 0;
    }

    clear() {
        this.ready = false;
        this.box = null;
        // The displayed element belongs to the decoded-image cache. Detach it
        // intact so closing the viewer (or a failed load) cannot corrupt it.
        const placeholder = document.createElement('img');
        placeholder.id = 'viewer-image';
        placeholder.alt = '';
        placeholder.hidden = true;
        this.image.replaceWith(placeholder);
        this.image = placeholder;
    }

    resize(point = this.point()) {
        if (!this.ready || !this.canvas.clientWidth || !this.canvas.clientHeight) return;
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        const naturalWidth = this.image.naturalWidth;
        const naturalHeight = this.image.naturalHeight;
        this.scale = imageScale(this.size, ReadingLayout.SINGLE, naturalWidth, naturalHeight, width, height);
        this.image.width = Math.max(1, Math.floor(naturalWidth * this.scale));
        this.image.height = Math.max(1, Math.floor(naturalHeight * this.scale));
        this.box = {width, height};
        if (point) {
            this.canvas.scrollLeft = point.x * this.scale - width / 2;
            this.canvas.scrollTop = point.y * this.scale - height * (point.alignY ?? .5);
        }
        this.changed();
    }

    overflows() {
        return this.canvas.scrollHeight > this.canvas.clientHeight + 2
            || this.canvas.scrollWidth > this.canvas.clientWidth + 2;
    }

    canScroll(reverse) {
        return reverse ? this.canvas.scrollTop > 2
            : this.canvas.scrollHeight - this.canvas.clientHeight - this.canvas.scrollTop > 2;
    }

    scroll(delta) {
        this.canvas.scrollTop += delta;
    }

}
