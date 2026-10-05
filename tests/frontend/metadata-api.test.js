import assert from 'node:assert/strict';
import test from 'node:test';
import {getMetadata} from '../../image_browser/web/static/data/api.js';
import {MetadataKind} from '../../image_browser/web/static/shared/media-kind.js';

const response = data => ({ok:true, json:async () => data});

test('basic video facts arrive before a delayed probe, followed by complete facts', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    let release, requested;
    const videoStarted = new Promise(resolve => { requested = resolve; });
    const basic = {kind:MetadataKind.VIDEO, root_path:'/photos', size:123};
    globalThis.fetch = async url => {
        if (url.startsWith('/api/metadata?')) return response(basic);
        requested();
        return new Promise(resolve => { release = () => resolve(response({width:640, height:480, duration:61})); });
    };
    const updates = [];
    const pending = getMetadata('delayed.webm', undefined, {onBasic:data => updates.push(data)});
    await videoStarted;
    assert.deepEqual(updates, [{...basic, video_pending:true}]);
    release();
    assert.deepEqual(await pending, {...basic, width:640, height:480, duration:61});
});

test('failed video enrichment preserves basic facts and retries the failed request', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    let probes = 0;
    const basic = {kind:MetadataKind.VIDEO, size:123};
    globalThis.fetch = async url => {
        if (url.startsWith('/api/metadata?')) return response(basic);
        if (++probes === 1) throw new Error('Offline');
        return response({width:320, height:240, duration:2});
    };
    assert.deepEqual(await getMetadata('retry.webm'), {...basic, video_error:true});
    assert.deepEqual(await getMetadata('retry.webm'), {...basic, width:320, height:240, duration:2});
    assert.equal(probes, 2);
});

test('an obsolete metadata response cannot publish basic facts or start a video probe', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const controller = new AbortController();
    let release, calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return new Promise(resolve => { release = () => resolve(response({kind:MetadataKind.VIDEO})); });
    };
    const pending = getMetadata('obsolete.webm', controller.signal, {onBasic:() => assert.fail('Obsolete facts published')});
    controller.abort();
    release();
    await assert.rejects(pending, {name:'AbortError'});
    assert.equal(calls, 1);
});
