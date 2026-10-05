import assert from 'node:assert/strict';
import test from 'node:test';
import {ContinuousReader} from '../../image_browser/web/static/viewer/continuous-reader.js';

test('reader dimensions select the image when an archive also has a folder at that path', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const requests = [];
    globalThis.fetch = async url => {
        const query = new URL(url, 'http://localhost').searchParams;
        requests.push(query);
        const data = query.get('kind') === 'image' ? {kind:'image', width:40, height:60}
            : {kind:'directory', media:1};
        return {ok:true, status:200, json:async () => data};
    };
    const signal = new AbortController().signal;
    const item = {path:'collision.cbz/chapter.jpg', work:{signal}};
    let resized = 0;
    const reader = {point:() => null, resize:() => { resized++; }};
    await ContinuousReader.prototype.dimensions.call(reader, [item], {signal});
    assert.equal(requests[0].get('path'), item.path);
    assert.equal(requests[0].get('kind'), 'image');
    assert.deepEqual([item.width, item.height], [40, 60]);
    assert.equal(resized, 1);
});
