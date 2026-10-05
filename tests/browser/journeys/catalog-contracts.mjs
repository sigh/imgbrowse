import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ReadingLayout} from '../../../image_browser/web/static/shared/state.js';
import assert from 'node:assert/strict';

export async function run(browser, fixtures) {
    const {call, open, evaluate, waitFor, network, held} = browser;
    await browser.start();
    network.entries = true;
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/folder/entries'}]});
    await open('/?compact=1&filter=root12');
    await waitFor("document.querySelector('.card[data-path=\"root120.jpg\"] .list-name') && document.getElementById('grid-status').textContent.includes('Loading dates')");
    assert.equal(await evaluate("document.querySelector('.card[data-path=\"root120.jpg\"] .item-modified').hasAttribute('datetime')"), false);
    assert.ok(await evaluate("document.querySelector('.card[data-path=\"root120.jpg\"] .list-name').href.includes('root120.jpg')"));
    await waitFor("import('/gallery.js').then(({app}) => app.grid.facts.loading)");
    assert.ok(held.length);
    const old = held.splice(0);
    await evaluate("{const input=document.getElementById('filter'); input.value='root159'; input.dispatchEvent(new Event('input'));}");
    await waitFor("document.querySelector('.card[data-path=\"root159.jpg\"] .list-name')");
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    assert.ok(held.length, 'New visible demand starts while an obsolete batch is held');
    for (const requestId of held.splice(0)) await call('Fetch.fulfillRequest', {requestId, responseCode:503,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({error:'Storage busy', code:'storage_busy', retryable:true})).toString('base64')});
    await waitFor("document.getElementById('grid-status').textContent.includes('Some dates')");
    assert.ok(await evaluate("document.querySelector('.card[data-path=\"root159.jpg\"] .list-name').href"));
    await evaluate("{const input=document.getElementById('filter'); input.value='root158'; input.dispatchEvent(new Event('input'));}");
    await waitFor("document.querySelector('.card[data-path=\"root158.jpg\"]')");
    assert.equal(await evaluate("document.getElementById('grid-status').textContent.includes('Some dates')"), false,
        'A new filter clears errors belonging to hidden items');
    await evaluate("window.dateCard = document.querySelector('.card[data-path=\"root158.jpg\"]'); window.dateLink = dateCard.querySelector('.list-name'); dateLink.focus();");
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    network.entries = false;
    for (const requestId of [...old, ...held.splice(0)]) await call('Fetch.continueRequest', {requestId}).catch(() => {});
    await call('Fetch.disable');
    await waitFor("document.querySelector('.card[data-path=\"root158.jpg\"] .item-modified[datetime]')");
    assert.equal(await evaluate("document.querySelector('.card[data-path=\"root158.jpg\"]') === dateCard && document.activeElement === dateLink"), true,
        'Dates update without replacing the card or losing keyboard focus');

    await browser.start();
    network.order = true;
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/folder*'}]});
    await open('/?compact=1&filter=root12&sort=modified');
    await waitFor("document.querySelector('.card[data-path=\"root120.jpg\"]') && document.getElementById('grid-status').textContent.includes('Preparing modified order')");
    assert.ok(await evaluate("document.querySelector('.card .list-name').href"), 'Browse stays usable during preparation');
    for (let i = 0; i < 100 && !held.length; i++) await browser.pause(10);
    await call('Fetch.fulfillRequest', {requestId:held.shift(), responseCode:202,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({status:'preparing', token:'fixture-progress', completed:7, total:160})).toString('base64')});
    await waitFor("document.getElementById('grid-status').textContent.includes('7 / 160')");
    network.order = false;
    for (const requestId of held.splice(0)) await call('Fetch.continueRequest', {requestId}).catch(() => {});
    await call('Fetch.disable');
    await waitFor("import('/gallery.js').then(({app}) => app.grid.directory && !app.grid.directory.preparation && !app.grid.loadingFolder)");

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

}
