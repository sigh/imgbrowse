import assert from 'node:assert/strict';
import test from 'node:test';
import {TaskScope} from '../../image_browser/web/static/shared/dom.js';
import {PreviewLoader} from '../../image_browser/web/static/ui/preview-loader.js';
import {durationLabel} from '../../image_browser/web/static/shared/media-kind.js';

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
