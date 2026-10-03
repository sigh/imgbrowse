import assert from 'node:assert/strict';
import test from 'node:test';
import {readState, stateUrl, relativePath, ScreenMode, ReadingLayout, ImageSize} from '../image_browser/web/static/state.js';

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
        folder: 'Album & photos', layout: ReadingLayout.STRIP, compact: true, size: ImageSize.FIT_WIDTH, filter: 'chapter',
        mode: ScreenMode.VIEW, collection: 'Album & photos/Chapter 2',
        image: 'Album & photos/Chapter 2/page #1%.jpg',
    };
    assert.deepEqual(readState(new URL(stateUrl(state), 'http://localhost').search), state);
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

test('invalid image sizes fall back to Fit page and valid sizes survive URLs', () => {
    for (const size of ['0', '-1', 'NaN', 'Infinity', '10', '<script>']) {
        assert.equal(readState(new URLSearchParams({size})).size, ImageSize.FIT_PAGE);
    }
    for (const size of [ImageSize.FIT_PAGE, ImageSize.FIT_WIDTH, '0.5', '1.25', '8']) {
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
    for (const layout of ['grid', ReadingLayout.STRIP, ReadingLayout.SINGLE]) {
        const state = {...readState('folder=Album&image=page.jpg'), layout: layout === 'grid' ? ReadingLayout.STRIP : layout, mode: layout === 'grid' ? ScreenMode.OVERVIEW : ScreenMode.VIEW};
        const url = stateUrl(state);
        assert.equal(readState(new URL(url, 'http://localhost').search).layout, state.layout);
        assert.equal(new URL(url, 'http://localhost').searchParams.get('view'), layout === ReadingLayout.STRIP ? null : layout);
    }
    assert.equal(stateUrl(readState('folder=Album&view=single')), '/?folder=Album&view=single');
});
