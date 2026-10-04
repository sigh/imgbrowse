import assert from 'node:assert/strict';
import test from 'node:test';
import {folderPath, fitFolderPath, PathKind} from '../image_browser/web/static/folder-path.js';

test('Browse identifies the current folder while ancestors remain navigation links', () => {
    const items = folderPath({folder:'Album/Packed.cbz', rootName:'Photos'});
    assert.deepEqual(items.map(({path, label, browsing, link, current}) => ({path, label, browsing, link, current})), [
        {path:'', label:'Photos', browsing:false, link:true, current:null},
        {path:'Album', label:'Album', browsing:false, link:true, current:null},
        {path:'Album/Packed.cbz', label:'Packed.cbz', browsing:true, link:false, current:'page'},
    ]);
    assert.deepEqual(folderPath({folder:'', rootName:'Photos'}), [
        {path:'', label:'Photos', kind:PathKind.FOLDER, browsing:true, link:false, current:'page'},
    ]);
});

test('Reading distinguishes the browsing folder, containing folder and current file', () => {
    const items = folderPath({folder:'Album/Chapter & #1', image:'Album/Chapter & #1/page.jpg',
        rootName:'Photos', collection:'Album', currentLink:true});
    assert.equal(items.find(item => item.browsing).path, 'Album');
    assert.deepEqual(items.slice(-2), [
        {path:'Album/Chapter & #1', label:'Chapter & #1', kind:PathKind.FOLDER, browsing:false, link:true, current:'location'},
        {path:'Album/Chapter & #1/page.jpg', label:'page.jpg', kind:PathKind.FILE, browsing:false, link:false, current:'page'},
    ]);
    const overview = folderPath({folder:'Album', rootName:'Photos', collection:'Album', currentLink:true});
    assert.equal(overview.at(-1).link, true);
    assert.equal(overview.at(-1).current, 'page');
});

const readingPath = () => folderPath({folder:'Library/Book/Chapter/deep', image:'Library/Book/Chapter/deep/page.jpg',
    rootName:'Photos', collection:'Library/Book', currentLink:true});
const widths = [35, 35, 50, 50, 35, 65];
const geometry = {spacing:6, separator:5, gap:28};

test('A fitting path retains every item and does not change the model', () => {
    const items = readingPath();
    const before = structuredClone(items);
    const fitted = fitFolderPath(items, widths, {...geometry, available:400});
    assert.deepEqual(fitted, {parts:items, truncated:false});
    fitted.parts.forEach((item, index) => assert.equal(item, items[index]));
    assert.deepEqual(items, before);
});

test('Narrow paths collapse ancestors first and preserve both browsing and file identity', () => {
    const items = readingPath();
    const before = structuredClone(items);
    const ancestors = fitFolderPath(items, widths, {...geometry, available:310});
    assert.deepEqual(ancestors.parts, [{kind:PathKind.GAP, items:items.slice(0, 2)}, ...items.slice(2)]);
    const narrow = fitFolderPath(items, widths, {...geometry, available:224});
    assert.deepEqual(narrow, {parts:[
        {kind:PathKind.GAP, items:items.slice(0, 2)}, items[2],
        {kind:PathKind.GAP, items:items.slice(3, 5)}, items[5],
    ], truncated:false});
    assert.deepEqual(items, before);
});

test('Names are truncated only after collapsible folders have been removed', () => {
    const items = readingPath();
    const fitted = fitFolderPath(items, widths, {...geometry, available:108});
    assert.equal(fitted.truncated, true);
    assert.deepEqual(fitted.parts[0], {kind:PathKind.GAP, items:[...items.slice(0, 2), ...items.slice(3, 5)]});
    assert.deepEqual(fitted.parts.filter(item => item.kind !== PathKind.GAP), [items[2], items[5]]);
    const root = folderPath({folder:'', rootName:'A long collection name'});
    assert.deepEqual(fitFolderPath(root, [200], {...geometry, available:100}), {parts:root, truncated:true});
});
