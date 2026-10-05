import assert from 'node:assert/strict';
import {readState, stateUrl} from '../../../image_browser/web/static/shared/state.js';
import {mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export async function run(browser, fixtures) {
    const {call, evaluate, waitFor, open, click, newTab, key, nativeKey, screenshot, readyImage, pause, position, viewerUrl, presentation, setZoom, requests, network, held} = browser;
    const {fixtureRoot, first, second, last} = fixtures;
    await browser.start();
    // Reading links enter their presentation in the current folder.
    await open('/?folder=Album');
    await waitFor("document.querySelectorAll('.card').length === 2");
    const browseOverviewAction = await evaluate("document.getElementById('overview-folder').getBoundingClientRect().toJSON()");
    assert.equal((await newTab('[data-path="Album/Chapter 1"] .picture')).get('folder'), 'Album/Chapter 1');
    assert.equal((await newTab('#read-strip')).get('viewer'), '1');
    assert.equal((await newTab('#read-single')).get('view'), 'single');
    assert.equal((await newTab('#read-scroll')).get('view'), 'scroll');
    assert.equal((await newTab('#overview-folder', 'left', 4)).get('view'), 'grid');
    const folderOverview = await newTab('[data-path="Album/Chapter 1"] .folder-overview');
    assert.equal(folderOverview.get('folder'), 'Album/Chapter 1');
    assert.equal(folderOverview.get('collection'), null);
    assert.equal(folderOverview.get('view'), 'grid');
    await evaluate("document.querySelector('[data-path=\"Album/Chapter 1\"] .folder-overview').click()");
    await waitFor("!document.getElementById('overview').hidden && document.querySelectorAll('#overview .card').length === 2");
    assert.equal((await newTab('#overview .picture')).get('image'), 'page2.jpg');
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden");
    assert.equal(await evaluate("new URLSearchParams(location.search).get('folder')"), 'Album/Chapter 1', 'Browse keeps the child collection location');
    await open('/?folder=Album');
    await waitFor("document.querySelectorAll('.card').length === 2");
    const originalsBeforeOverview = requests.filter(url => new URL(url).pathname === '/image').length;
    assert.ok(await evaluate("document.getElementById('overview-folder').closest('.mode-navigation')"));
    await click('overview-folder');
    await waitFor("!document.getElementById('overview').hidden && document.querySelectorAll('#overview .card').length === 3");
    assert.ok(await evaluate("document.getElementById('viewer-image').hidden && document.activeElement === document.getElementById('grid-viewport')"));
    assert.equal(requests.filter(url => new URL(url).pathname === '/image').length, originalsBeforeOverview, 'Direct overview entry loads previews without loading an original');
    assert.deepEqual(await evaluate("document.getElementById('overview-folder').getBoundingClientRect().toJSON()"), browseOverviewAction, 'Overview has the same position in Browse and the viewer');
    assert.ok(await evaluate("document.getElementById('overview-folder').getAttribute('aria-current') === 'page' && document.querySelector('.viewer-tools').classList.contains('unavailable')"));
    const overviewEntry = await evaluate('({url:location.href,length:history.length})');
    await click('overview-folder');
    await key('t');
    assert.deepEqual(await evaluate('({url:location.href,length:history.length})'), overviewEntry, 'Current screen and presentation shortcuts do not leave Overview');
    await key('Tab');
    assert.ok(await evaluate("document.activeElement.closest('#viewer, .app-header') && document.activeElement.getClientRects().length"));
    await screenshot('overview-entry');
    await evaluate(`document.querySelector('#overview [data-path="${first}"] .picture').click()`);
    await readyImage(first);
    assert.equal(await evaluate("document.getElementById('overview-folder').getAttribute('aria-current')"), 'false');
    assert.ok(await evaluate("document.activeElement === document.getElementById('viewer-canvas')"));
    const viewEntry = await evaluate('({url:location.href,length:history.length})');
    await click('read-strip');
    assert.deepEqual(await evaluate('({url:location.href,length:history.length})'), viewEntry, 'The selected View button does nothing');
    await presentation('single');
    assert.equal(await evaluate('history.length'), viewEntry.length, 'The thumbnail toggle changes presentation without a navigation entry');
    assert.ok(await evaluate("document.getElementById('read-single').getAttribute('aria-current') === 'page' && document.getElementById('overview').hidden"));
    await setZoom(150);
    assert.equal(await evaluate("sessionStorage.getItem('readingLayout')"), 'single');
    assert.equal(await evaluate("sessionStorage.getItem('readingSize')"), '1.5');
    await click('overview-folder');
    await waitFor("!document.getElementById('overview').hidden");
    await call('Page.reload');
    await waitFor("!document.getElementById('overview')?.hidden && document.querySelectorAll('#overview .card').length === 3");
    await click('read-single');
    await readyImage(first);
    assert.equal(await evaluate("new URLSearchParams(location.search).get('view')"), 'single', 'Reloading overview retains its underlying reading layout');
    assert.equal(await evaluate("(new URLSearchParams(location.search).get('size') || 'auto')"), '1.5');
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden");
    await call('Page.reload');
    await waitFor("document.querySelectorAll('.card').length === 2 && document.getElementById('viewer').hidden");
    await click('read-single');
    await readyImage(first);
    assert.equal(await evaluate("new URLSearchParams(location.search).get('view')"), 'single', 'Entering from Browse reuses the session reading layout');
    assert.equal(await evaluate("(new URLSearchParams(location.search).get('size') || 'auto')"), '1.5');
    await open(viewerUrl(second));
    await readyImage(second);
    assert.ok(await evaluate("!document.getElementById('viewer-strip').hidden && (new URLSearchParams(location.search).get('size') || 'auto') === 'auto'"), 'Viewer URLs override session defaults');
    assert.equal(await evaluate("sessionStorage.getItem('readingLayout')"), 'single', 'Opening a viewer URL does not rewrite preferences');
    await click('overview-folder');
    await waitFor("!document.getElementById('overview').hidden");
    await click('read-strip');
    await readyImage(second);
    assert.ok(await evaluate("!document.getElementById('viewer-strip').hidden"), 'Overview returns to the actual bookmarked reading layout');
    await open('/?folder=Single');
    await waitFor("document.querySelector('[data-path=\"Single/only.jpg\"]')");
    await evaluate("document.querySelector('[data-path=\"Single/only.jpg\"] .picture').click()");
    await readyImage('Single/only.jpg');
    assert.ok(await evaluate("!document.getElementById('viewer-strip').hidden && (new URLSearchParams(location.search).get('size') || 'auto') === '1.5'"), 'Opening another folder uses the latest chosen presentation');
    // Restore defaults through the real controls for the rest of the smoke scenarios.
    await presentation('strip');
    await key('f');

    // Media links retain input entered just before the filter debounce fires.
    await open('/?folder=Single');
    await waitFor("document.querySelector('[data-path=\"Single/only.jpg\"] .picture')");
    await evaluate("{ const input=document.getElementById('filter'); input.value='only'; input.dispatchEvent(new Event('input')); document.querySelector('[data-path=\"Single/only.jpg\"] .picture').click(); }");
    await readyImage('Single/only.jpg');
    assert.equal(await evaluate("new URLSearchParams(location.search).get('filter')"), 'only');
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden && document.getElementById('filter').value === 'only'");

    // A mode switch retains the same folder's filter, scroll and focus after reload.
    // Back/Forward visits the adjacent screen entries without skipping history.
    await open('/?folder=Album');
    await waitFor("document.querySelectorAll('.card').length === 2");
    await evaluate("document.querySelector('#item-path a').click()");
    await waitFor("!new URLSearchParams(location.search).has('folder') && document.querySelectorAll('.card').length > 5");
    await click('layout-list');
    await evaluate("{const input=document.getElementById('filter'); input.value='root1'; input.dispatchEvent(new Event('input'));}");
    await waitFor("new URLSearchParams(location.search).get('filter') === 'root1'");
    await evaluate("document.getElementById('grid-viewport').scrollTop=650");
    await pause(160);
    const browseContext = await evaluate(`(() => {
        const viewport=document.getElementById('grid-viewport');
        const opener=[...document.querySelectorAll('.list-name')].find(node => node.getBoundingClientRect().top >= viewport.getBoundingClientRect().top);
        window.browseOpener=opener;
        return {url:location.search, position:history.state.position, scroll:viewport.scrollTop, path:opener.closest('.card').dataset.path};
    })()`);
    await evaluate('browseOpener.focus(); browseOpener.click()');
    await readyImage(browseContext.path);
    await click('overview-folder');
    await waitFor("!document.getElementById('overview').hidden");
    await click('read-strip');
    await readyImage(browseContext.path);
    await call('Page.reload');
    await readyImage(browseContext.path);
    const historyBeforeReturn = await evaluate('history.length');
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/folder*'}]});
    network.folders = true;
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden && document.getElementById('grid-viewport').getAttribute('aria-busy') === 'true' && document.activeElement.id === 'grid-viewport'");
    network.folders = false;
    for (const requestId of held.splice(0)) await call('Fetch.continueRequest', {requestId}).catch(() => {});
    await call('Fetch.disable');
    await waitFor(`document.getElementById('viewer').hidden && document.activeElement.closest('.card')?.dataset.path === ${JSON.stringify(browseContext.path)}`);
    assert.equal(await evaluate('location.search'), browseContext.url);
    assert.equal(await evaluate('history.length'), historyBeforeReturn + 1, 'Browse is an ordinary screen navigation entry');
    assert.deepEqual(await evaluate('history.state.position'), browseContext.position);
    assert.ok(Math.abs(await evaluate("document.getElementById('grid-viewport').scrollTop") - browseContext.scroll) < 2);
    assert.ok(await evaluate("document.activeElement.matches('.list-name') && document.getElementById('filter').value === 'root1'"));
    await screenshot('browse-restored');
    await evaluate('history.back()');
    await readyImage(browseContext.path);
    await evaluate('history.forward()');
    await waitFor("document.getElementById('viewer').hidden && new URLSearchParams(location.search).get('filter') === 'root1'");
    await evaluate('history.back()');
    await readyImage(browseContext.path);
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden && new URLSearchParams(location.search).get('filter') === 'root1'");

    // Traversing beyond the opening filter must not widen Browse on return.
    await open('/?folder=Album&compact=1');
    await waitFor("document.querySelectorAll('.list-item').length === 2");
    await evaluate("{const input=document.getElementById('filter'); input.value='Chapter 1'; input.dispatchEvent(new Event('input')); document.getElementById('read-strip').focus(); document.getElementById('read-strip').click();}");
    await readyImage(first);
    await click('viewer-next');
    await readyImage(second);
    await click('viewer-next');
    await readyImage(last);
    await key('Escape');
    await waitFor("document.getElementById('viewer').hidden && document.activeElement.id === 'read-strip'");
    assert.equal(await evaluate('location.search'), '?folder=Album&compact=1&filter=Chapter+1', 'Opening before filter debounce retains the entered text');
    assert.equal(await evaluate("document.getElementById('filter').value"), 'Chapter 1');
    assert.equal(await evaluate("document.querySelectorAll('.list-item').length"), 1);

    // A bookmarked viewer switches modes using the same navigation rule.
    await open(viewerUrl(last));
    await readyImage(last);
    const directHistory = await evaluate('history.length');
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden && location.search === '?folder=Album'");
    assert.equal(await evaluate('history.length'), directHistory + 1);
    assert.equal(await evaluate("document.activeElement.id"), 'grid-viewport');

    // Same-folder mode switches retain the most recently selected media.
    await open('/');
    await open('/?folder=Album');
    await waitFor("document.querySelectorAll('.card').length === 2");
    const pathStyle = await evaluate("(() => {const style=getComputedStyle(document.getElementById('item-path')); return [style.fontSize, style.lineHeight, style.gap, style.color];})()");
    await click('read-strip');
    await readyImage(first);
    assert.deepEqual(await evaluate("(() => {const style=getComputedStyle(document.getElementById('item-path')); return [style.fontSize, style.lineHeight, style.gap, style.color];})()"), pathStyle, 'Path typography stays consistent between Browse and View');
    assert.ok(await evaluate("!document.getElementById('refresh') && !document.getElementById('viewer-refresh')"));
    await click('viewer-next');
    await readyImage(second);
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden");
    await waitFor("document.activeElement.id === 'read-strip'");
    await click('read-strip');
    await readyImage(second);
    assert.ok(await evaluate("(() => { const image = document.getElementById('viewer-image'); return !image.hidden && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0; })()"), 'Reopening a cached image must display decoded pixels');
    await evaluate('history.back()');
    await waitFor("document.getElementById('viewer').hidden");
    await open('/?folder=Album&view=grid');
    await waitFor("document.querySelectorAll('.folder-heading a').length === 2");
    await evaluate("document.querySelector('.folder-heading a').click()");
    await waitFor("new URLSearchParams(location.search).get('folder') === 'Album/Chapter 1'");
    assert.ok(await evaluate("document.getElementById('viewer').hidden"));

    // A folder's View action establishes the same scope for both modes.
    const beforeCovers = requests.length;
    await open('/?folder=Album');
    await waitFor("document.querySelectorAll('.folder-card .picture img').length === 2");
    const covers = requests.slice(beforeCovers).filter(url => new URL(url).pathname === '/thumbnail');
    assert.deepEqual(covers.map(url => new URL(url).searchParams.get('path')).sort(), ['Album/Chapter 1', 'Album/Chapter 2']);
    await open('/?folder=Album&compact=1');
    await waitFor("document.querySelector('.folder-view')");
    await evaluate("document.querySelector('.folder-view').click()");
    await readyImage(first);
    assert.equal(await evaluate("new URLSearchParams(location.search).get('folder')"), 'Album/Chapter 1');
    assert.equal(await evaluate("new URLSearchParams(location.search).get('collection')"), null);
    await click('viewer-next');
    await readyImage(second);
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden && document.querySelectorAll('.list-item').length === 2");
    assert.equal(await evaluate('location.search'), '?folder=Album%2FChapter+1&compact=1', 'Child View and Browse use the same folder');
    await call('Page.reload');
    await waitFor("document.querySelector('.list-name')");
    await click('read-strip');
    await readyImage(second);
    await evaluate("document.querySelector('#item-path a').click()");
    await waitFor("document.getElementById('viewer').hidden");
    assert.equal(await evaluate('history.state.selection'), null);

    // Recursive paging and Back reuse discovered items without rebuilding the traversal.
    await open('/?view=grid');
    await waitFor("document.getElementById('folder-summary').textContent.includes('60 items')");
    assert.ok(await evaluate("document.activeElement.id === 'grid-viewport' && !document.getElementById('overview-folder').matches(':focus-visible')"), 'Opening Overview focuses its contents without outlining the selected navigation button');
    await screenshot('overview-new-page');
    await nativeKey('Tab', 9);
    assert.ok(await evaluate("document.activeElement.matches('a[href]:focus-visible, button:focus-visible') && getComputedStyle(document.activeElement).outlineStyle === 'solid'"), 'Keyboard navigation retains a visible focus outline');
    for (let page=0; page<5; page++) {
        await evaluate("document.getElementById('grid-viewport').scrollTop = document.getElementById('grid-viewport').scrollHeight");
        await pause(100);
    }
    await waitFor("document.getElementById('folder-summary').textContent === '173 items'");
    await evaluate("document.getElementById('grid-viewport').scrollTop = 1800");
    await pause(160);
    const recursiveAnchor = await evaluate('history.state.overviewPosition.path');
    await evaluate("document.querySelector('#grid .picture').click()");
    await waitFor("!document.getElementById('viewer-stage').hidden");
    await evaluate('history.back()');
    await waitFor("!document.getElementById('overview').hidden");
    assert.equal(await evaluate('history.state.overviewPosition.path'), recursiveAnchor);

    // Files can disappear while reading. Return uses distance in the original
    // filtered order, preferring the following item when both sides are equally near.
    const returnImage = readFileSync(join(fixtureRoot, 'root2.jpg'));
    for (const scenario of [
        {name: 'next', removed: [0], expected: 1},
        {name: 'previous', removed: [0, 1], expected: -1},
        {name: 'second-next', removed: [0, 1, -1], expected: 2},
        {name: 'rename', removed: [0], expected: 1, rename: true},
        {name: 'preview-next', removed: [0], expected: 1, previews: true},
        {name: 'resize', removed: [], expected: 0, previews: true, narrow: true},
        {name: 'no-neighbors', removed: Array.from({length:17}, (_, index) => index - 8), expected: null},
    ]) {
        const folder = 'Return ' + scenario.name;
        const directory = join(fixtureRoot, folder);
        mkdirSync(directory);
        const names = Array.from({length:60}, (_, index) => 'page' + String(index).padStart(2, '0') + '.jpg');
        for (const name of [...names, 'excluded.jpg']) writeFileSync(join(directory, name), returnImage);
        await open(stateUrl({...readState(''), folder, filter:'page', compact:!scenario.previews}));
        await waitFor("document.getElementById('folder-summary').textContent.includes('60 matches')");
        await evaluate(`import('/gallery.js').then(({app}) => {
            const row = app.grid.layout.byPath.get('item:' + JSON.stringify([${JSON.stringify(folder + '/page20.jpg')}, 'image']));
            app.grid.viewport.scrollTop = row.top + 11;
        })`);
        await pause(160);
        const context = await evaluate(`import('/gallery.js').then(({app}) => ({
            position: app.grid.position(), items: app.grid.items.map(item => item.path),
            url: location.search, header: document.querySelector('.app-header').offsetHeight,
        }))`);
        const anchorIndex = context.items.indexOf(context.position.path);
        assert.deepEqual(context.position.neighbors.slice(0, 4).map(item => item.path), [1,-1,2,-2].map(offset => context.items[anchorIndex + offset]));
        assert.equal(context.position.neighbors.length, 16, 'Return metadata stores a bounded neighborhood');
        if (scenario.name === 'next') await screenshot('return-before-deletion');
        if (scenario.name === 'preview-next') await screenshot('return-previews-before-deletion');
        await evaluate(`{
            const card = [...document.querySelectorAll('#grid .card')].find(node => node.dataset.path === ${JSON.stringify(context.position.path)});
            const opener = card.querySelector('.list-name, .picture');
            opener.focus({preventScroll:true}); opener.click();
        }`);
        await readyImage(context.position.path);
        for (const offset of scenario.removed) {
            const file = join(directory, context.items[anchorIndex + offset].split('/').pop());
            if (scenario.rename) renameSync(file, join(directory, 'page99-renamed.jpg'));
            else unlinkSync(file);
        }
        if (scenario.narrow) await call('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
        // Reload drops the client listing and refreshes the server snapshot while
        // retaining the opening Browse history entry and its original neighbors.
        await call('Page.reload');
        if (scenario.removed.length) await waitFor("!document.getElementById('viewer')?.hidden && !document.getElementById('viewer-retry')?.hidden");
        else await readyImage(context.position.path);
        await click('browse-folder');
        await waitFor("document.getElementById('viewer').hidden && document.querySelector('#grid .card') && document.getElementById('grid-viewport').getAttribute('aria-busy') === 'false'");
        await pause(160);
        const restored = await evaluate(`import('/gallery.js').then(({app}) => ({
            position: app.grid.position(), url: location.search, scroll: app.grid.viewport.scrollTop,
            focus: document.activeElement.id || document.activeElement.closest('.card')?.dataset.path,
            filtered: app.grid.items.every(item => item.path.split('/').pop().startsWith('page')),
            header: document.querySelector('.app-header').offsetHeight,
        }))`);
        assert.equal(restored.url, context.url, 'Return keeps the opening folder, filter and layout');
        assert.ok(restored.filtered);
        if (scenario.expected === null) assert.equal(restored.scroll, 0, 'No surviving saved anchors falls back to the start');
        else assert.equal(restored.position.path, context.items[anchorIndex + scenario.expected], scenario.name);
        if (scenario.removed.length) assert.equal(restored.focus, 'grid-viewport', 'A deleted opener returns focus to folder contents');
        if (!scenario.narrow) assert.equal(restored.header, context.header);
        if (scenario.name === 'next') await screenshot('return-after-deletion');
        if (scenario.name === 'preview-next') await screenshot('return-previews-after-deletion');
        if (scenario.name === 'previous') await screenshot('return-after-two-deletions');
        if (scenario.narrow) {
            assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
            await screenshot('return-after-resize');
            await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
        }
    }

}
