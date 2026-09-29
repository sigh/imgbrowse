import assert from 'node:assert/strict';
import test from 'node:test';
import {readState, stateUrl, relativePath} from '../static/state.js';
import {TaskScope} from '../static/dom.js';
import {PreviewLoader} from '../static/preview-loader.js';

test('strip paths use the browsing folder, including an empty current-folder label', () => {
    const state = readState('folder=Album&collection=Album/Chapter%202&image=Chapter%202/page.jpg');
    assert.equal(relativePath(state.folder, state.collection), 'Chapter 2');
    assert.equal(relativePath('Album', 'Album'), '');
    assert.equal(relativePath('', ''), '');
    assert.equal(relativePath('', 'Album/Chapter 2'), 'Album/Chapter 2');
    assert.equal(relativePath('Album', 'Album/Chapter 2/deep'), 'Chapter 2/deep');
    assert.equal(relativePath('Album', 'Album Extra'), '../Album Extra');
});

test('image URLs retain independent grid and viewer contexts', () => {
    const state = {
        folder: 'Album & photos', recursive: false, compact: true, size: 'width', filter: 'chapter',
        viewing: true, collection: 'Album & photos/Chapter 2',
        image: 'Album & photos/Chapter 2/page #1%.jpg',
    };
    assert.deepEqual(readState(new URL(stateUrl(state), 'http://localhost').search), state);
});

test('literal percent filenames are preserved', () => {
    const current = new URLSearchParams({folder: 'Album', image: 'literal%20.jpg'});
    assert.equal(readState(current.toString()).image, 'Album/literal%20.jpg');
});

test('closing a viewer drops its collection override and preserves grid settings', () => {
    const state = readState('folder=parent&recursive=1&filter=page&collection=child&image=../child/a.jpg');
    const restored = readState(new URL(stateUrl({...state, viewing: false}), 'http://localhost').search);
    assert.equal(restored.folder, 'parent');
    assert.equal(restored.recursive, true);
    assert.equal(restored.filter, 'page');
    assert.equal(restored.image, null);
    assert.equal(restored.collection, 'parent');
});

test('disposing a task scope aborts requests and releases resources only once', async () => {
    const scope = new TaskScope();
    let released = 0;
    let delayed = false;
    scope.onDispose(() => released++);
    scope.delay(() => { delayed = true; }, 5);
    scope.dispose();
    scope.dispose();
    scope.onDispose(() => released++);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(released, 2);
    assert.equal(scope.signal.aborted, true);
    assert.equal(delayed, false);
});

function scheduler() {
    return new PreviewLoader(
        {getBoundingClientRect: () => ({top: 0, bottom: 600})},
        {contains: () => false, clientWidth: 800},
    );
}

function target(top) {
    return {isConnected: true, getBoundingClientRect: () => ({top, bottom: top + 100, left: 0})};
}

test('visible previews start top to bottom before offscreen work', async () => {
    const loader = scheduler();
    const scope = new TaskScope();
    const order = [];
    await Promise.all([1000, 200, 10].map(top => loader.enqueue(
        () => order.push(top), target(top), scope.signal,
    )));
    assert.deepEqual(order, [10, 200, 1000]);
});

test('queued previews are discarded when their row is removed', async () => {
    const loader = scheduler();
    const scope = new TaskScope();
    let started = false;
    const job = loader.enqueue(() => { started = true; }, target(10), scope.signal);
    scope.dispose();
    await assert.rejects(job, {name: 'AbortError'});
    assert.equal(started, false);
});


test('invalid image sizes fall back to Fit page and valid sizes survive URLs', () => {
    for (const size of ['0', '-1', 'NaN', 'Infinity', '10', '<script>']) {
        assert.equal(readState(new URLSearchParams({size})).size, 'page');
    }
    for (const size of ['page', 'width', '0.5', '1.25', '8']) {
        const state = {...readState(''), viewing: true, size};
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
