import {isVideo} from './media-kind.js';
import {filename, parentPath, ItemType} from './state.js';

/** Row metadata for a virtual grid. Appending a page only changes its last row. */
export class GridLayout {
    constructor(viewport) {
        this.viewport = viewport;
        this.measure = document.createElement('canvas').getContext('2d');
        this.rows = [];
        this.byPath = new Map();
        this.measurements = new Map();
        this.height = 0;
        this.width = 0;
        this.columns = 1;
    }

    reset(items, recursive, rootName) {
        const style = getComputedStyle(this.viewport);
        const number = name => parseFloat(style.getPropertyValue(name));
        this.width = this.viewport.clientWidth;
        this.contentWidth = this.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        this.gap = number('--grid-column-gap');
        this.minHeight = number('--grid-min-row-height');
        this.lineHeight = number('--label-line-height');
        this.cardFont = number('--card-label-font-size');
        this.headingFont = number('--folder-label-font-size');
        this.imageHeight = number('--card-image-height');
        this.captionPadding = number('--card-caption-padding');
        this.folderActionsWidth = 3 * number('--control-height');
        this.captionGap = number('--space-md');
        this.folderIconWidth = number('--control-icon-size') + number('--space-sm');
        this.listGap = number('--list-gap');
        this.listBaseWidth = this.captionPadding * 2 + number('--list-kind-width') + this.listGap;
        this.listDurationWidth = number('--list-duration-width');
        this.rowPadding = number('--grid-row-padding');
        this.fontFamily = style.fontFamily;
        this.compact = this.viewport.classList.contains('compact');
        this.columns = this.compact ? 1 : Math.max(1, Math.floor(this.width / number('--grid-min-column-width')));
        const media = items.filter(item => item.type !== ItemType.FOLDER);
        if (!recursive && !this.compact && media.length && media.every(item => isVideo(item.path))) {
            const cardWidth = (this.contentWidth - (this.columns - 1) * this.gap) / this.columns;
            this.imageHeight = cardWidth * 9 / 16;
            this.minHeight = 0;
        }
        this.recursive = recursive;
        this.rootName = rootName;
        this.rows = [];
        this.byPath.clear();
        this.itemCount = 0;
        this.height = 0;
        this.append(items);
    }

    labelHeight(text, width, fontSize) {
        const key = JSON.stringify([text, Math.floor(width), fontSize, this.fontFamily]);
        if (this.measurements.has(key)) return this.measurements.get(key);
        this.measure.font = fontSize + 'px ' + this.fontFamily;
        width = Math.max(1, width);
        const space = this.measure.measureText(' ').width;
        let lines = 1;
        let used = 0;
        for (const word of text.split(/\s+/)) {
            const wordWidth = this.measure.measureText(word).width;
            if (used && used + space + wordWidth > width) {
                lines++;
                used = 0;
            }
            if (wordWidth > width) {
                lines += Math.ceil(wordWidth / width) - 1;
                used = wordWidth % width || width;
            } else {
                used += (used ? space : 0) + wordWidth;
            }
        }
        // One spare line accounts for differences between canvas and DOM wrapping.
        const height = (lines > 1 ? lines + 1 : lines) * this.lineHeight;
        this.measurements.set(key, height);
        if (this.measurements.size > 10000) this.measurements.delete(this.measurements.keys().next().value);
        return height;
    }

    append(items) {
        const last = this.rows.at(-1);
        let current = last?.items ? last : null;
        let previousFolder = current ? parentPath(current.items.at(-1).path) : null;
        const cardWidth = (this.contentWidth - (this.columns - 1) * this.gap) / this.columns;
        for (const item of items) {
            const folder = parentPath(item.path);
            if (this.recursive && folder !== previousFolder) {
                current = null;
                const label = folder || this.rootName;
                const height = Math.max(42, this.labelHeight(label, this.contentWidth, this.headingFont) + 16);
                const heading = {top: this.height, height, label, path: folder};
                this.rows.push(heading);
                this.byPath.set('heading:' + folder, heading);
                this.height += height;
                previousFolder = folder;
            }
            if (!current || current.items.length === this.columns) {
                current = {top: this.height, height: this.minHeight, items: [], startIndex: this.itemCount};
                this.rows.push(current);
                this.height += current.height;
            }
            current.items.push(item);
            this.itemCount++;
            this.byPath.set('item:' + item.path, current);
            const isFolder = item.type === ItemType.FOLDER;
            const controlsWidth = this.compact
                ? this.listBaseWidth + (isFolder ? this.folderActionsWidth + this.listGap
                    : isVideo(item.path) ? this.listDurationWidth + this.listGap : 0)
                : this.captionPadding * 2 + 2 + (isFolder ? this.folderActionsWidth + this.captionGap + this.folderIconWidth : 0);
            const labelWidth = cardWidth - controlsWidth;
            const contentHeight = this.compact
                ? this.labelHeight(filename(item.path), labelWidth, this.cardFont) + 16
                : this.imageHeight + this.captionPadding * 2 + 2 + this.rowPadding * 2
                + this.labelHeight(filename(item.path), labelWidth, this.cardFont);
            const newHeight = Math.max(current.height, contentHeight);
            this.height += newHeight - current.height;
            current.height = newHeight;
        }
    }

    visibleRange(start, end) {
        let low = 0;
        let high = this.rows.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            const row = this.rows[middle];
            if (row.top + row.height < start) low = middle + 1;
            else high = middle;
        }
        let last = low;
        while (last < this.rows.length && this.rows[last].top < end) last++;
        return [low, last];
    }
}
