import assert from 'node:assert/strict';
import test from 'node:test';
import {CollectionWindow} from '../../image_browser/web/static/data/collection-window.js';
import {canRetryMedia, MediaErrorCode} from '../../image_browser/web/static/shared/media-kind.js';

test('bidirectional discovery trims the opposite edge and allows rediscovery', async () => {
    const requests = [];
    const window = new CollectionWindow(async options => {
        requests.push(options);
        return {images:options.reverse ? ['p1', 'p0'] : ['p3', 'p4'], cursor:null, warnings:[]};
    }, {root:'Album', image:'p2', pageSize:2, maxPaths:3});
    const signal = new AbortController().signal;
    const [before, after] = window.edges;
    assert.deepEqual(await window.load(after, signal), {added:['p3', 'p4'], removed:[]});
    assert.equal(after.done, true);
    assert.deepEqual(await window.load(before, signal), {added:['p0', 'p1'], removed:['p3', 'p4']});
    assert.deepEqual(window.paths, ['p0', 'p1', 'p2']);
    assert.equal(after.cursor, null);
    assert.equal(window.canLoad(after), true, 'Trimmed paths can be discovered again');
    assert.deepEqual(requests.map(({root, anchor, reverse, limit}) => ({root, anchor, reverse, limit})), [
        {root:'Album', anchor:'p2', reverse:false, limit:2},
        {root:'Album', anchor:'p2', reverse:true, limit:2},
    ]);
});

test('overlapping and empty pages retain continuation without duplicating paths', async () => {
    const requests = [];
    const pages = [
        {images:['p1', 'p2'], cursor:'next', warnings:[]},
        {images:[], cursor:'last', warnings:[]},
        {images:['p2', 'p3'], cursor:null, warnings:[]},
    ];
    const window = new CollectionWindow(async options => { requests.push(options); return pages.shift(); },
        {root:'Album', image:'p1', pageSize:2, maxPaths:3});
    const after = window.edges[1];
    const signal = new AbortController().signal;
    await window.load(after, signal);
    assert.deepEqual(await window.load(after, signal), {added:[], removed:[]});
    assert.equal(window.canLoad(after), true);
    await window.load(after, signal);
    assert.deepEqual(window.paths, ['p1', 'p2', 'p3']);
    assert.deepEqual(requests.map(({anchor, cursor}) => ({anchor, cursor})), [
        {anchor:'p1', cursor:null}, {anchor:'p2', cursor:'next'}, {anchor:'p2', cursor:'last'},
    ]);
    assert.equal(window.canLoad(after), false);
});

test('failed discovery can be retried without treating a warning as a complete collection', async () => {
    let attempts = 0;
    const window = new CollectionWindow(async () => {
        if (++attempts === 1) throw new Error('Unavailable');
        return {images:[], cursor:null, warnings:['Unreadable folder']};
    }, {root:'Album', image:'p1', pageSize:2, maxPaths:3});
    const after = window.edges[1];
    const signal = new AbortController().signal;
    assert.equal(await window.load(after, signal), null);
    assert.equal(window.canLoad(after), false);
    assert.equal(after.loading, false);
    assert.deepEqual(window.paths, ['p1']);
    after.failed = false;
    await window.load(after, signal);
    assert.equal(after.done, true);
    assert.equal(after.warning, true);
});

test('cancelled discovery cannot modify paths or become a retry failure', async () => {
    let finish;
    const window = new CollectionWindow(() => new Promise(resolve => { finish = resolve; }),
        {root:'Album', image:'p1', pageSize:2, maxPaths:3});
    const controller = new AbortController();
    const after = window.edges[1];
    const pending = window.load(after, controller.signal);
    assert.equal(window.canLoad(after), false, 'A pending edge cannot start another request');
    controller.abort();
    finish({images:['p2'], cursor:null, warnings:[]});
    assert.equal(await pending, null);
    assert.deepEqual(window.paths, ['p1']);
    assert.equal(after.failed, false);
    assert.equal(after.done, false);
    assert.equal(after.loading, false);
});

test('partial traversal warnings survive later successful pages until the window is reset', async () => {
    const pages = [
        {images:['p2'], cursor:'next', warnings:['Unreadable folder']},
        {images:['p3'], cursor:null, warnings:[]},
    ];
    const request = async () => pages.shift();
    const options = {root:'Album', image:'p1', pageSize:1, maxPaths:3};
    const window = new CollectionWindow(request, options);
    const after = window.edges[1];
    const signal = new AbortController().signal;
    await window.load(after, signal);
    assert.equal(window.warning, true);
    assert.equal(after.failed, false, 'Skipped branches do not fail accessible media discovery');
    await window.load(after, signal);
    assert.deepEqual(window.paths, ['p1', 'p2', 'p3']);
    assert.equal(after.done, true);
    assert.equal(window.warning, true);
    assert.equal(new CollectionWindow(request, options).warning, false);
});

test('retry eligibility distinguishes download failures from unplayable media', () => {
    for (const code of [MediaErrorCode.ABORTED, MediaErrorCode.NETWORK]) assert.equal(canRetryMedia({code}), true);
    for (const code of [MediaErrorCode.DECODE, MediaErrorCode.UNSUPPORTED]) assert.equal(canRetryMedia({code}), false);
    assert.equal(canRetryMedia(new Error('Download failed')), true);
});

test('an old cancellation cannot clear the loading state of a reopened view', async () => {
    const responses = [];
    const window = new CollectionWindow(() => new Promise(resolve => responses.push(resolve)),
        {root:'Album', image:'p1', pageSize:2, maxPaths:3});
    const after = window.edges[1];
    const closing = new AbortController();
    const old = window.load(after, closing.signal);
    closing.abort();
    after.loading = false; // Hiding the strip cancels its discovery work.
    const current = window.load(after, new AbortController().signal);
    responses[0]({images:['old'], cursor:null, warnings:[]});
    assert.equal(await old, null);
    assert.equal(after.loading, true);
    assert.deepEqual(window.paths, ['p1']);
    responses[1]({images:['p2'], cursor:null, warnings:[]});
    await current;
    assert.equal(after.loading, false);
    assert.deepEqual(window.paths, ['p1', 'p2']);
});
