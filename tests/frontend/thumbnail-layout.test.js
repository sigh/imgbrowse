import assert from 'node:assert/strict';
import test from 'node:test';
import {ThumbnailLayout} from '../../image_browser/web/static/viewer/thumbnail-layout.js';

const paths = ['Album/A/1.jpg', 'Album/A/2.webm', 'Album/B/1.jpg', 'Album/B/2.jpg', 'Album/C/1.jpg'];
const layout = (items = paths, options = {}) => new ThumbnailLayout(items, {
    width:60, gap:6, folderWidth:100, folderGap:8, labelRoot:'Album',
    leadingKnown:true, paddingStart:12, paddingEnd:12, ...options,
});

test('labels occupy space only at known folder boundaries, and media share one width', () => {
    const strip = layout();
    assert.deepEqual(strip.items.map(item => item.label), ['A', '', 'B', '', 'C']);
    assert.equal(strip.items[0].thumbnailLeft, 108);
    assert.equal(strip.items[1].left - strip.items[0].right, 6);
    assert.equal(strip.items[1].right - strip.items[1].thumbnailLeft, 60);
    assert.equal(strip.contentWidth, strip.items.at(-1).right);
    assert.equal(layout(paths, {leadingKnown:false}).items[0].label, '', 'A partial leading group has no invented title');
    assert.equal(layout(paths, {labelRoot:'Album/A'}).items[0].label, '', 'The current folder needs no redundant title');
});

test('resizing preserves a fixed title and scales a point inside a thumbnail', () => {
    const before = layout(), after = layout(paths, {width:120});
    const titleLeft = before.paddingStart + before.items[2].left + 40;
    const titleAnchor = before.anchor(titleLeft, 250);
    const titleScroll = after.scrollLeft(titleAnchor, 250);
    assert.equal(after.items[2].left + after.paddingStart - titleScroll,
        before.items[2].left + before.paddingStart - titleLeft);
    const imageLeft = before.paddingStart + before.items[2].thumbnailLeft + before.width * .4;
    const imageAnchor = before.anchor(imageLeft, 250);
    assert.equal(imageAnchor.fraction, .4);
    assert.equal(after.scrollLeft(imageAnchor, 250), after.paddingStart + after.items[2].thumbnailLeft + after.width * .4);
});

test('title insertion and removal preserve a visible selection instead of an exposed neighbor', () => {
    const before = layout(), hidden = layout(paths, {labelRoot:'Album/B'});
    const left = before.paddingStart + before.items[2].left + 40;
    const anchor = before.anchor(left, 250, {preferred:paths[2]});
    const moved = hidden.scrollLeft(anchor, 250);
    assert.equal(hidden.paddingStart + hidden.items[2].thumbnailLeft - moved, anchor.x);
    const restored = hidden.anchor(moved, 250, {preferred:paths[2]});
    assert.equal(before.scrollLeft(restored, 250), left);
});

test('prepend and trim preserve a retained visible path using the old snapshot', () => {
    const before = layout(), prepended = layout(['Album/0/1.jpg', ...paths]);
    const left = before.paddingStart + before.items[2].thumbnailLeft - 20;
    const anchor = before.anchor(left, 250);
    const moved = prepended.scrollLeft(anchor, 250);
    assert.equal(prepended.paddingStart + prepended.byPath.get(anchor.path).thumbnailLeft - moved, anchor.x);
    const trimmed = layout(paths.slice(2));
    const retained = new Set(trimmed.byPath.keys());
    const trimAnchor = before.anchor(160, 250, {retained});
    assert.equal(trimAnchor.path, paths[2], 'An evicted leading thumbnail cannot anchor the new window');
    const trimLeft = trimmed.scrollLeft(trimAnchor, 100);
    assert.ok(trimLeft >= 0 && trimLeft <= trimmed.contentWidth + 24 - 100);
    assert.equal(before.items.length, 5, 'Loading a new window cannot change the previous geometry');
});

test('offscreen selections do not override the visible anchor', () => {
    const strip = layout();
    const left = strip.paddingStart + strip.items[3].left;
    assert.equal(strip.anchor(left, 100, {preferred:paths[0]}).path, paths[3]);
    assert.equal(strip.anchor(left, 100, {retained:new Set() }), null);
    assert.equal(strip.scrollLeft({path:'deleted.jpg', fraction:0, x:0}, 100), null);
});

test('centering clamps at real ends and visible rendering stays bounded', () => {
    const items = Array.from({length:2048}, (_, index) => 'Album/A/' + index + '.jpg');
    const strip = layout(items);
    const center = path => strip.scrollLeft({path, fraction:.5, x:150}, 300);
    assert.equal(center(items[0]), 0);
    assert.equal(center(items.at(-1)), strip.paddingStart + strip.contentWidth + strip.paddingEnd - 300);
    const middle = strip.byPath.get(items[1024]);
    assert.equal(center(middle.path), strip.paddingStart + middle.thumbnailLeft + 30 - 150);
    assert.ok(strip.visible(center(middle.path), 300).length < 15);
    assert.ok(strip.visible(center(middle.path), 300).some(item => item.path === middle.path));
    assert.deepEqual(layout([]).visible(0, 300), []);
    assert.equal(layout([]).scrollLeft({path:'missing', fraction:0, x:0}, 300), null);
});
