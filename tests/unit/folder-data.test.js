import assert from 'node:assert/strict';
import test from 'node:test';
import {FolderData} from '../../image_browser/web/static/data/folder-data.js';

test('entry pages retain complete records and reject cancelled responses', async () => {
    let release;
    const data = new FolderData({getFolder:(path, signal, ordering, page) => {
        assert.equal(path, 'Album');
        assert.deepEqual(page, {names:['page.jpg', 'missing.jpg'], revision:'version'});
        return new Promise(resolve => { release = resolve; });
    }});
    const directory = {path:'Album', key:'album', ordering:{}, entries:new Map(),
        listing:{revision:'version', folders:[], images:[], other_files:[]}, window:{paths:[]}};
    const controller = new AbortController();
    const items = [{path:'Album/page.jpg'}, {path:'Album/missing.jpg'}];
    let pending = data.loadEntries(directory, items, controller.signal);
    const entries = [{name:'page.jpg', type:'image', modified:'2024-03-14T12:30:00Z'},
        {name:'missing.jpg', type:'image', modified:null}];
    release({entries});
    await pending;
    assert.deepEqual(directory.entries.get('missing.jpg'), {...entries[1], path:'Album/missing.jpg'});
    await data.loadEntries(directory, items, controller.signal); // Already retained, including the unknown date.
    directory.entries.clear();
    pending = data.loadEntries(directory, items, controller.signal);
    controller.abort();
    release({entries});
    await assert.rejects(pending, {name:'AbortError'});
    assert.equal(directory.entries.size, 0);
    assert.equal(data.entriesLoading(directory), false);
});

test('Browse opens with a bounded entry page while Overview opens with a cheap name index', async () => {
    const requests = [];
    const data = new FolderData({getFolder:async (path, signal, ordering, page) => {
        requests.push(page);
        return {folders:[], images:['p1.jpg'], other_files:[],
            entries:page.limit ? [{name:'p1.jpg', type:'image', modified:null}] : []};
    }, seed:() => {}});
    const signal = new AbortController().signal;
    const browse = await data.open({folder:'Album'}, signal);
    assert.equal(browse.entries.get('p1.jpg').path, 'Album/p1.jpg');
    await data.open({folder:'Other', recursive:true}, signal);
    assert.deepEqual(requests, [{limit:60}, {}]);
});

test('an abandoned entry page cannot overwrite or clear a reopened request', async () => {
    const releases = [];
    const data = new FolderData({getFolder:() => new Promise(resolve => releases.push(resolve))});
    const directory = {path:'Album', key:'album', ordering:{}, entries:new Map(),
        listing:{folders:[], images:['page.jpg'], other_files:[]}, window:{paths:[]}};
    const items = [{path:'Album/page.jpg'}];
    const oldScope = new AbortController(), newScope = new AbortController();
    const oldRequest = data.loadEntries(directory, items, oldScope.signal);
    oldScope.abort();
    const newRequest = data.loadEntries(directory, items, newScope.signal);
    releases[0]({entries:[{name:'page.jpg', type:'image', modified:'old'}]});
    await assert.rejects(oldRequest, {name:'AbortError'});
    assert.equal(directory.entries.size, 0);
    assert.equal(data.entriesLoading(directory), true);
    releases[1]({entries:[{name:'page.jpg', type:'image', modified:null}]});
    await newRequest;
    assert.equal(directory.entries.get('page.jpg').modified, null);
    assert.equal(data.entriesLoading(directory), false);
});

test('sparse filtered pages and sustained browsing keep retained records bounded', async () => {
    const requests = [];
    const names = Array.from({length:2400}, (_, i) => `page${i}.jpg`);
    const data = new FolderData({getFolder:async (path, signal, ordering, page) => {
        requests.push(page);
        const selected = page.names || names.slice(0, page.limit);
        return {folders:[], images:names, other_files:[], revision:'v1',
            entries:selected.map(name => ({name, type:'image', modified:null}))};
    }, seed:() => {}});
    const signal = new AbortController().signal;
    const directory = await data.open({folder:'Album'}, signal);
    await data.loadEntries(directory, [{path:'Album/page2399.jpg'}, {path:'Album/page2300.jpg'}], signal);
    assert.deepEqual(requests[1].names, ['page2399.jpg', 'page2300.jpg']);
    assert.equal(directory.entries.size, 62);
    for (let index = 60; index < names.length; index += 60) {
        await data.loadEntries(directory, names.slice(index, index + 60).map(name => ({path:'Album/' + name})), signal);
        assert.ok(directory.entries.size <= 2000);
    }
    assert.equal(directory.entries.has('page0.jpg'), false);
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
