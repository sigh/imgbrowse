import {filename, parentPath} from '../shared/state.js';

/** Row metadata for a virtual grid. Appending a page only changes its last row. */
export class GridLayout {
    constructor(viewport, itemGeometry) {
        this.viewport = viewport;
        this.itemGeometry = itemGeometry;
        this.measure = document.createElement('canvas').getContext('2d');
        this.rows = [];
        this.byPath = new Map();
        this.measurements = new Map();
        this.height = 0;
        this.width = 0;
        this.columns = 1;
    }

    reset(items, recursive, rootName, imageAspect = null) {
        const style = getComputedStyle(this.viewport);
        const number = name => parseFloat(style.getPropertyValue(name));
        this.number = number;
        this.width = this.viewport.clientWidth;
        this.contentWidth = this.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        this.gap = number('--grid-column-gap');
        this.minHeight = number('--grid-min-row-height');
        this.lineHeight = number('--label-line-height');
        this.cardFont = number('--card-label-font-size');
        this.headingFont = number('--folder-label-font-size');
        this.imageHeight = number('--card-image-height');
        this.captionPadding = number('--card-caption-padding');
        this.listMinHeight = number('--list-row-height');
        this.listPadding = number('--list-padding-block');
        this.listBorder = number('--list-border-width');
        this.cardBorder = number('--card-border-width');
        this.headingMinHeight = number('--folder-heading-min-height');
        this.headingPadding = number('--folder-heading-padding-block');
        this.rowPadding = number('--grid-row-padding');
        this.fontFamily = style.fontFamily;
        this.compact = this.viewport.classList.contains('compact');
        this.columns = this.compact ? 1 : Math.max(1, Math.floor(this.width / number('--grid-min-column-width')));
        if (imageAspect) {
            const cardWidth = (this.contentWidth - (this.columns - 1) * this.gap) / this.columns;
            this.imageHeight = cardWidth / imageAspect;
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
        const key = JSON.stringify([text, Math.floor(width), fontSize, this.fontFamily, this.lineHeight]);
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

    appendDisclosure(path, label, files, expanded) {
        const row = {top:this.height, height:this.listMinHeight, path, label, expanded, disclosure:true};
        this.rows.push(row);
        this.byPath.set('heading:' + path, row);
        this.height += row.height;
        if (expanded) this.append(files, true);
    }

    append(items, compact = this.compact) {
        const last = this.rows.at(-1);
        let current = last?.items && last.compact === compact ? last : null;
        let previousFolder = current ? parentPath(current.items.at(-1).path) : null;
        const columns = compact ? 1 : this.columns;
        const cardWidth = (this.contentWidth - (columns - 1) * this.gap) / columns;
        for (const item of items) {
            const folder = parentPath(item.path);
            if (this.recursive && folder !== previousFolder) {
                current = null;
                const label = folder || this.rootName;
                const height = Math.max(this.headingMinHeight, this.labelHeight(label, this.contentWidth, this.headingFont) + 2 * this.headingPadding);
                const heading = {top: this.height, height, label, path: folder};
                this.rows.push(heading);
                this.byPath.set('heading:' + folder, heading);
                this.height += height;
                previousFolder = folder;
            }
            if (!current || current.items.length === columns) {
                current = {top: this.height, height: compact ? this.listMinHeight : this.minHeight, items: [], startIndex: this.itemCount, compact, columns};
                this.rows.push(current);
                this.height += current.height;
            }
            current.items.push(item);
            this.itemCount++;
            this.byPath.set('item:' + item.path, current);
            const {labelInset, minLabelHeight, labelExtraHeight} = this.itemGeometry(item, compact, this.number, this.recursive);
            const labelHeight = Math.max(minLabelHeight,
                this.labelHeight(filename(item.path), cardWidth - labelInset, this.cardFont) + labelExtraHeight);
            const contentHeight = compact
                ? labelHeight + 2 * this.listPadding + this.listBorder
                : this.imageHeight + this.captionPadding * 2 + 2 * this.cardBorder + this.rowPadding * 2
                + labelHeight;
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
