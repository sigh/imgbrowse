import assert from 'node:assert/strict';
import test from 'node:test';
import {CollectionNavigator, NavigationOutcome} from '../image_browser/web/static/collection-navigator.js';

import {SortCriterion, SortOrder, ViewerEntry} from '../image_browser/web/static/state.js';

const page = (images = [], cursor = null, warnings = []) => ({images, cursor, warnings});
const state = {collection:'Album', image:'Album/2.jpg', sort:SortCriterion.NAME, order:SortOrder.ASCENDING};

function navigator(walk, options = {}) {
    const selections = [], prefetches = [];
    const navigation = new CollectionNavigator({walk, changed:() => {},
        select:(...args) => selections.push(args),
        loadOriginal:async path => { prefetches.push(path); }, ...options});
    navigation.configure(state);
    return {navigation, selections, prefetches};
}

test('movement follows empty continuation pages and retries the same failed direction', async () => {
    const requests = [];
    const pages = [page([], 'next', ['Unreadable']), new Error('Unavailable'), page(['Album/1.jpg'])];
    const {navigation, selections} = navigator(async options => {
        requests.push(options);
        const result = pages.shift();
        if (result instanceof Error) throw result;
        return result;
    });
    await navigation.request(true, true, ViewerEntry.KEEP);
    assert.equal(navigation.outcome.kind, NavigationOutcome.ERROR);
    assert.equal(navigation.moving, false);
    assert.equal(navigation.boundary, null);
    assert.equal(navigation.retry(), true);
    // Retry restarts at the selected image, preserving direction and entry policy.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(selections, [['Album/1.jpg', ViewerEntry.KEEP]]);
    assert.deepEqual(requests.map(({reverse, cursor}) => ({reverse, cursor})), [
        {reverse:true, cursor:null}, {reverse:true, cursor:'next'}, {reverse:true, cursor:null},
    ]);
});

test('held navigation stops at a boundary; a fresh action wraps', async () => {
    const requests = [];
    const {navigation, selections} = navigator(async options => {
        requests.push(options);
        return options.anchor ? page() : page(['Album/1.jpg']);
    });
    await navigation.request(false, true, ViewerEntry.TOP);
    assert.equal(navigation.boundary, false);
    await navigation.request(false, false, ViewerEntry.TOP);
    assert.equal(requests.length, 1);
    await navigation.request(false, true, ViewerEntry.TOP);
    assert.equal(requests[1].anchor, null);
    assert.deepEqual(selections, [['Album/1.jpg', ViewerEntry.TOP]]);
});

test('changing selection cancels a pending move without selecting stale results', async () => {
    let finish, signal;
    const {navigation, selections} = navigator((options, requestSignal) => {
        signal = requestSignal;
        return new Promise(resolve => { finish = resolve; });
    });
    const pending = navigation.request(false, true, ViewerEntry.TOP);
    navigation.configure({...state, image:'Album/3.jpg'});
    assert.equal(signal.aborted, true);
    finish(page(['Album/4.jpg']));
    await pending;
    assert.deepEqual(selections, []);
    assert.equal(navigation.outcome, null);
    assert.equal(navigation.moving, false);
});

test('warnings prevent a collection from being classified as a single image', async () => {
    const {navigation} = navigator(async () => page([], null, ['Unreadable']));
    navigation.discover(state.image, state.collection, new AbortController().signal);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(navigation.singleImage, false);
    await navigation.request(false, true, ViewerEntry.TOP);
    assert.deepEqual(navigation.outcome, {kind:NavigationOutcome.BOUNDARY, reverse:false, warning:true});
});

test('prefetch uses discovered order and cancels when sorting changes', async () => {
    let prefetchSignal;
    const {navigation, prefetches} = navigator(async options => page(options.reverse ? ['Album/1.jpg'] : ['Album/3.jpg']),
        {loadOriginal:async (path, signal) => { prefetches.push(path); prefetchSignal = signal; }});
    navigation.discover(state.image, state.collection, new AbortController().signal);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(prefetches, []);
    navigation.prefetch(true);
    assert.deepEqual(prefetches, ['Album/3.jpg']);
    navigation.configure({...state, sort:SortCriterion.MODIFIED, order:SortOrder.DESCENDING});
    assert.equal(prefetchSignal.aborted, true);
    assert.deepEqual(navigation.paths, []);
});
