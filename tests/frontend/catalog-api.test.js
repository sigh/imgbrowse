import assert from 'node:assert/strict';
import test from 'node:test';
import {entries, getFolder, getMetadata} from '../../image_browser/web/static/data/api.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const response = (data, status = 200) => ({ok:status < 400, status, json:async () => data});

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
