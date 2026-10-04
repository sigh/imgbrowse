import assert from 'node:assert/strict';
import {ImageSize} from '../../image_browser/web/static/state.js';

export async function run(browser, fixtures) {
    const {call, evaluate, waitFor, open, click, waitImage, key, wheel, screenshot, readyImage, pause, viewerUrl, presentation, headerPositions} = browser;
    await call('Network.setBlockedURLs', {urls:['*/api/video?*']});
    try {
        await browser.start(viewerUrl('Mixed/2.webm', ImageSize.DEFAULT, 'Mixed'));
        await browser.openInfo();
        await waitFor("document.getElementById('metadata-message').textContent === 'Video details unavailable.'");
        assert.ok(await evaluate("document.getElementById('metadata-facts').textContent.includes('Size') && !document.getElementById('metadata-retry').hidden"), 'Video-info failure retains basic facts and offers Retry');
    } finally {
        await call('Network.setBlockedURLs', {urls:[]});
    }
    await click('metadata-retry');
    await waitFor("document.getElementById('metadata-retry').hidden && document.getElementById('metadata-message').textContent === '' && !document.getElementById('metadata-details').classList.contains('loading')");
    assert.equal(await evaluate("document.getElementById('metadata-retry').hidden"), true, 'Retry recovers video information after a network failure');
    await browser.start();
    await open(viewerUrl('Mixed/1.jpg', ImageSize.DEFAULT, 'Mixed'));
    await readyImage('Mixed/1.jpg');
    const initialPositions = await headerPositions();
    // Mixed media: placeholder previews, streaming, native controls, seeking, and cleanup.
    await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await open('/?folder=Mixed');
    await waitFor(`document.querySelector('[data-path="Mixed/2.webm"] :is(.video-placeholder, .video-badge)')`);
    const videoPreviewAvailable = await evaluate("fetch('/thumbnail?path=Mixed/2.webm').then(response => response.ok)");
    if (videoPreviewAvailable) {
        await waitFor(`document.querySelector('[data-path="Mixed/2.webm"] img')?.naturalWidth > 0`);
        assert.ok(await evaluate(`Boolean(document.querySelector('[data-path="Mixed/2.webm"] .video-badge'))`));
    }
    await waitFor(`document.querySelector('[data-path="Mixed/4.mp4"] .video-placeholder')`);
    await evaluate(`document.querySelector('[data-path="Mixed/2.webm"] .picture').click()`);
    await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
    assert.ok(await evaluate("document.activeElement === document.getElementById('viewer-video')"));
    if (videoPreviewAvailable) assert.ok(await evaluate("document.getElementById('viewer-video').poster.startsWith('blob:')"));
    if (await evaluate("document.querySelector('[data-reading-layout=strip]').getAttribute('aria-current') !== 'page'")) await presentation('strip');
    await waitFor(`document.querySelector('#viewer-strip button[data-path="Mixed/1.jpg"]')`);
    assert.ok(await evaluate(`document.querySelector('#viewer-strip button[data-path="Mixed/2.webm"]').offsetWidth > document.querySelector('#viewer-strip button[data-path="Mixed/1.jpg"]').offsetWidth`));
    await call('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
    await pause(150);
    assert.ok(await evaluate("(()=>{const v=document.getElementById('viewer-video'), r=v.getBoundingClientRect(); return Math.abs(r.width/r.height-v.videoWidth/v.videoHeight)<.02 && r.right<=innerWidth})()"));
    await screenshot('video-mobile');
    await browser.openInfo();
    if (videoPreviewAvailable) {
        await waitFor("document.getElementById('metadata-facts').textContent.includes('Duration')");
        assert.ok(await evaluate("document.getElementById('metadata-facts').textContent.includes(document.getElementById('viewer-video').videoWidth + ' × ' + document.getElementById('viewer-video').videoHeight)"), 'Video dimensions appear alongside a visibly labelled duration');
    }
    await screenshot('video-info-mobile');
    await click('folders-toggle');
    await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await open(viewerUrl('Mixed/1.jpg', ImageSize.DEFAULT, 'Mixed'));
    await readyImage('Mixed/1.jpg');
    await click('viewer-next');
    await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
    assert.ok(await evaluate("document.getElementById('viewer-video').paused && document.querySelector('.viewer-tools').classList.contains('unavailable')"));
    assert.deepEqual(await headerPositions(), initialPositions);
    await evaluate("window.testVideo=document.getElementById('viewer-video'); testVideo.focus(); testVideo.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true})); testVideo.dispatchEvent(new WheelEvent('wheel', {deltaY:100,bubbles:true}));");
    await waitImage('Mixed/2.webm');
    await evaluate('testVideo.play()', true);
    await waitFor('testVideo.currentTime > 0');
    await evaluate('testVideo.pause(); testVideo.currentTime=1.5');
    await waitFor('!testVideo.seeking && testVideo.currentTime >= 1.4');
    await click('overview-folder');
    await waitFor("!document.getElementById('overview').hidden && document.querySelector('.selected-media')");
    assert.ok(await evaluate("testVideo.paused && !testVideo.hasAttribute('src')"));
    await evaluate(`document.querySelector('#overview [data-path="Mixed/2.webm"] .picture').click()`);
    await waitFor("document.getElementById('viewer-video')?.currentTime >= 1.4");
    assert.ok(await evaluate("document.getElementById('viewer-video').paused"));
    await evaluate("window.testVideo=document.getElementById('viewer-video');testVideo.dispatchEvent(new Event('ended'))");
    await waitImage('Mixed/2.webm');
    await screenshot('video');
    await click('viewer-next');
    await readyImage('Mixed/3.jpg');
    assert.ok(await evaluate("testVideo.paused && !testVideo.hasAttribute('src') && !testVideo.isConnected && !document.querySelector('.viewer-tools').classList.contains('unavailable')"));
    await click('viewer-prev');
    await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
    await evaluate("window.testVideo=document.getElementById('viewer-video')");
    await click('browse-folder');
    assert.ok(await evaluate("testVideo.paused && !testVideo.hasAttribute('src') && !testVideo.isConnected"));
    await open(viewerUrl('Mixed/4.mp4', ImageSize.DEFAULT, 'Mixed'));
    await waitFor("document.getElementById('viewer-status').textContent.includes('Unable to play')");
    await click('viewer-prev');
    await readyImage('Mixed/3.jpg');
}
