import assert from 'node:assert/strict';
import test from 'node:test';
import {ResourceCache} from '../../image_browser/web/static/data/resource-cache.js';
import {Sequence} from '../../image_browser/web/static/data/sequence.js';
import {SortCriterion, SortOrder} from '../../image_browser/web/static/shared/state.js';

test('shared work survives one cancelled consumer and caches its result', async () => {
    const cache = new ResourceCache(10);
    const first = new AbortController(), second = new AbortController();
    let finish, calls = 0, shared;
    const load = signal => { calls++; shared = signal; return new Promise(resolve => { finish = resolve; }); };
    const a = cache.get('x', load, first.signal);
    const b = cache.get('x', load, second.signal);
    await Promise.resolve(); first.abort();
    await assert.rejects(a, {name: 'AbortError'});
    assert.equal(shared.aborted, false);
    finish('done'); assert.equal(await b, 'done');
    assert.equal(await cache.get('x', load), 'done'); assert.equal(calls, 1);
});

test('last departing consumer cancels work and refresh prevents stale cache writes', async () => {
    const cache = new ResourceCache(10);
    const consumer = new AbortController(); let finish, shared;
    const promise = cache.get('x', signal => { shared = signal; return new Promise(resolve => { finish = resolve; }); }, consumer.signal);
    await Promise.resolve(); consumer.abort(); await assert.rejects(promise);
    assert.equal(shared.aborted, true);
    cache.clear(); finish('old'); await Promise.resolve();
    assert.equal(await cache.get('x', async () => 'new'), 'new');
});

test('sequence reuses grid discoveries and remembers collection boundaries', async () => {
    let requests = 0;
    const sequence = new Sequence(async () => { requests++; throw Error('unexpected request'); });
    sequence.seed('album', ['a.jpg', 'b.jpg', 'c.jpg'], {start: true, end: true});
    assert.deepEqual((await sequence.walk({root: 'album', anchor: 'a.jpg', limit: 16})).images, ['b.jpg', 'c.jpg']);
    assert.deepEqual((await sequence.walk({root: 'album', anchor: 'c.jpg', reverse: true, limit: 16})).images, ['b.jpg', 'a.jpg']);
    assert.equal(requests, 0);
});

test('sequence isolates adjacency and endpoints for each sort and direction', async () => {
    const sequence = new Sequence(async () => { throw Error('Unexpected request'); });
    const orders = [{}, {order:SortOrder.DESCENDING}, {sort:SortCriterion.MODIFIED}, {sort:SortCriterion.MODIFIED, order:SortOrder.DESCENDING}];
    const images = [['a','b','c'], ['c','b','a'], ['b','c','a'], ['b','a','c']];
    orders.forEach((ordering, index) => sequence.seed('album', images[index], {...ordering, start:true, end:true}));
    for (const [index, ordering] of orders.entries()) {
        assert.deepEqual((await sequence.walk({root:'album', ...ordering})).images, images[index]);
        assert.deepEqual((await sequence.walk({root:'album', reverse:true, ...ordering})).images, [...images[index]].reverse());
    }
});

test('sequence carries the latest anchor through empty server continuation pages', async () => {
    const calls = [];
    const sequence = new Sequence(async options => {
        calls.push(options);
        return calls.length === 1 ? {images: ['b'], cursor: [{path: 'deep'}], warnings: []}
            : {images: [], cursor: null, warnings: []};
    });
    const first = await sequence.walk({root: '', anchor: 'a', limit: 16});
    await sequence.walk({root: '', anchor: 'a', cursor: first.cursor, limit: 16});
    assert.deepEqual((await sequence.walk({root: '', anchor: 'a', limit: 16})).images, ['b']);
    assert.equal(calls.length, 2);
});


test('synchronous cache reads retain recently used values', async () => {
    const cache = new ResourceCache(10, 2);
    await cache.get('a', async () => 'a');
    await cache.get('b', async () => 'b');
    assert.equal(cache.getCached('a'), 'a');
    await cache.get('c', async () => 'c');
    assert.equal(cache.peek('a'), 'a');
    assert.equal(cache.peek('b'), undefined);
});

test('scoped refresh preserves unrelated pending requests and adjacency', async () => {
    const cache = new ResourceCache(100);
    let release;
    const pending = cache.get('B', () => new Promise(resolve => { release = resolve; }));
    await Promise.resolve(); cache.clear(key => key === 'A'); release('alive');
    assert.equal(await pending, 'alive');
    assert.equal(cache.peek('B'), 'alive');
    const sequence = new Sequence(async () => assert.fail('Unrelated adjacency was discarded'));
    sequence.seed('B', ['B/a','B/b'], {revision:'v1', start:true, end:true});
    sequence.clear('A');
    assert.deepEqual((await sequence.walk({root:'B', anchor:'B/a'})).images, ['B/b']);
});

test('changed view revisions discard stale adjacency and boundaries', async () => {
    const sequence = new Sequence(async () => assert.fail('Expected the new seeded order'));
    sequence.seed('A', ['A/a','A/b','A/c'], {revision:'old', start:true, end:true});
    sequence.seed('A', ['A/c','A/a','A/b'], {revision:'new', start:true, end:true});
    assert.deepEqual((await sequence.walk({root:'A'})).images, ['A/c','A/a','A/b']);
    assert.deepEqual((await sequence.walk({root:'A', anchor:'A/b'})).images, []);
});

test('authoritative publication retires older producers and preserves cache accounting', async () => {
    const disposed = [];
    const cache = new ResourceCache(10, 2, value => disposed.push(value));
    let finish, shared;
    const pending = cache.get('x', signal => {
        shared = signal;
        return new Promise(resolve => { finish = resolve; });
    });
    const rejected = assert.rejects(pending, {name:'AbortError'});
    await Promise.resolve();
    cache.set('x', 'current', () => 6);
    assert.equal(shared.aborted, true);
    finish('obsolete'); await rejected;
    assert.equal(cache.peek('x'), 'current');
    assert.equal(cache.bytes, 6);
    cache.set('x', 'replacement', () => 6);
    cache.set('y', 'other', () => 6);
    assert.equal(cache.peek('x'), undefined);
    assert.equal(cache.peek('y'), 'other');
    assert.equal(cache.bytes, 6);
    assert.deepEqual(disposed, ['obsolete', 'current', 'replacement']);
});

test('sequence does not connect natural neighbors back to a removed anchor', async () => {
    const requests = [];
    const sequence = new Sequence(async options => {
        requests.push(options);
        return requests.length === 1 ? {images:['b'], cursor:null, warnings:[], anchor_missing:true}
            : {images:['a'], cursor:null, warnings:[]};
    });
    const next = await sequence.walk({root:'Album', anchor:'removed'});
    assert.equal(next.anchor_missing, true);
    const previous = await sequence.walk({root:'Album', anchor:'b', reverse:true});
    assert.deepEqual(previous.images, ['a']);
    assert.equal(requests.length, 2, 'Reverse discovery must not reuse an edge to the deleted anchor');
});
