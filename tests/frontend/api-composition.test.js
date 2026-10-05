import assert from 'node:assert/strict';
import test from 'node:test';
import {createApi} from '../../image_browser/web/static/data/api.js';
import {createTransport} from '../../image_browser/web/static/data/http.js';

const response = (data, status = 200) => ({ok:status < 400, status, json:async () => data});

test('independent application clients do not share cached facts or refresh lifetimes', async () => {
    let firstCalls = 0, secondCalls = 0;
    const listing = name => ({revision:name, view_revision:name, items:[{name:name + '.jpg', type:'image'}]});
    const first = createApi(async url => {
        firstCalls++;
        return response(url === '/api/refresh' ? {scope:'Album'} : listing('first'));
    });
    const second = createApi(async () => { secondCalls++; return response(listing('second')); });
    assert.deepEqual((await first.getFolder('Album')).images, ['first.jpg']);
    assert.deepEqual((await second.getFolder('Album')).images, ['second.jpg']);
    await first.refreshScope('Album');
    await first.getFolder('Album'); await second.getFolder('Album');
    assert.equal(firstCalls, 3);
    assert.equal(secondCalls, 1);
    assert.equal(second.entries.revisions.get('Album'), 'second');
});

test('HTTP transport surfaces stale conflicts without depending on application stores', async () => {
    const transport = createTransport(async () => response({error:'Changed', code:'stale_view', retryable:false}, 409));
    await assert.rejects(transport.request('/api/folder?path=Album'),
        error => error.status === 409 && error.code === 'stale_view' && !error.retryable);
});
