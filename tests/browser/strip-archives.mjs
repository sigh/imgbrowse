import assert from 'node:assert/strict';
import {ImageSize} from '../../image_browser/web/static/state.js';

export async function run(browser, fixtures) {
    const {call, evaluate, waitFor, open, click, key, nativeKey, wheel, screenshot, readyImage, pause, viewerUrl, presentation} = browser;
    const {absoluteRoot, first} = fixtures;
    await browser.start();
    // Continued wheel input advances fitted pages without requiring a pause after every image.
    await open(viewerUrl('root2.jpg', ImageSize.DEFAULT, '') + '&view=single');
    await readyImage('root2.jpg');
    // Touchpads emit small, frequent deltas; movement, rather than a cooldown, drives turns.
    await wheel(1, 10);
    await readyImage('root3.jpg');
    await open(viewerUrl('root2.jpg', ImageSize.DEFAULT, '') + '&view=single');
    await readyImage('root2.jpg');
    for (let i=0; i<20; i++) await wheel(20, 10);
    await waitFor("parseInt(new URLSearchParams(location.search).get('image').slice(4)) >= 4");
    await open(viewerUrl('root2.jpg', ImageSize.DEFAULT, '') + '&view=single');
    await readyImage('root2.jpg');
    for (let i=0; i<24; i++) await wheel(60);
    await pause(100);
    assert.ok(await evaluate("Number(new URLSearchParams(location.search).get('image').match(/root(\\d+)/)[1]) >= 6"), 'Sustained wheel input keeps advancing in Fit page with thumbnails hidden');

    // Incidental canvas overflow must not turn Fit page into an enlarged-image gesture.
    const beforeOverflowWheel = await evaluate("parseInt(new URLSearchParams(location.search).get('image').slice(4))");
    await evaluate("document.querySelector('.image-surface').style.minWidth='calc(100% + 4px)'");
    assert.ok(await evaluate("document.getElementById('viewer-canvas').scrollWidth > document.getElementById('viewer-canvas').clientWidth + 2"));
    for (let i=0; i<24; i++) await wheel(60);
    await pause(100);
    assert.ok(await evaluate("parseInt(new URLSearchParams(location.search).get('image').slice(4))") >= beforeOverflowWheel + 4,
        'Fit page keeps advancing even when the canvas reports incidental horizontal overflow');
    await evaluate("document.querySelector('.image-surface').style.minWidth=''");

    // A visible strip retains buttons and their order as pages turn; discovery is demand driven.
    await open(viewerUrl('root2.jpg', ImageSize.DEFAULT, '') + '&view=single');
    await readyImage('root2.jpg');
    await presentation('strip');
    await waitFor("document.querySelectorAll('#viewer-strip button').length >= 16");
    await evaluate("window.retainedThumbnail=document.querySelector('#viewer-strip button')");
    const stripPaths = await evaluate("Array.from(document.querySelectorAll('#viewer-strip button'),button=>button.dataset.path)");
    await waitFor("import('/static/media-cache.js').then(module=>Boolean(module.originals.peek('root3.jpg')))");
    await evaluate(`window.pageTurnMutations=[];
        window.pageTurnObserver=new MutationObserver(records=>pageTurnMutations.push(...records));
        pageTurnObserver.observe(document.body,{childList:true});
        pageTurnObserver.observe(document.getElementById('viewer-strip'),{childList:true});`);
    assert.ok(await evaluate("(() => { document.getElementById('viewer-next').click(); const image=document.getElementById('viewer-image'); return image.dataset.path==='root3.jpg' && !image.hidden; })()"),
        'A decoded next image is displayed synchronously, without a blank loading frame');
    await pause(200);
    assert.ok(await evaluate('window.retainedThumbnail.isConnected'));
    assert.ok(await evaluate("!pageTurnMutations.some(record=>[...record.removedNodes].some(node=>node.id==='grid-viewport' || node.id==='summary' || node.contains(retainedThumbnail)))"),
        'Page turns keep the grid and existing thumbnails attached');
    await evaluate('pageTurnObserver.disconnect()');
    assert.deepEqual((await evaluate("Array.from(document.querySelectorAll('#viewer-strip button'),button=>button.dataset.path)")).slice(0,stripPaths.length),stripPaths);
    // A middle image stays centered as adjacent batches arrive; real ends have no fade.
    await open(viewerUrl('root40.jpg', ImageSize.DEFAULT, ''));
    await readyImage('root40.jpg');
    await waitFor(`(() => {
        const strip = document.getElementById('viewer-strip');
        const selected = strip.querySelector('[aria-current]');
        if (!selected) return false;
        const a = strip.getBoundingClientRect(), b = selected.getBoundingClientRect();
        return Math.abs((a.left+a.right-b.left-b.right)/2) < 2 && strip.classList.contains('more-before') && strip.classList.contains('more-after');
    })()`);
    const thumbPoint = await evaluate(`(() => {const r=document.querySelector('#viewer-strip [aria-current]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await call('Input.dispatchMouseEvent', {type:'mousePressed', button:'left', clickCount:1, ...thumbPoint});
    await call('Input.dispatchMouseEvent', {type:'mouseReleased', button:'left', clickCount:1, ...thumbPoint});
    const stripFocused = await evaluate("document.getElementById('viewer-strip').contains(document.activeElement)");
    await call('Input.dispatchKeyEvent', {type:'keyDown', key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39});
    await call('Input.dispatchKeyEvent', {type:'keyUp', key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39});
    assert.ok(stripFocused);
    await readyImage('root41.jpg');
    await screenshot('strip-centered');
    await evaluate("document.getElementById('viewer-strip').scrollLeft=0");
    await waitFor("import('/gallery.js').then(({app})=>app.viewer.filmstrip.edges[0].done)");
    await evaluate("document.getElementById('viewer-strip').scrollLeft=0");
    await waitFor("!document.getElementById('viewer-strip').classList.contains('more-before')");
    assert.ok(await evaluate("document.getElementById('viewer-strip').classList.contains('more-after')"));
    await evaluate("window.retainedThumbnail=document.querySelector('#viewer-strip button')");
    await evaluate("document.getElementById('viewer-strip').scrollLeft=100000");
    await waitFor("document.querySelector('#viewer-strip button').dataset.path !== window.retainedThumbnail.dataset.path");
    assert.ok(await evaluate("document.querySelectorAll('#viewer-strip button').length < 40"));
    await screenshot('thumbnails');
    assert.ok(await evaluate("document.querySelectorAll('.viewer-tools button').length === 2 && !document.querySelector('#size-menu, #layout-menu')"));
    await screenshot('reading-controls');
    await presentation('single');

    // Breadcrumbs leave the reader for the image's actual folder, preserving the grid layout.
    await open(viewerUrl(first));
    await readyImage(first);
    await evaluate("document.querySelector('#item-path a[aria-current]').click()");
    await waitFor("document.getElementById('viewer').hidden && document.querySelectorAll('.card').length === 2");
    assert.equal(await evaluate("new URLSearchParams(location.search).get('folder')"),'Album/Chapter 1');
    assert.equal(await evaluate("document.querySelector('#item-path [aria-current]').tagName"),'SPAN');

    // ZIP/CBZ archives behave like folders, with direct links and natural page order.
    await open('/?folder=Packed.cbz');
    await waitFor("document.querySelectorAll('.card').length === 3");
    assert.equal(await evaluate("document.querySelector('#item-path [aria-current]').textContent"),'Packed.cbz');
    await click('read-strip');
    await readyImage('Packed.cbz/page2.jpg');
    await click('viewer-next');
    await readyImage('Packed.cbz/page10.jpg');
    await click('viewer-next');
    await readyImage('Packed.cbz/Chapter 3/page1.jpg');
    await open(viewerUrl('Packed.cbz/Chapter 3/page1.jpg', ImageSize.DEFAULT, 'Packed.cbz'));
    await readyImage('Packed.cbz/Chapter 3/page1.jpg');
    await browser.openInfo();
    await evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => { window.copiedPath=text; }}}); document.querySelector('#metadata-panel .copy-path').click()");
    await waitFor('window.copiedPath');
    assert.equal(await evaluate('window.copiedPath'), absoluteRoot + '/Packed.cbz/Chapter 3/page1.jpg');
    await browser.openInfo();
    await waitFor("document.getElementById('metadata-panel').textContent.includes('Packed.cbz/Chapter 3/page1.jpg')");
    await nativeKey('Escape', 27);
    await waitFor("!(!document.getElementById('folder-tree').hidden && document.getElementById('item-info').open)");

    await evaluate("document.querySelector('#item-path a[aria-current]').click()");
    await waitFor("document.getElementById('viewer').hidden && new URLSearchParams(location.search).get('folder') === 'Packed.cbz/Chapter 3'");

}
