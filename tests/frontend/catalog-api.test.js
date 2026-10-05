import assert from 'node:assert/strict';
import test from 'node:test';
import {createApi, entries, getFolder, getMetadata} from '../../image_browser/web/static/data/api.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const response = (data, status = 200) => ({ok:status < 400, status, json:async () => data});

test('an immediately ready order needs one request and no temporary listing', async () => {
    const calls = [];
    const api = createApi(async url => {
        calls.push(url);
        return response({revision:'v1', view_revision:'size-v1', items:[{name:'a.jpg', type:'image', sort_key:'10'}]});
    });
    const listing = await api.getFolder('Ready', undefined, {sort:'size'}, () => assert.fail('Ready orders need no preview'));
    assert.deepEqual(listing.images, ['a.jpg']);
    assert.deepEqual(calls, ['/api/folder?path=Ready&sort=size&order=asc']);
    await api.getFolder('Ready', undefined, {sort:'size'});
    assert.equal(calls.length, 1);
});

test('preparation supplies one preview that late consumers share without another request', async () => {
    const listing = {revision:'v1', view_revision:'natural-v1', items:[{name:'a.jpg', type:'image'}]};
    let calls = 0;
    const api = createApi(async url => {
        if (url === '/api/order/cancel') return response({status:'cancelled'});
        assert.match(url, /sort=size/);
        if (++calls === 1) return response({status:'preparing', token:'lease', completed:0, total:2, listing}, 202);
        if (calls === 2) return response({status:'preparing', token:'lease', completed:1, total:2}, 202);
        return response({...listing, view_revision:'size-v1'});
    });
    const firstUpdates = [], secondUpdates = [];
    const first = api.getFolder('Preparing', undefined, {sort:'size'}, (listing, preparation) => firstUpdates.push({listing, preparation}));
    await tick();
    const second = api.getFolder('Preparing', undefined, {sort:'size'}, (listing, preparation) => secondUpdates.push({listing, preparation}));
    assert.deepEqual(secondUpdates[0].listing.images, ['a.jpg'], 'Late consumers receive the retained preview immediately');
    await Promise.all([first, second]);
    for (const updates of [firstUpdates, secondUpdates]) {
        assert.equal(updates.filter(update => update.listing).length, 1);
        assert.equal(updates[1].listing, null);
        assert.equal(updates[1].preparation.completed, 1);
    }
    assert.equal(calls, 3, 'Consumers share the preparation and its polls');
});

test('one cancelled consumer cannot interrupt another consumers preparation progress', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const listing = {revision:'v1', view_revision:'order-v1', items:[{name:'a.jpg',type:'image'}], natural_folders:[]};
    let release, modified = 0;
    globalThis.fetch = async url => {
        if (url.includes('/api/order/cancel')) return response({status:'cancelled'});
        if (!url.includes('sort=modified')) return response(listing);
        if (++modified === 1) return new Promise(resolve => { release = () => resolve(response({status:'preparing', token:'lease', completed:1, total:2}, 202)); });
        return response(listing);
    };
    const a = new AbortController(), b = new AbortController(), updates = [];
    const first = getFolder('Progress', a.signal, {sort:'modified'}, () => a.signal.throwIfAborted());
    const second = getFolder('Progress', b.signal, {sort:'modified'}, (listing, progress) => updates.push(progress));
    await tick(); a.abort(); await assert.rejects(first, {name:'AbortError'});
    release();
    assert.equal((await second).images[0], 'a.jpg');
    assert.ok(updates.some(progress => progress?.completed === 1));
    assert.equal(modified, 2);
});

test('a replacement request cannot inherit an abandoned preparations preview', async () => {
    const listing = {revision:'old', view_revision:'old', items:[{name:'old.jpg', type:'image'}]};
    let calls = 0;
    const api = createApi(async url => {
        if (url === '/api/order/cancel') return response({status:'cancelled'});
        if (++calls === 1) return response({status:'preparing', token:'old', listing}, 202);
        return response({revision:'new', view_revision:'new', items:[{name:'new.jpg', type:'image'}]});
    });
    const controller = new AbortController();
    const old = api.getFolder('Replacement', controller.signal, {sort:'size'});
    await tick();
    const cancelled = assert.rejects(old, {name:'AbortError'});
    controller.abort();
    const current = await api.getFolder('Replacement', undefined, {sort:'size'}, () => assert.fail('An abandoned preview must not be replayed'));
    await cancelled;
    assert.deepEqual(current.images, ['new.jpg']);
    assert.equal(api.entries.revisions.get('Replacement'), 'new');
});

test('an obsolete image metadata response cannot publish facts into the shared store', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    entries.register('Obsolete', 'membership');
    let release;
    globalThis.fetch = async () => new Promise(resolve => { release = () => resolve(response({kind:'image', modified:null})); });
    const controller = new AbortController();
    const pending = getMetadata('Obsolete/a.jpg', controller.signal);
    controller.abort(); release();
    await assert.rejects(pending, {name:'AbortError'});
    assert.equal(entries.peek({path:'Obsolete/a.jpg',type:'image'}, 'membership'), undefined);
});

test('unexpected non-JSON errors retain HTTP status and a useful retry message', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async () => ({ok:false, status:414, json:async () => { throw new SyntaxError('HTML'); }});
    await assert.rejects(getFolder('InvalidResponse'), error => error.status === 414 && error.retryable
        && error.message === 'Server returned an invalid response');
});
