import assert from 'node:assert/strict';
import {ImageSize, ReadingLayout} from '../../image_browser/web/static/state.js';

export async function run(browser, {first, second, last, absoluteRoot}) {
    const {call, evaluate, waitFor, readyImage, click, presentation, setZoom, viewerUrl, headerPositions, screenshot, nativeKey, open, network, held} = browser;
    await browser.start(viewerUrl(first));
    await readyImage(first);
    const positions = await headerPositions();
    await presentation(ReadingLayout.SCROLL);
    await readyImage(first);
    await waitFor("document.querySelectorAll('.reader-item').length === 3 && [...document.querySelectorAll('.reader-item img')].every(image => image.naturalWidth === 1000)");
    assert.deepEqual(await headerPositions(), positions);
    assert.equal(await evaluate("document.getElementById('viewer-strip').hidden"), true);
    assert.equal(await evaluate("document.querySelector('.strip-frame').hidden"), true);
    assert.ok(await evaluate("document.getElementById('viewer-image').width === document.getElementById('viewer-canvas').clientWidth"));
    assert.ok(await evaluate("!document.querySelector('[data-size=page]') && !document.querySelector('[data-size=width]')"));
    const historyLength = await evaluate('history.length');
    await evaluate("window.firstOriginal=document.getElementById('viewer-image'); const row=firstOriginal.closest('.reader-item'); document.getElementById('viewer-canvas').scrollTop=row.offsetTop+row.offsetHeight-60");
    const canvas = await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()");
    await call('Input.dispatchMouseEvent',{type:'mouseWheel',x:canvas.x+canvas.width/2,y:canvas.y+canvas.height/2,deltaX:0,deltaY:160});
    await readyImage(second);
    assert.ok(await evaluate('firstOriginal.isConnected'), 'The previous page stays in the native column as the next enters');
    assert.equal(await evaluate('history.length'),historyLength,'Scrolling replaces the current history entry');
    assert.equal(await evaluate("new URLSearchParams(location.search).get('view')"), ReadingLayout.SCROLL);
    await evaluate("document.querySelector('#item-actions .item-info').click()");
    await waitFor("document.getElementById('metadata-title').textContent === 'page10.jpg'");
    await browser.openInfo();
    await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedPath=text}}}); document.querySelector('#metadata-details .copy-path').click()");
    await waitFor('window.copiedPath');
    assert.equal(await evaluate('window.copiedPath'),absoluteRoot+'/'+second);
    await nativeKey('Escape',27);

    const passage = () => evaluate("(() => {const canvas=document.getElementById('viewer-canvas'), image=document.getElementById('viewer-image'); return (canvas.getBoundingClientRect().top-image.getBoundingClientRect().top)/(image.width/image.naturalWidth);})()");
    const beforeZoom = await passage();
    await setZoom(137);
    assert.ok(Math.abs(await passage()-beforeZoom)<3,'Percentage zoom retains the passage at the reading edge');
    await presentation(ReadingLayout.SINGLE);
    await readyImage(second);
    assert.equal(await evaluate("(new URLSearchParams(location.search).get('size') || 'auto')"),'1.37');
    assert.ok(Math.abs(await passage()-beforeZoom)<3,'A manual zoom and passage survive switching to Single');
    await presentation(ReadingLayout.SCROLL);
    await readyImage(second);
    await waitFor("import('/gallery.js').then(({app})=>app.viewer.continuous.edges.every(edge=>edge.done))");
    const returnedPassage = await passage();
    await click('overview-folder');
    await waitFor("!document.getElementById('overview').hidden && document.querySelector('#overview .selected-media')");
    await presentation(ReadingLayout.SCROLL);
    await readyImage(second);
    await waitFor("import('/gallery.js').then(({app})=>app.viewer.continuous.edges.every(edge=>edge.done))");
    assert.ok(Math.abs(await passage()-returnedPassage)<3,'Overview returns to the same Scroll passage');

    await click('viewer-next');
    await readyImage(last);
    await click('viewer-next');
    await waitFor("document.getElementById('viewer-next').dataset.icon === 'first'");
    await call('Input.dispatchMouseEvent',{type:'mouseWheel',x:canvas.x+canvas.width/2,y:canvas.y+canvas.height/2,deltaX:0,deltaY:100000});
    await readyImage(last);
    await click('viewer-next');
    await readyImage(first);
    await click('viewer-next');
    await readyImage(second);
    const beforeResize = await passage();
    await call('Emulation.setDeviceMetricsOverride',{width:1100,height:820,deviceScaleFactor:1,mobile:false});
    await waitFor("import('/gallery.js').then(({app})=>app.viewer.viewport.box.width === app.viewer.canvas.clientWidth)");
    assert.ok(Math.abs(await passage()-beforeResize)<3,'Resize preserves the passage');
    await browser.key('f');
    assert.equal(await evaluate("(new URLSearchParams(location.search).get('size') || 'auto')"),ImageSize.DEFAULT);
    assert.ok(await evaluate("document.getElementById('viewer-image').width === document.getElementById('viewer-canvas').clientWidth"));
    const detail = await evaluate("document.getElementById('viewer-image').getBoundingClientRect().toJSON()");
    const readingCanvas = await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()");
    for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,
        x:detail.x+detail.width/2,y:readingCanvas.y+readingCanvas.height/2});
    assert.equal(await evaluate("(new URLSearchParams(location.search).get('size') || 'auto')"),'1');
    assert.equal(await evaluate("document.querySelector('.reading-navigation [aria-current=page]').dataset.readingLayout"),ReadingLayout.SCROLL);
    for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,
        x:readingCanvas.x+readingCanvas.width/2,y:readingCanvas.y+readingCanvas.height/2});
    assert.equal(await evaluate("(new URLSearchParams(location.search).get('size') || 'auto')"),ImageSize.DEFAULT);
    await screenshot('continuous-reading');
    await call('Page.reload');
    await readyImage(second);
    assert.equal(await evaluate("document.querySelector('.reading-navigation [aria-current=page]').dataset.readingLayout"),ReadingLayout.SCROLL);
    await click('browse-folder');
    await waitFor("document.getElementById('viewer').hidden");
    assert.equal(await evaluate("document.querySelectorAll('.reader-item').length"),0,'Leaving releases the continuous media window');
    await presentation(ReadingLayout.SCROLL);
    await readyImage(second);
    assert.equal(await evaluate("document.querySelector('.reading-navigation [aria-current=page]').dataset.readingLayout"),ReadingLayout.SCROLL);

    // A new tree destination clears the old column while first-item discovery is pending.
    await click('folders-toggle');
    await waitFor("document.querySelector('.tree-row[data-path=\"Album\"] a')");
    await evaluate("document.querySelector('.tree-row[data-path=\"Album\"] a').click()");
    await waitFor("document.querySelector('.tree-row[data-path=\"Album/Chapter 2\"] a')");
    await evaluate("import('/static/api.js').then(({sequence})=>sequence.clear())");
    await call('Fetch.enable',{patterns:[{urlPattern:'*/api/walk*'}]});
    network.walk = true;
    await evaluate("document.querySelector('.tree-row[data-path=\"Album/Chapter 2\"] a').click()");
    assert.equal(await evaluate("document.querySelectorAll('.reader-item').length"),0);
    assert.ok(await evaluate("document.getElementById('viewer-image').hidden"));
    await waitFor("document.getElementById('viewer-status').textContent.includes('Finding')");
    network.walk = false;
    for (const requestId of held.splice(0)) await call('Fetch.continueRequest',{requestId});
    await readyImage(last);
    await call('Fetch.disable');
    await click('folders-toggle');

    // Jump directly into an archive, and retain a compact phone header.
    await call('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
    await open(viewerUrl('Packed.cbz/page10.jpg',ImageSize.DEFAULT,'Packed.cbz',ReadingLayout.SCROLL));
    await readyImage('Packed.cbz/page10.jpg');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
    assert.equal((await headerPositions()).height,85);
    await presentation(ReadingLayout.SINGLE);
    await readyImage('Packed.cbz/page10.jpg');
    await presentation(ReadingLayout.SCROLL);
    await readyImage('Packed.cbz/page10.jpg');
    await screenshot('continuous-phone');

    // A failed original retains its row geometry and retries in place.
    await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await call('Fetch.enable',{patterns:[{urlPattern:'*/image?*'}]});
    network.images = true;
    await open(viewerUrl(first,ImageSize.DEFAULT,'Album',ReadingLayout.SCROLL));
    await waitFor("import('/gallery.js').then(({app})=>app.viewer.continuous.current.width === 1000)");
    await waitFor("document.querySelector('.reader-status').textContent === 'Loading…'");
    const pendingHeight = await evaluate("document.querySelector('.reader-item').offsetHeight");
    assert.ok(held.length);
    for (const requestId of held.splice(0)) await call('Fetch.failRequest',{requestId,errorReason:'Failed'});
    await waitFor("document.querySelector('.reader-status button')");
    assert.equal(await evaluate("document.querySelector('.reader-item').offsetHeight"),pendingHeight);
    assert.ok(await evaluate("document.querySelector('.reader-status').textContent.startsWith('Unable to open')"));
    network.images = false;
    await evaluate("document.querySelector('.reader-status button').click()");
    await readyImage(first);
    await call('Fetch.disable');

    // Native video controls remain embedded, do not autoplay, and release their stream on exit.
    await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await open(viewerUrl('Mixed/1.jpg',ImageSize.DEFAULT,'Mixed',ReadingLayout.SCROLL));
    await readyImage('Mixed/1.jpg');
    await waitFor("document.querySelector('.reader-item video')?.readyState >= 2");
    assert.ok(await evaluate("document.querySelector('.reader-item video').paused"));
    await click('viewer-next');
    await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
    await evaluate("window.scrollVideo=document.getElementById('viewer-video'); scrollVideo.focus()");
    await nativeKey('ArrowRight',39);
    assert.equal(await evaluate("document.getElementById('viewer-video').dataset.path"),'Mixed/2.webm');
    await screenshot('continuous-video');
    await evaluate("scrollVideo.currentTime=1.2");
    await waitFor('!scrollVideo.seeking && scrollVideo.currentTime >= 1.1');
    await presentation(ReadingLayout.SINGLE);
    await waitFor("document.getElementById('viewer-video')?.currentTime >= 1.1");
    await presentation(ReadingLayout.SCROLL);
    await waitFor("document.getElementById('viewer-video')?.currentTime >= 1.1");
    await evaluate("window.scrollVideo=document.getElementById('viewer-video')");
    await click('browse-folder');
    assert.ok(await evaluate("scrollVideo.paused && !scrollVideo.isConnected && !scrollVideo.hasAttribute('src')"));
}
