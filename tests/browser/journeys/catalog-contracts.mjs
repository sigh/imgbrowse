import {mkdirSync, readFileSync, utimesSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ReadingLayout} from '../../../image_browser/web/static/shared/state.js';
import assert from 'node:assert/strict';

export async function run(browser, fixtures) {
    const {call, open, evaluate, waitFor, network, held} = browser;
    const gridGeometry = () => evaluate("({viewport:document.getElementById('grid-viewport').getBoundingClientRect().toJSON(),gridTop:document.getElementById('grid').getBoundingClientRect().top,scrollTop:document.getElementById('grid-viewport').scrollTop,footer:document.getElementById('summary').getBoundingClientRect().toJSON()})");
    const retryVisible = () => evaluate("(() => { const button=document.getElementById('load-more'), action=button.getBoundingClientRect(), message=document.getElementById('folder-feedback').getBoundingClientRect(), grid=document.getElementById('grid-viewport').getBoundingClientRect(); return !button.hidden && action.top>=grid.bottom && action.bottom<=innerHeight && action.left>=message.right && action.right<=innerWidth && message.height>0; })()");
    await browser.start();
    network.entries = true;
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/folder/entries'}]});
    await open('/?compact=1');
    await waitFor("document.querySelector('.card[data-path=\"root0.jpg\"] .list-name')");
    assert.equal(await evaluate("document.querySelector('.card[data-path=\"root0.jpg\"] .item-modified').hasAttribute('datetime')"), false);
    assert.equal(await evaluate("document.querySelector('.card[data-path=\"root0.jpg\"] .item-modified').textContent"), '…');
    assert.equal(await evaluate("document.querySelector('.card[data-path=\"root0.jpg\"] .item-size').textContent"), '…');
    assert.ok(await evaluate("document.querySelector('.card[data-path=\"root0.jpg\"] .list-name').href.includes('root0.jpg')"));
    await waitFor("import('/gallery.js').then(({app}) => app.grid.facts.loading)");
    assert.equal(await evaluate("document.getElementById('grid-status').textContent"), '',
        'Background detail requests do not insert a loading banner above the rows');
    assert.ok(held.length);
    const initialGeometry = await gridGeometry();
    for (const requestId of held.splice(0)) await call('Fetch.fulfillRequest', {requestId, responseCode:503,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({error:'Storage busy', code:'storage_busy', retryable:true})).toString('base64')});
    await waitFor("document.getElementById('folder-feedback').textContent.includes('Some file details')");
    assert.deepEqual(await gridGeometry(), initialGeometry, 'Detail errors leave grid geometry and scrolling unchanged');
    assert.ok(await evaluate("document.getElementById('grid').clientHeight > document.getElementById('grid-viewport').clientHeight * 3"));
    assert.ok(await retryVisible(), 'Retry is visible beside the message even with a long listing');
    await browser.click('load-more');
    await waitFor("import('/gallery.js').then(({app}) => app.grid.facts.loading)");
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    assert.ok(held.length, 'Retry starts a new detail request');
    assert.deepEqual(await gridGeometry(), initialGeometry, 'Retry does not resize or scroll the grid');
    assert.equal(await evaluate("document.activeElement.id"), 'grid-viewport', 'Hiding Retry leaves keyboard focus in the grid');
    const old = held.splice(0);
    await evaluate("{const input=document.getElementById('filter'); input.value='root159'; input.dispatchEvent(new Event('input'));}");
    await waitFor("document.querySelector('.card[data-path=\"root159.jpg\"] .list-name')");
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    assert.ok(held.length, 'New visible demand starts while an obsolete batch is held');
    await call('Emulation.setDeviceMetricsOverride', {width:320,height:844,deviceScaleFactor:1,mobile:true});
    await waitFor("import('/gallery.js').then(({app}) => app.grid.layout.width === app.grid.viewport.clientWidth && app.grid.viewport.clientWidth <= 320)");
    const narrowGeometry = await gridGeometry();
    for (const requestId of held.splice(0)) await call('Fetch.fulfillRequest', {requestId, responseCode:503,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({error:'Storage busy', code:'storage_busy', retryable:true})).toString('base64')});
    await waitFor("document.getElementById('folder-feedback').textContent.includes('Some file details')");
    assert.deepEqual(await gridGeometry(), narrowGeometry, 'Wrapped feedback does not change the narrow viewport geometry');
    assert.ok(await retryVisible(), 'Feedback and Retry fit within a narrow screen');
    assert.equal(await evaluate("document.querySelector('.card[data-path=\"root159.jpg\"] .item-size').textContent"), '—');
    assert.equal(await evaluate("document.querySelector('.card[data-path=\"root159.jpg\"] .item-size').title"), 'Storage busy');
    assert.equal(await evaluate("document.querySelector('.card[data-path=\"root159.jpg\"] .item-modified').title"), 'Storage busy');
    assert.ok(await evaluate("document.querySelector('.card[data-path=\"root159.jpg\"] .list-name').href"));
    await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate("{const input=document.getElementById('filter'); input.value='root158'; input.dispatchEvent(new Event('input'));}");
    await waitFor("document.querySelector('.card[data-path=\"root158.jpg\"]')");
    assert.equal(await evaluate("document.getElementById('folder-feedback').textContent.includes('Some file details')"), false,
        'A new filter clears errors belonging to hidden items');
    await evaluate("window.dateCard = document.querySelector('.card[data-path=\"root158.jpg\"]'); window.dateLink = dateCard.querySelector('.list-name'); dateLink.focus();");
    const pendingPosition = await evaluate("({top:dateCard.getBoundingClientRect().top, height:dateCard.getBoundingClientRect().height, scrollTop:document.getElementById('grid-viewport').scrollTop})");
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    network.entries = false;
    for (const requestId of [...old, ...held.splice(0)]) await call('Fetch.continueRequest', {requestId}).catch(() => {});
    await call('Fetch.disable');
    await waitFor("document.querySelector('.card[data-path=\"root158.jpg\"] .item-modified[datetime]')");
    assert.ok(await evaluate("document.querySelector('.card[data-path=\"root158.jpg\"] .item-size').title.endsWith(' bytes')"));
    assert.equal(await evaluate("document.querySelector('.card[data-path=\"root158.jpg\"]') === dateCard && document.activeElement === dateLink"), true,
        'File details update without replacing the card or losing keyboard focus');
    assert.deepEqual(await evaluate("({top:dateCard.getBoundingClientRect().top, height:dateCard.getBoundingClientRect().height, scrollTop:document.getElementById('grid-viewport').scrollTop})"), pendingPosition,
        'Completing background details does not move the row or scroll position');

    await browser.start();
    const preparationListing = await evaluate("fetch('/api/folder').then(response => response.json())");
    network.order = true;
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/folder*'}]});
    await open('/?compact=1&filter=root12&sort=modified');
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    assert.ok(held.length);
    await call('Fetch.fulfillRequest', {requestId:held.shift(), responseCode:202,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({status:'preparing', token:'fixture-progress', completed:7, total:160, listing:preparationListing})).toString('base64')});
    await waitFor("document.querySelector('.card[data-path=\"root120.jpg\"]') && document.getElementById('folder-feedback').textContent.includes('Preparing order')");
    assert.ok(await evaluate("document.querySelector('.card .list-name').href"), 'Browse stays usable during preparation');
    await waitFor("document.getElementById('folder-feedback').textContent.includes('7 / 160')");
    const preparingGeometry = await gridGeometry();
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    assert.ok(held.length);
    await call('Fetch.fulfillRequest', {requestId:held.shift(), responseCode:202,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({status:'preparing', token:'fixture-progress', completed:80, total:160})).toString('base64')});
    await waitFor("document.getElementById('folder-feedback').textContent.includes('80 / 160')");
    assert.deepEqual(await gridGeometry(), preparingGeometry, 'Preparation progress leaves the grid geometry unchanged');
    network.order = false;
    for (const requestId of held.splice(0)) await call('Fetch.continueRequest', {requestId}).catch(() => {});
    await call('Fetch.disable');
    await waitFor("import('/gallery.js').then(({app}) => app.grid.directory && !app.grid.directory.preparation && !app.grid.loadingFolder)");
    assert.deepEqual(await gridGeometry(), preparingGeometry, 'Completing order preparation does not resize the viewport or move the grid');

    await browser.start();
    network.folders = true;
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/folder*'}]});
    await open('/?folder=Album&compact=1');
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    assert.ok(held.length);
    const openingGeometry = await gridGeometry();
    for (const requestId of held.splice(0)) await call('Fetch.fulfillRequest', {requestId, responseCode:503,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({error:'Folder temporarily unavailable'})).toString('base64')});
    await waitFor("document.getElementById('folder-feedback').textContent === 'Folder temporarily unavailable'");
    assert.deepEqual(await gridGeometry(), openingGeometry, 'Folder failures use the same stable feedback area');
    assert.ok(await retryVisible());
    network.folders = false;
    await call('Fetch.disable');
    await browser.click('load-more');
    await waitFor("document.querySelector('.card[data-path=\"Album/Chapter 1\"]')");
    await waitFor("document.getElementById('folder-feedback').textContent === ''");
    assert.deepEqual(await gridGeometry(), openingGeometry, 'Retrying a folder uses the same footer and viewport geometry');

    await browser.start('/?view=grid');
    await waitFor("import('/gallery.js').then(({app}) => app.grid.directory?.window.paths.length >= 60 && !app.grid.loadingPage && !app.grid.loadingFolder)");
    network.walk = true;
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/walk*'}]});
    const overviewGeometry = await gridGeometry();
    // The folder listing seeds adjacency; force the next page to need discovery.
    await evaluate("import('/static/data/api.js').then(({sequence}) => sequence.clear())");
    await evaluate("import('/gallery.js').then(({app}) => {app.grid.loadPage();})");
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    assert.ok(held.length);
    for (const requestId of held.splice(0)) await call('Fetch.fulfillRequest', {requestId, responseCode:503,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({error:'More items temporarily unavailable'})).toString('base64')});
    await waitFor("document.getElementById('folder-feedback').textContent === 'More items temporarily unavailable'");
    assert.deepEqual(await gridGeometry(), overviewGeometry, 'Overview discovery failures do not move existing content');
    assert.ok(await retryVisible(), 'Overview Retry stays visible outside the long scrolling collection');
    network.walk = false;
    await call('Fetch.disable');
    await browser.click('load-more');
    await waitFor("import('/gallery.js').then(({app}) => app.grid.directory?.window.paths.length >= 60 && !app.grid.loadingPage && !app.grid.loadingFolder)");
    assert.equal(await evaluate("document.getElementById('folder-feedback').textContent"), '');

    const reconcileFolder = join(fixtures.fixtureRoot, 'Reconcile files');
    mkdirSync(reconcileFolder);
    for (let number = 0; number < 100; number++) {
        writeFileSync(join(reconcileFolder, `notes${String(number).padStart(3, '0')}.txt`), Buffer.alloc(number + 1, 'x'));
    }
    await browser.start('/?folder=Reconcile%20files&compact=1&sort=size');
    await waitFor("import('/gallery.js').then(({app}) => app.grid.directory && !app.grid.directory.preparation && !app.grid.loadingFolder)");
    await evaluate("document.querySelector('.other-files-toggle').click()");
    await evaluate("import('/gallery.js').then(({app}) => {window.reconcileApp=app; const row=app.grid.layout.byPath.get('item:' + JSON.stringify(['Reconcile files/notes030.txt', 'file'])); app.grid.viewport.scrollTop=app.grid.gridOffset+row.top+11; app.info.show('Reconcile files/notes040.txt', 'file');})");
    await waitFor("!document.getElementById('metadata-details').classList.contains('loading') && !reconcileApp.grid.facts.loading && !reconcileApp.tree.pending.size");
    const retainedListing = await evaluate("Array.from(document.querySelectorAll('.other-file'), card => card.dataset.path)");
    await evaluate("window.reconcileCard=document.querySelector('.other-file[data-path=\"Reconcile files/notes030.txt\"]'); window.reconcileLink=reconcileCard.querySelector('button'); reconcileLink.focus({preventScroll:true});");
    const retainedGeometry = await gridGeometry();
    network.folders = true;
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/folder*'}]});
    writeFileSync(join(reconcileFolder, 'notes040.txt'), Buffer.alloc(51, 'x'));
    writeFileSync(join(reconcileFolder, 'notes045.txt'), Buffer.alloc(44, 'x'));
    await evaluate("reconcileApp.info.refresh()");
    await waitFor("reconcileApp.grid.loadingFolder");
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.other-file'), card => card.dataset.path)"), retainedListing,
        'Background reconciliation keeps the previously valid listing visible');
    assert.equal(await evaluate("document.querySelector('.other-file[data-path=\"Reconcile files/notes030.txt\"]') === reconcileCard && document.activeElement === reconcileLink"), true);
    assert.deepEqual(await gridGeometry(), retainedGeometry);
    await evaluate("{const row=reconcileApp.grid.layout.byPath.get('item:' + JSON.stringify(['Reconcile files/notes038.txt', 'file'])); reconcileApp.grid.viewport.scrollTop=reconcileApp.grid.gridOffset+row.top+11;}");
    await waitFor("document.querySelector('.other-file[data-path=\"Reconcile files/notes038.txt\"]')");
    await evaluate("document.querySelector('.other-file[data-path=\"Reconcile files/notes038.txt\"] button').focus({preventScroll:true})");
    const latestAnchor = await evaluate("reconcileApp.grid.position()");
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    assert.ok(held.length);
    network.folders = false;
    for (const requestId of held.splice(0)) await call('Fetch.continueRequest', {requestId});
    await call('Fetch.disable');
    await waitFor("!reconcileApp.grid.loadingFolder && reconcileApp.grid.directory.listing.other_files.indexOf('notes040.txt') > reconcileApp.grid.directory.listing.other_files.indexOf('notes049.txt')");
    const refreshedAnchor = await evaluate("reconcileApp.grid.position()");
    assert.equal(refreshedAnchor.path, latestAnchor.path);
    assert.equal(refreshedAnchor.offset, latestAnchor.offset, 'Replacement preserves scrolling performed while the request was pending');
    assert.equal(await evaluate("document.activeElement.closest('.other-file')?.dataset.path"), 'Reconcile files/notes038.txt',
        'Replacement preserves focus on the same file');

    // A failed background refresh leaves the listing usable until an explicit retry.
    await evaluate("reconcileApp.info.show('Reconcile files/notes050.txt', 'file')");
    await waitFor("!document.getElementById('metadata-details').classList.contains('loading') && !reconcileApp.grid.facts.loading");
    network.folders = true;
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/folder*'}]});
    await evaluate("window.failedRefreshCard=document.querySelector('.other-file[data-path=\"Reconcile files/notes038.txt\"]')");
    writeFileSync(join(reconcileFolder, 'notes050.txt'), 'xxx');
    await evaluate("reconcileApp.info.refresh()");
    await waitFor("reconcileApp.grid.loadingFolder");
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    assert.ok(held.length);
    for (const requestId of held.splice(0)) await call('Fetch.fulfillRequest', {requestId, responseCode:503,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({error:'Refresh temporarily unavailable'})).toString('base64')});
    await waitFor("reconcileApp.grid.folderError && !reconcileApp.grid.loadingFolder");
    assert.equal(await evaluate("document.querySelector('.other-file[data-path=\"Reconcile files/notes038.txt\"]') === failedRefreshCard"), true);
    await evaluate("reconcileApp.grid.scheduleRender()");
    await browser.pause(100);
    assert.equal(await evaluate("document.getElementById('folder-feedback').textContent"), 'Refresh temporarily unavailable');
    assert.ok(await retryVisible());
    network.folders = false;
    await call('Fetch.disable');
    await browser.click('load-more');
    await waitFor("reconcileApp.grid.directory?.listing.other_files[3] === 'notes050.txt' && !reconcileApp.grid.loadingFolder");
    assert.equal(await evaluate("document.getElementById('folder-feedback').textContent"), '');

    // A reader window must rebuild both sides after an incompatible revision,
    // retaining the selected media node and its viewport anchor.
    await browser.start(browser.viewerUrl('root10.jpg', 'auto', '', ReadingLayout.SCROLL));
    await browser.readyImage('root10.jpg');
    await evaluate("import('/gallery.js').then(({app}) => window.testApp = app)");
    await waitFor("testApp.viewer.continuous.paths.length > 12 && !testApp.viewer.continuous.edges.some(edge => edge.loading)");
    await evaluate("window.retainedImage = document.getElementById('viewer-image')");
    writeFileSync(join(fixtures.fixtureRoot, 'root09a.jpg'), readFileSync(join(fixtures.fixtureRoot, 'root10.jpg')));
    await evaluate("import('/static/data/api.js').then(module => module.refreshScope(''))");
    await evaluate("testApp.viewer.continuous.discover(testApp.viewer.continuous.edges[1])");
    await waitFor("testApp.viewer.continuous.items.map(item => item.path).join('|') === testApp.viewer.continuous.paths.join('|')");
    assert.equal(await evaluate("document.getElementById('viewer-image') === retainedImage && testApp.state.image === 'root10.jpg'"), true);
    await browser.readyImage('root10.jpg');

    // Info publishes fresh byte counts through shared facts. A size-sorted list
    // must reconcile even when the file's modified time remains unchanged.
    const notes = join(fixtures.fixtureRoot, 'Other files/notes.txt');
    const original = readFileSync(notes);
    const timestamp = 1700000000;
    utimesSync(notes, timestamp, timestamp);
    const refreshServer = () => evaluate("fetch('/api/refresh', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:'Other files'})}).then(response => response.json())");
    await refreshServer();
    await browser.start('/?compact=1&folder=Other%20files&sort=size');
    await waitFor("import('/gallery.js').then(({app}) => app.grid.directory && !app.grid.directory.preparation && !app.grid.loadingFolder)");
    await evaluate("document.querySelector('.other-files-toggle').click()");
    await waitFor("document.querySelector('.other-file[data-path=\"Other files/notes.txt\"] .item-modified[datetime]')");
    const paths = "Array.from(document.querySelectorAll('.other-file'), card => card.dataset.path)";
    assert.deepEqual(await evaluate(paths), ['Other files/notes.txt', 'Other files/sunrise.heic']);
    const modified = await evaluate("document.querySelector('.other-file[data-path=\"Other files/notes.txt\"] .item-modified').dateTime");
    try {
        writeFileSync(notes, Buffer.alloc(100, 'x'));
        utimesSync(notes, timestamp, timestamp);
        await evaluate("document.querySelector('.other-file[data-path=\"Other files/notes.txt\"] button').click()");
        await waitFor(`${paths}.join('|') === 'Other files/sunrise.heic|Other files/notes.txt'`);
        await waitFor("document.querySelector('.other-file[data-path=\"Other files/notes.txt\"] .item-modified[datetime]')");
        assert.equal(await evaluate("document.querySelector('.other-file[data-path=\"Other files/notes.txt\"] .item-modified').dateTime"), modified);
        assert.equal(await evaluate("document.querySelector('.other-file[data-path=\"Other files/notes.txt\"] .item-size').title"), 'Size: 100 bytes');
    } finally {
        writeFileSync(notes, original);
        await refreshServer();
    }

}
