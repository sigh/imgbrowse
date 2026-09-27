import {filename, parentPath} from './state.js';

/** Row metadata for a virtual grid. Appending a page only changes its last row. */
export class GridLayout {
    constructor(viewport) {
        this.viewport = viewport;
        this.measure = document.createElement('canvas').getContext('2d');
        this.rows = [];
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
        this.rowPadding = number('--grid-row-padding');
        this.actionHeight = number('--card-action-height');
        this.fontFamily = style.fontFamily;
        this.compact = this.viewport.classList.contains('compact');
        this.columns = this.compact ? 1 : Math.max(1, Math.floor(this.width / number('--grid-min-column-width')));
        this.recursive = recursive;
        this.rootName = rootName;
        this.rows = [];
        this.height = 0;
        this.append(items);
    }

    labelHeight(text, width, fontSize) {
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
        return (lines > 1 ? lines + 1 : lines) * this.lineHeight;
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
                this.rows.push({top: this.height, height, label, path: folder});
                this.height += height;
                previousFolder = folder;
            }
            if (!current || current.items.length === this.columns) {
                current = {top: this.height, height: this.minHeight, items: []};
                this.rows.push(current);
                this.height += current.height;
            }
            current.items.push(item);
            const labelWidth = cardWidth - (this.compact ? 138 : this.captionPadding * 2 + 2); // Card borders.
            const contentHeight = this.compact
                ? this.labelHeight(filename(item.path), labelWidth, this.cardFont) + 16
                : this.imageHeight + this.captionPadding * 2 + 2 + this.rowPadding * 2
                + this.labelHeight(filename(item.path), labelWidth, this.cardFont)
                + (item.type === 'folder' ? this.actionHeight : 0);
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
