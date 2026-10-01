import assert from 'node:assert/strict';
import test from 'node:test';
import {readState, stateUrl, relativePath, revealInBrowse} from '../image_browser/web/static/state.js';
import {TaskScope} from '../image_browser/web/static/dom.js';
import {PreviewLoader, durationLabel} from '../image_browser/web/static/preview-loader.js';

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
        folder: 'Album & photos', layout: 'strip', overview: false, recursive: false, compact: true, size: 'width', filter: 'chapter',
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
    assert.equal(restored.recursive, false);
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
        {getBoundingClientRect: () => ({top: 0, bottom: 600, left: 0, right: 800})},
        {contains: () => false, clientWidth: 800},
    );
}

function target(top) {
    return {isConnected: true, getBoundingClientRect: () => ({top, bottom: top + 100, left: 0, right: 100})};
}

test('visible previews load top to bottom; offscreen work waits for visibility', async () => {
    const loader = scheduler();
    const scope = new TaskScope();
    const order = [];
    const offscreen = target(1000);
    const pending = loader.enqueue(() => order.push(1000), offscreen, scope.signal);
    await Promise.all([200, 10].map(top => loader.enqueue(
        () => order.push(top), target(top), scope.signal,
    )));
    assert.deepEqual(order, [10, 200]);
    offscreen.getBoundingClientRect = target(300).getBoundingClientRect;
    loader.schedule();
    await pending;
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

test('cancelling idle offscreen work releases its promise and queue entry immediately', async () => {
    const loader = scheduler();
    const scope = new TaskScope();
    const job = loader.enqueue(() => assert.fail('Offscreen work started'), target(1000), scope.signal);
    await new Promise(resolve => setTimeout(resolve, 0));
    scope.dispose();
    await assert.rejects(job, {name: 'AbortError'});
    assert.equal(loader.jobs.length, 0);
});

test('leaving the viewport aborts active work and reentry resumes without a retry loop', async () => {
    const loader = scheduler();
    const scope = new TaskScope();
    const card = target(10);
    let calls = 0;
    let started;
    const running = new Promise(resolve => { started = resolve; });
    const job = loader.enqueue(signal => {
        calls++;
        if (calls > 1) return 'loaded';
        started();
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true}));
    }, card, scope.signal);
    await running;
    card.getBoundingClientRect = target(1000).getBoundingClientRect;
    loader.schedule();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    assert.equal(loader.running, 0);
    card.getBoundingClientRect = target(20).getBoundingClientRect;
    loader.schedule();
    assert.equal(await job, 'loaded');
    assert.equal(calls, 2);
});

test('a source AbortError settles once and leaves the browser event loop available', async () => {
    const loader = scheduler();
    const scope = new TaskScope();
    let calls = 0, heartbeat = false;
    const timer = new Promise(resolve => setTimeout(() => { heartbeat = true; resolve(); }, 0));
    const job = loader.enqueue(() => {
        calls++;
        // Keep this regression finite if unconditional retry is reintroduced.
        if (calls <= 100) throw new DOMException('Source cancelled', 'AbortError');
        return 'unexpected retry';
    }, target(10), scope.signal);
    await assert.rejects(job, {name: 'AbortError'});
    await timer;
    assert.equal(calls, 1);
    assert.equal(heartbeat, true);
    assert.equal(scope.signal.aborted, false);
    assert.equal(await loader.enqueue(() => 'next preview', target(20), scope.signal), 'next preview');
});

test('even deliberately paused previews yield to input between restarts', async () => {
    const loader = scheduler();
    const scope = new TaskScope();
    let heartbeat = false, calls = 0;
    const job = loader.enqueue(signal => {
        calls++;
        if (calls > 1) return heartbeat;
        // The viewport can change while a request is being scheduled.
        [...loader.active][0].controller.abort();
        setTimeout(() => { heartbeat = true; }, 0);
        signal.throwIfAborted();
    }, target(10), scope.signal);
    assert.equal(await job, true);
    assert.equal(calls, 2);
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


test('returning to browse reveals the image without mutating shared state', () => {
    const state = Object.freeze({...readState('folder=Album&filter=other'), viewing: false});
    const result = revealInBrowse(state, 'Album/Chapter/page.jpg');
    assert.equal(state.filter, 'other');
    assert.equal(result.state.filter, '');
    assert.deepEqual(result.position, {path: 'Album/Chapter', offset: 0, reveal: true});
    assert.equal(revealInBrowse(state, 'Elsewhere/page.jpg').position, null);
    const recursive = {...state, recursive: true};
    assert.equal(revealInBrowse(recursive, 'Album/Chapter/page.jpg').position.path, 'Album/Chapter/page.jpg');
});

test('queued video extraction leaves capacity for image previews', async () => {
    const loader = scheduler();
    const scope = new TaskScope();
    const order = [];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const first = loader.enqueue(async () => { order.push('video1'); await held; }, target(0), scope.signal, true);
    const second = loader.enqueue(() => order.push('video2'), target(10), scope.signal, true);
    const image = loader.enqueue(() => order.push('image'), target(20), scope.signal);
    await image;
    assert.deepEqual(order, ['video1', 'image']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['video1', 'image', 'video2']);
});


test('duration labels stay compact and omit missing metadata', () => {
    assert.equal(durationLabel(undefined), '');
    assert.equal(durationLabel(37.4), '0:37');
    assert.equal(durationLabel(3605), '1:00:05');
});

test('cached preview jobs bypass a blocked video extraction', async () => {
    const loader = scheduler();
    const scope = new TaskScope();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const first = loader.enqueue(() => held, target(0), scope.signal, true);
    let cachedRan = false;
    await loader.enqueue(() => { cachedRan = true; }, target(10), scope.signal, true, () => true);
    assert.equal(cachedRan, true);
    release();
    await first;
});


test('view grid has a compact URL and browse never recurses', () => {
    const state = readState('folder=Album&view=grid');
    assert.equal(state.viewing, true);
    assert.equal(state.overview, true);
    assert.equal(state.recursive, true);
    assert.equal(stateUrl(state), '/?folder=Album&view=grid');
    assert.equal(readState('folder=Album').recursive, false);
});

test('viewer layouts have stable, reloadable URLs', () => {
    for (const layout of ['grid', 'strip', 'single']) {
        const state = {...readState('folder=Album&image=page.jpg'), layout, overview: layout === 'grid', recursive: layout === 'grid'};
        const url = stateUrl(state);
        assert.equal(readState(new URL(url, 'http://localhost').search).layout, layout);
        assert.equal(new URL(url, 'http://localhost').searchParams.get('view'), layout === 'strip' ? null : layout);
    }
    assert.equal(stateUrl(readState('folder=Album&view=single')), '/?folder=Album&view=single');
});
