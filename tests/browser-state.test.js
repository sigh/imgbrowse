import assert from 'node:assert/strict';
import test from 'node:test';
import {readState, stateUrl, relativePath, sortSettings, sortKey, ScreenMode, ReadingLayout, ImageSize, SortCriterion, SortOrder} from '../image_browser/web/static/state.js';

test('strip paths use the browsing folder, including an empty current-folder label', () => {
    const state = readState('folder=Album&collection=Album/Chapter%202&image=Chapter%202/page.jpg');
    assert.equal(relativePath(state.folder, state.collection), 'Chapter 2');
    assert.equal(relativePath('Album', 'Album'), '');
    assert.equal(relativePath('', ''), '');
    assert.equal(relativePath('', 'Album/Chapter 2'), 'Album/Chapter 2');
    assert.equal(relativePath('Album', 'Album/Chapter 2/deep'), 'Chapter 2/deep');
    assert.equal(relativePath('Album', 'Album Extra'), '../Album Extra');
});

test('legacy image URLs retain their collection override', () => {
    const state = {
        ...readState(''),
        folder: 'Album & photos', layout: ReadingLayout.SCROLL, compact: true, size: ImageSize.DEFAULT, filter: 'chapter',
        mode: ScreenMode.VIEW, collection: 'Album & photos/Chapter 2',
        image: 'Album & photos/Chapter 2/page #1%.jpg',
    };
    assert.deepEqual(readState(new URL(stateUrl(state), 'http://localhost').search), state);
});

test('shared sort and direction round trip in every presentation', () => {
    for (const view of ['', 'grid', 'strip', 'single', 'scroll']) {
        for (const sort of Object.values(SortCriterion)) for (const order of Object.values(SortOrder)) {
            const state = readState(new URLSearchParams({folder:'Album', image:'page.jpg', view, sort, order}));
            assert.deepEqual(readState(new URL(stateUrl(state), 'http://localhost').search), state);
            const browse = readState(new URL(stateUrl({...state, mode:ScreenMode.BROWSE}), 'http://localhost').search);
            assert.deepEqual(sortSettings(browse), {sort, order});
            assert.equal(sortKey(browse), sortKey(state));
        }
    }
    const invalid = readState('sort=capture&order=sideways');
    assert.deepEqual(sortSettings(invalid), {sort:SortCriterion.NAME, order:SortOrder.ASCENDING});
    assert.equal(sortKey(invalid), sortKey({}));
    assert.equal(stateUrl(invalid), '/');
});

test('legacy folder sort fields are omitted while the shared setting is retained', () => {
    const state = readState('sort=modified&order=desc&folder_sort=natural&folder_order=asc');
    assert.equal(stateUrl(state), '/?sort=modified&order=desc');
    assert.equal('folder_sort' in state, false);
    assert.equal('folder_order' in state, false);
});

test('literal percent filenames are preserved', () => {
    const current = new URLSearchParams({folder: 'Album', image: 'literal%20.jpg'});
    assert.equal(readState(current.toString()).image, 'Album/literal%20.jpg');
});

test('Browse URLs omit viewer state and retain their explicit folder settings', () => {
    const state = readState('folder=parent&recursive=1&filter=page&collection=child&image=../child/a.jpg');
    const restored = readState(new URL(stateUrl({...state, mode: ScreenMode.BROWSE}), 'http://localhost').search);
    assert.equal(restored.folder, 'parent');
    assert.equal(restored.mode, ScreenMode.BROWSE);
    assert.equal(restored.filter, 'page');
    assert.equal(restored.image, null);
    assert.equal(restored.collection, 'parent');
});

test('invalid zoom falls back to the presentation default and numeric zoom survives URLs', () => {
    for (const size of ['0', '-1', 'NaN', 'Infinity', '10', '<script>', '.001']) {
        assert.equal(readState(new URLSearchParams({size})).size, ImageSize.DEFAULT);
    }
    for (const size of [ImageSize.DEFAULT, '0.01', '0.5', '1.25', '1.37', '8']) {
        const state = {...readState(''), mode: ScreenMode.VIEW, size};
        assert.equal(readState(new URL(stateUrl(state), 'http://localhost').search).size, size);
    }
});


test('URLs omit defaults and express images relative to their folder', () => {
    assert.equal(stateUrl(readState('folder=&sort=natural&size=page')), '/');
    const state = readState('folder=Album&image=Chapter/page.jpg');
    assert.equal(stateUrl(state), '/?folder=Album&image=Chapter%2Fpage.jpg');
    assert.deepEqual(readState(stateUrl(state).slice(1)), state);
    assert.equal(stateUrl(readState('folder=Album&viewer=1')), '/?folder=Album&viewer=1');
});

test('relative image paths are unambiguous even with repeated folder names', () => {
    for (const image of ['Album/page.jpg', '../Sibling/page.jpg', 'a ?#%.jpg', 'Book.cbz/chapter/page.jpg']) {
        const state = readState(new URLSearchParams({folder: 'Album', image}));
        assert.deepEqual(readState(new URL(stateUrl(state), 'http://localhost').search), state);
    }
    assert.equal(readState('folder=Album&image=Album/page.jpg').image, 'Album/Album/page.jpg');
});


test('view grid has a compact URL and browse never recurses', () => {
    const state = readState('folder=Album&view=grid');
    assert.equal(state.mode, ScreenMode.OVERVIEW);
    assert.equal(stateUrl(state), '/?folder=Album&view=grid');
    assert.equal(readState('folder=Album').mode, ScreenMode.BROWSE);
});

test('viewer layouts have stable, reloadable URLs', () => {
    for (const layout of ['grid', ...Object.values(ReadingLayout)]) {
        const state = {...readState('folder=Album&image=page.jpg'), layout: layout === 'grid' ? ReadingLayout.STRIP : layout, mode: layout === 'grid' ? ScreenMode.OVERVIEW : ScreenMode.VIEW};
        const url = stateUrl(state);
        assert.equal(readState(new URL(url, 'http://localhost').search).layout, state.layout);
        assert.equal(new URL(url, 'http://localhost').searchParams.get('view'), layout === ReadingLayout.STRIP ? null : layout);
    }
    assert.equal(stateUrl(readState('folder=Album&view=single')), '/?folder=Album&view=single');
    assert.equal(stateUrl(readState('folder=Album&view=scroll')), '/?folder=Album&view=scroll');
});

test('old Width links select continuous reading; Page links select default zoom', () => {
    const state = readState('folder=Album&image=page.jpg&size=width');
    assert.equal(state.layout, ReadingLayout.SCROLL);
    assert.equal(state.size, ImageSize.DEFAULT);
    assert.equal(stateUrl(state), '/?folder=Album&view=scroll&image=page.jpg');
    assert.equal(readState('folder=Album&image=page.jpg&size=page').size, ImageSize.DEFAULT);
});
