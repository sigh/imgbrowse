import assert from 'node:assert/strict';
import test from 'node:test';
import {FolderData} from '../../image_browser/web/static/data/folder-data.js';

test('Browse and Overview open a cheap membership index without fetching facts', async () => {
    const requests = [];
    const data = new FolderData({getFolder:async (path, signal, ordering, progress) => {
        requests.push({path, ordering, progress:typeof progress});
        return {folders:[], images:['p1.jpg'], other_files:[], revision:'v1'};
    }, seed:() => {}});
    const signal = new AbortController().signal;
    const browse = await data.open({folder:'Album'}, signal);
    assert.equal(browse.listing.images[0], 'p1.jpg');
    assert.equal(browse.entries, undefined);
    await data.open({folder:'Other', recursive:true}, signal);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.progress === 'function'));
});

test('retained discoveries are isolated by ordering and refresh replaces their window', async () => {
    let listings = 0;
    const data = new FolderData({
        getFolder:async () => { listings++; return {folders:[], images:['p1.jpg'], other_files:[]}; },
        walkImages:async () => ({images:['Album/p1.jpg'], cursor:null, warnings:[]}),
        seed:() => {},
    });
    const signal = new AbortController().signal;
    const state = {folder:'Album'};
    const first = await data.open(state, signal);
    await data.load(first, false, signal);
    assert.equal(await data.open(state, signal), first);
    assert.deepEqual(first.window.paths, ['Album/p1.jpg']);
    const descending = await data.open({...state, order:'desc'}, signal);
    assert.notEqual(descending, first);
    assert.deepEqual(descending.window.paths, []);
    assert.notEqual(await data.open(state, signal, true), first);
    assert.equal(listings, 3);
});

test('revealing an undiscovered image starts adjacent discovery rather than scanning from the root', async () => {
    const requests = [];
    const data = new FolderData({
        getFolder:async () => ({folders:[], images:[], other_files:[]}),
        walkImages:async options => {
            requests.push(options);
            return {images:options.reverse ? ['Album/p499.jpg'] : ['Album/p501.jpg'], cursor:null, warnings:[]};
        },
        seed:() => {},
    });
    const signal = new AbortController().signal;
    const directory = await data.open({folder:'Album', sort:'modified', order:'desc'}, signal);
    data.reveal(directory, 'Album/p500.jpg');
    await data.load(directory, true, signal);
    await data.load(directory, false, signal);
    assert.deepEqual(directory.window.paths, ['Album/p499.jpg', 'Album/p500.jpg', 'Album/p501.jpg']);
    assert.equal(directory.window.windowed, true);
    assert.ok(requests.every(request => request.anchor === 'Album/p500.jpg' && request.sort === 'modified' && request.order === 'desc'));
});

test('a cancelled folder response cannot enter retained data', async () => {
    let release;
    const data = new FolderData({
        getFolder:() => new Promise(resolve => { release = resolve; }),
        walkImages:() => assert.fail('Discovery should not start'),
        seed:() => assert.fail('Obsolete listing should not seed navigation'),
    });
    const controller = new AbortController();
    const pending = data.open({folder:'Album'}, controller.signal);
    controller.abort();
    release({folders:[], images:[], other_files:[]});
    await assert.rejects(pending, {name:'AbortError'});
    assert.equal(data.cache.size, 0);
});
