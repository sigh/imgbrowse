import assert from 'node:assert/strict';
import test from 'node:test';
import {ResourceCache} from '../static/resource-cache.js';
import {Sequence} from '../static/sequence.js';

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
