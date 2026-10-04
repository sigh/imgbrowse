import assert from 'node:assert/strict';

export async function run(browser, fixtures) {
    const {call, evaluate, waitFor, open, click, waitImage, key, wheel, readyImage, pause, viewerUrl, network, held} = browser;
    const {absoluteRoot, first, second, last} = fixtures;
    await browser.start();
    // Pending media has an empty, stable canvas; identity and actions refer to the requested file.
    await open(viewerUrl(first));
    await readyImage(first);
    await evaluate("document.querySelector('#item-actions .item-info').click()");
    await waitFor(`document.getElementById('metadata-details').textContent.includes(${JSON.stringify(first)})`);
    await call('Fetch.enable', {patterns:[{urlPattern:'*/image?*'},{urlPattern:'*/api/walk'}]});
    network.images = true;
    await evaluate("import('/static/media-cache.js').then(module => module.originals.clear())");
    const beforeLoading = await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()");
    await click('viewer-next');
    await waitImage(second);
    assert.ok(await evaluate("document.getElementById('viewer-image').hidden && !document.getElementById('viewer-image').hasAttribute('src')"), 'The old image is removed as soon as the target changes');
    assert.equal(await evaluate("document.querySelector('#item-path .item-name').textContent"), 'page10.jpg');
    assert.equal(await evaluate("document.getElementById('viewer-zoom-in').disabled"), true);
    await waitFor(`document.getElementById('metadata-details').textContent.includes(${JSON.stringify(second)})`);
    await evaluate("window.copiedPath=null; Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => { window.copiedPath=text; }}}); document.querySelector('#metadata-details .copy-path').click()");
    await waitFor('window.copiedPath');
    assert.equal(await evaluate('window.copiedPath'), absoluteRoot + '/' + second);
    await waitFor("document.getElementById('viewer-status').textContent.includes('Loading')");
    assert.deepEqual(await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()"), beforeLoading, 'Loading feedback does not resize the canvas');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.viewer-feedback')).display"), 'flex', 'Loading feedback is visible');
    network.images = false;
    for (const requestId of held.splice(0)) await call('Fetch.continueRequest',{requestId}).catch(()=>{});
    await readyImage(second);
    assert.equal(await evaluate("document.getElementById('viewer-status').textContent"), '');
    assert.deepEqual(await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()"), beforeLoading, 'Completing the replacement preserves canvas geometry');
    await key('f');
    const fittedWidth = await evaluate("document.getElementById('viewer-image').width");
    await click('viewer-zoom-in');
    assert.ok(Math.abs(await evaluate("document.getElementById('viewer-image').width") - fittedWidth * 1.25) < 2);
    assert.equal(await evaluate("document.getElementById('viewer-image').dataset.path"), second);
    await click('viewer-zoom-out');
    assert.ok(Math.abs(await evaluate("document.getElementById('viewer-image').width") - fittedWidth) < 2);

    // A failed replacement cannot reveal the previous image; Retry loads the same target.
    network.images = true;
    await evaluate("import('/static/media-cache.js').then(module => module.originals.clear())");
    await click('viewer-next');
    await waitImage(last);
    await waitFor(`document.getElementById('metadata-details').textContent.includes(${JSON.stringify(last)})`);
    for (let attempt = 0; !held.length && attempt < 160; attempt++) await pause(50);
    assert.ok(held.length > 0, 'The replacement request is held');
    for (const requestId of held.splice(0)) await call('Fetch.failRequest', {requestId, errorReason:'Failed'}).catch(()=>{});
    await waitFor("!document.getElementById('viewer-retry').hidden");
    assert.ok(await evaluate("document.getElementById('viewer-image').hidden && !document.getElementById('viewer-image').hasAttribute('src')"), 'Failure keeps the old image out of the canvas');
    assert.equal(await evaluate("document.querySelector('#item-path .item-name').textContent"), 'page1.jpg');
    await evaluate("window.copiedPath=null; document.querySelector('#metadata-details .copy-path').click()");
    await waitFor('window.copiedPath');
    assert.equal(await evaluate('window.copiedPath'), absoluteRoot + '/' + last);
    network.images = false;
    await click('viewer-retry');
    await readyImage(last);

    // Continued wheel navigation changes the target while an image is still loading.
    await key('f');
    network.images = true;
    await evaluate("import('/static/media-cache.js').then(module => module.originals.clear())");
    await wheel(-100);
    await waitImage(second);
    await wheel(-100);
    await waitImage(first);
    assert.equal(await evaluate("document.querySelector('#item-location .item-name').textContent"), 'page2.jpg');
    assert.ok(await evaluate("document.getElementById('viewer-image').hidden"));
    network.images = false;
    for (const requestId of held.splice(0)) await call('Fetch.continueRequest',{requestId}).catch(()=>{});
    await readyImage(first);
    await pause(150);
    assert.equal(await evaluate("document.getElementById('viewer-image').dataset.path"), first);

    // Cancelled work cannot reopen a closed viewer or reattach an old image.
    network.images = true;
    await evaluate("import('/static/media-cache.js').then(module => module.originals.clear())");
    await click('viewer-next');
    await waitImage(second);
    await waitFor("document.getElementById('viewer-status').textContent.includes('Loading')");
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden");
    network.images = false;
    for (const requestId of held.splice(0)) await call('Fetch.continueRequest',{requestId}).catch(()=>{});
    await pause(150);
    assert.ok(await evaluate("document.getElementById('viewer').hidden"));
    assert.ok(await evaluate("document.getElementById('viewer-image').hidden && !document.getElementById('viewer-image').hasAttribute('src')"));

    // A delayed walk isn't an end boundary. Empty and single-image collections have no dead controls.
    network.walk = true;
    await open('/?folder=Empty&viewer=1');
    await waitFor("document.getElementById('viewer-status').textContent.includes('Finding')");
    assert.ok(await evaluate("document.getElementById('viewer-next').disabled"));
    network.walk = false;
    for (const requestId of held.splice(0)) await call('Fetch.continueRequest',{requestId}).catch(()=>{});
    await waitFor("document.getElementById('viewer-status').textContent.includes('No images')");
    assert.ok(await evaluate("document.getElementById('viewer-zoom-in').disabled"));
    await call('Fetch.disable');
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden && document.getElementById('grid-status').textContent.includes('no visible')");
    await click('overview-folder');
    await waitFor("!document.getElementById('overview').hidden && document.getElementById('grid-status').textContent.includes('No images')");
    await click('read-strip');
    await waitFor("document.getElementById('overview').hidden && document.getElementById('viewer-status').textContent.includes('No images')");
    assert.equal(await evaluate("document.getElementById('read-strip').getAttribute('aria-current')"), 'page');
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden && location.search === '?folder=Empty'");
    await open('/?folder=Single&viewer=1');
    await readyImage('Single/only.jpg');
    await waitFor("document.getElementById('viewer-prev').disabled && document.getElementById('viewer-next').disabled");

    await open(viewerUrl('Album/Chapter 1/missing.jpg'));
    await waitFor("!document.getElementById('viewer-retry').hidden");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.viewer-feedback')).display"), 'flex', 'Error feedback and Retry are visible');
    assert.ok(await evaluate("!document.getElementById('viewer-next').disabled"));
    await click('viewer-next');
    await readyImage(first);
    await call('Page.reload');
    await waitFor("document.getElementById('viewer-image')?.dataset.path === 'Album/Chapter 1/page2.jpg'");
    await readyImage(first);

}
