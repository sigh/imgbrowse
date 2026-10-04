import assert from 'node:assert/strict';
import {ReadingLayout} from '../../image_browser/web/static/state.js';

export async function run(browser, {first, second, absoluteRoot}) {
    const {evaluate, waitFor, open, click, readyImage, viewerUrl, headerPositions, call, network, held, nativeKey, screenshot} = browser;
    await browser.start();

    // Copy failures are visible beside their action without changing header geometry.
    for (const viewing of [false, true]) {
        if (viewing) { await open(viewerUrl(first)); await readyImage(first); }
        await browser.openInfo();
        const prefix = '#metadata-details';
        const geometry = await headerPositions();
        await evaluate(`window.originalExecCommand=document.execCommand; document.execCommand=()=>false;
            Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied');}}});
            document.querySelector('${prefix} .copy-path').click()`);
        await waitFor(`document.querySelector('${prefix} .copy-feedback').textContent === 'Copy failed. Try again.'`);
        assert.ok(await evaluate(`(() => { const feedback=document.querySelector('${prefix} .copy-feedback'), bounds=feedback.getBoundingClientRect(); return feedback.getAttribute('role')==='status' && bounds.height>0 && bounds.left>=0 && bounds.right<=innerWidth; })()`));
        assert.deepEqual(await headerPositions(), geometry);
        await screenshot(viewing ? 'image-copy-failure' : 'folder-copy-failure');
        await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async path=>{window.copiedPath=path;}}});
            document.execCommand=window.originalExecCommand; document.querySelector('${prefix} .copy-path').click()`);
        await waitFor(`document.querySelector('${prefix} .copy-path').getAttribute('aria-label') === 'Copied'`);
        assert.equal(await evaluate(`document.querySelector('${prefix} .copy-feedback').textContent`), '');
    }

    // A failed Info request retries in place and keeps keyboard focus in the panel.
    await nativeKey('Escape', 27);
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/metadata?*'}]});
    network.metadata = true;
    await evaluate("document.querySelector('#item-actions .item-info').click()");
    for (let attempt=0; !held.length && attempt<160; attempt++) await browser.pause(50);
    assert.ok(held.length);
    for (const requestId of held.splice(0)) await call('Fetch.fulfillRequest', {requestId,responseCode:503,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({error:'Temporary failure'})).toString('base64')});
    await waitFor("document.querySelector('#metadata-status button')");
    assert.equal(await evaluate("document.getElementById('metadata-status').firstChild.textContent"), 'Unable to load info. ');
    await screenshot('metadata-failure');
    network.metadata = false;
    await nativeKey('Tab', 9);
    await nativeKey('Tab', 9);
    assert.ok(await evaluate("document.activeElement.matches('#metadata-status button')"));
    await nativeKey('Enter', 13);
    await waitFor("document.getElementById('metadata-details').textContent.includes('1000 × 1800')");
    assert.ok(await evaluate("!document.querySelector('#metadata-status button') && document.activeElement.id==='metadata-popover' && document.getElementById('metadata-popover').matches(':popover-open')"));
    await nativeKey('Escape', 27);
    await call('Fetch.disable');

    // Retry repeats failed backwards discovery, rather than reloading the current image.
    await open(viewerUrl(second) + '&view=' + ReadingLayout.SINGLE);
    await readyImage(second);
    await waitFor("import('/gallery.js').then(({app})=>app.viewer.nearbyImages.includes('Album/Chapter 1/page2.jpg'))");
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/walk*'}]});
    network.walk = true;
    await evaluate("Promise.all([import('/gallery.js'),import('/static/api.js')]).then(([{app},{sequence}])=>{app.viewer.nearbyImages=[]; sequence.clear();})");
    await click('viewer-prev');
    await waitFor("document.getElementById('viewer-status').textContent === 'Finding the previous item…'");
    for (const requestId of held.splice(0)) await call('Fetch.failRequest',{requestId,errorReason:'Failed'});
    await waitFor("!document.getElementById('viewer-retry').hidden");
    assert.equal(await evaluate("document.getElementById('viewer-status').textContent"), 'Unable to find the previous item.');
    network.walk = false;
    await click('viewer-retry');
    await readyImage(first);
    await call('Fetch.disable');

    // Known format/decode failures have no ineffective retry; network failure does.
    await open(viewerUrl('Mixed/4.mp4', undefined, 'Mixed'));
    await waitFor("document.getElementById('viewer-status').textContent.includes('Unable to play')");
    assert.ok(await evaluate("document.getElementById('viewer-retry').hidden && !document.getElementById('viewer-prev').disabled"));
    await click('viewer-prev');
    await readyImage('Mixed/3.jpg');
    await click('viewer-prev');
    await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
    await evaluate("{const video=document.getElementById('viewer-video'); Object.defineProperty(video,'error',{configurable:true,value:{code:MediaError.MEDIA_ERR_DECODE}}); video.dispatchEvent(new Event('error'));}");
    assert.ok(await evaluate("document.getElementById('viewer-retry').hidden"));
    await evaluate("{const video=document.getElementById('viewer-video'); Object.defineProperty(video,'error',{configurable:true,value:{code:MediaError.MEDIA_ERR_NETWORK}}); video.dispatchEvent(new Event('error'));}");
    assert.ok(await evaluate("!document.getElementById('viewer-retry').hidden"));
    await click('viewer-retry');
    await waitFor("document.getElementById('viewer-video')?.readyState >= 2 && document.getElementById('viewer-status').textContent === ''");

    // Archive information identifies logical member paths; copied paths stay complete.
    await open(viewerUrl('Packed.cbz/page2.jpg', undefined, 'Packed.cbz'));
    await readyImage('Packed.cbz/page2.jpg');
    await evaluate("document.querySelector('#item-actions .item-info').click()");
    await waitFor("document.querySelector('.metadata-path')");
    assert.equal(await evaluate("document.querySelector('.metadata-path-heading').textContent"), 'Member path');
    assert.equal(await evaluate("document.querySelector('.metadata-path-text').textContent"), absoluteRoot + '/Packed.cbz/page2.jpg');
    await nativeKey('Escape', 27);
    await open('/?folder=Packed.cbz');
    await evaluate("document.querySelector('#item-actions .item-info').click()");
    await waitFor("document.querySelector('.metadata-path-heading')?.textContent === 'Archive'");
    await nativeKey('Escape', 27);
    await open('/?folder=Empty&viewer=1');
    await waitFor("document.getElementById('viewer-status').textContent === 'No images or videos in this collection.'");
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden");
}
