import {parentPath, relativePath} from '../shared/state.js';

/** A snapshot of strip geometry, independent of mounted thumbnails and requests. */
export class ThumbnailLayout {
    constructor(paths, {width, gap, folderWidth, folderGap, labelRoot, leadingKnown, paddingStart, paddingEnd}) {
        Object.assign(this, {width, paddingStart, paddingEnd});
        let left = 0, previous;
        this.items = paths.map((path, index) => {
            const folder = parentPath(path);
            const boundary = index ? folder !== previous : leadingKnown;
            const label = boundary ? relativePath(labelRoot, folder) : '';
            const thumbnailLeft = left + (label ? folderWidth + folderGap : 0);
            const item = {path, index, boundary, label, left, thumbnailLeft, right:thumbnailLeft + width};
            previous = folder;
            left = item.right + gap;
            return item;
        });
        this.byPath = new Map(this.items.map(item => [item.path, item]));
        this.contentWidth = this.items.at(-1)?.right || 0;
    }

    /** Fixed labels stay fixed; a point inside a thumbnail scales with its width. */
    anchor(scrollLeft, viewportWidth, {preferred, retained} = {}) {
        const left = scrollLeft - this.paddingStart, right = left + viewportWidth;
        let item = this.byPath.get(preferred);
        if (!item || item.thumbnailLeft >= right || item.right <= left || (retained && !retained.has(item.path))) {
            item = this.items.find(item => item.right > left && item.left < right && (!retained || retained.has(item.path)));
        }
        if (!item) return null;
        const fraction = Math.max(0, Math.min(1, (left - item.thumbnailLeft) / this.width));
        return {path:item.path, fraction, x:item.thumbnailLeft + fraction * this.width - left};
    }

    scrollLeft(anchor, viewportWidth) {
        const item = anchor && this.byPath.get(anchor.path);
        if (!item) return null;
        const point = this.paddingStart + item.thumbnailLeft + this.width * anchor.fraction;
        const max = Math.max(0, this.paddingStart + this.contentWidth + this.paddingEnd - viewportWidth);
        return Math.max(0, Math.min(max, point - anchor.x));
    }

    visible(scrollLeft, viewportWidth) {
        const left = scrollLeft - this.paddingStart;
        let first = 0, last = 0;
        while (first < this.items.length && this.items[first].right <= left) first++;
        last = first;
        while (last < this.items.length && this.items[last].left < left + viewportWidth) last++;
        return this.items.slice(Math.max(0, first - 3), last + 3);
    }
}
