import assert from 'node:assert/strict';
import test from 'node:test';
import {EntryStore, FactDemand} from '../../image_browser/web/static/data/entry-store.js';
import {entryKey} from '../../image_browser/web/static/shared/state.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const item = (name, type = 'image') => ({path:'Album/' + name, type});
const page = items => ({entries:items.map(({name, type}) => ({name, type, status:'ready', modified:null}))});

test('facts share consumers across orderings and preserve colliding file and folder identities', async () => {
    let release, calls = 0;
    const store = new EntryStore((path, items) => {
        calls++; return new Promise(resolve => { release = () => resolve(page(items)); });
    });
    const identities = [item('chapter.jpg'), item('chapter.jpg', 'folder')];
    const first = new AbortController(), second = new AbortController();
    const a = store.load('Album', 'v1', identities, first.signal);
    const b = store.load('Album', 'v1', [...identities].reverse(), second.signal);
    await tick(); first.abort();
    await assert.rejects(a, {name:'AbortError'});
    release(); await b;
    assert.equal(calls, 1);
    assert.equal(store.peek(identities[0], 'v1').type, 'image');
    assert.equal(store.peek(identities[1], 'v1').type, 'folder');
    assert.equal(store.records.values.size, 2);
});

test('changing visible demand cancels obsolete batches and starts the new filter immediately', async () => {
    const requests = [];
    const store = new EntryStore((path, items, revision, signal) => new Promise(resolve => {
        requests.push({items, signal, finish:() => resolve(page(items))});
    }));
    const demand = new FactDemand(store, 'Album', 'v1', () => {});
    const old = item('old.jpg'), current = item('current.jpg');
    demand.update([old]); await tick();
    demand.update([current]); await tick();
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests.length, 2);
    requests[0].finish(); requests[1].finish(); await tick(); await tick();
    assert.equal(store.peek(old, 'v1'), undefined);
    assert.equal(demand.state(current).status, 'ready');
    demand.dispose();
});

test('a failed batch does not block a different filter and only failed items retry', async () => {
    let fail = true, calls = 0;
    const store = new EntryStore(async (path, items) => {
        calls++;
        if (fail) throw Object.assign(new Error('busy'), {retryable:true});
        return page(items);
    });
    const demand = new FactDemand(store, 'Album', 'v1', () => {});
    const a = item('a.jpg'), b = item('b.jpg');
    demand.update([a]); await tick(); await tick();
    assert.equal(demand.state(a).status, 'error');
    fail = false;
    demand.update([b]); await tick(); await tick();
    assert.equal(demand.state(b).status, 'ready');
    assert.equal(demand.errors.size, 0, 'A different filter does not retain errors from hidden items');
    demand.update([a, b]); demand.retry(); await tick(); await tick();
    assert.equal(demand.state(a).status, 'ready');
    assert.equal(calls, 3);
    demand.dispose();
});

test('fact batches obey both item and UTF-8 byte bounds and retained facts have a budget', async () => {
    const batches = [];
    const store = new EntryStore(async (path, items, revision) => {
        batches.push(new TextEncoder().encode(JSON.stringify({path, items, revision})).length);
        assert.ok(items.length <= 60);
        return page(items);
    });
    store.records.maxEntries = 80;
    const demand = new FactDemand(store, 'Album', 'v1', () => {});
    const items = Array.from({length:140}, (_, index) => item('😀'.repeat(1000) + index + '.jpg'));
    // A visible set must fit in retention; sustained browsing changes demand.
    for (let index = 0; index < items.length; index += 40) {
        demand.update(items.slice(index, index + 40));
        await tick(); await tick();
    }
    assert.ok(batches.every(bytes => bytes <= 120 * 1024));
    assert.ok(batches.length > 4, 'UTF-8 limits split a batch before its item limit');
    assert.ok(store.records.values.size <= 80);
    assert.equal(store.peek(items[0], 'v1'), undefined);
    demand.dispose();
});

test('selective refresh leaves unrelated pending facts and values alive', async () => {
    let release;
    const store = new EntryStore((path, items) => new Promise(resolve => { release = () => resolve(page(items)); }));
    const b = {path:'B/image.jpg', type:'image'};
    const pending = store.load('B', 'v1', [b], new AbortController().signal);
    await tick(); store.invalidate('Album'); release(); await pending;
    assert.equal(store.peek(b, 'v1').status, 'ready');
    assert.notEqual(entryKey(item('same', 'folder')), entryKey(item('same')));
});

test('Info publishing newer facts notifies visible demand without another scroll or request', async () => {
    const a = item('a.jpg');
    const store = new EntryStore(async () => ({entries:[{name:'a.jpg',type:'image',status:'ready',facts_revision:'old',modified:null}]}));
    let changed = 0;
    const demand = new FactDemand(store, 'Album', 'membership', () => { changed++; });
    demand.update([a]); await tick(); await tick();
    const before = changed;
    store.retain(a, 'membership', {status:'ready',facts_revision:'new',modified:{kind:'instant',value:'1970-01-01T00:00:01+00:00',key:'1000000000'}});
    await tick();
    assert.ok(changed > before);
    assert.equal(demand.state(a).modified.key, '1000000000');
    demand.dispose();
    assert.equal(store.listeners.size, 0);
});

test('stale invalidation notifies the view and does not turn cancellation into a retry failure', async () => {
    const store = new EntryStore(() => new Promise(() => {}));
    const a = item('a.jpg');
    const events = [];
    const demand = new FactDemand(store, 'Album', 'old-membership', event => events.push(event));
    demand.update([a]); await tick();
    store.invalidate('Album', {stale:true}); await tick();
    assert.ok(events.some(event => event?.scope === 'Album' && event.stale));
    assert.equal(demand.errors.size, 0);
    assert.equal(demand.disposed, true, 'An obsolete membership cannot start more fact requests');
    assert.equal(demand.loading, false);
    demand.dispose();
});

test('a stale folder notifies its view even without visible files', () => {
    const store = new EntryStore(() => assert.fail('An obsolete demand must not fetch facts'));
    let event;
    const demand = new FactDemand(store, 'Album', 'v1', change => { event = change; });
    store.invalidate('Album', {stale:true});
    assert.deepEqual(event, {scope:'Album', stale:true});
    assert.equal(demand.errors.size, 0);
    assert.equal(demand.disposed, true);
});

test('Info supersedes an older pending Browse fact without allowing late publication', async () => {
    let finish;
    const a = item('a.jpg');
    const store = new EntryStore(() => new Promise(resolve => { finish = resolve; }));
    const demand = new FactDemand(store, 'Album', 'membership', () => {});
    demand.update([a]); await tick();
    store.retain(a, 'membership', {status:'ready', facts_revision:'new', modified:{kind:'instant', key:'2'}});
    await tick();
    assert.equal(demand.state(a).facts_revision, 'new');
    finish({entries:[{name:'a.jpg', type:'image', status:'ready', facts_revision:'old', modified:{kind:'instant', key:'1'}}]});
    await tick(); await tick();
    assert.equal(demand.state(a).facts_revision, 'new');
    assert.equal(demand.errors.size, 0);
    demand.dispose();
});
