import assert from 'node:assert/strict';
import {ImageSize} from '../../../image_browser/web/static/shared/state.js';

export async function run(browser, fixtures) {
    const {call, evaluate, waitFor, open, click, key, nativeKey, wheel, screenshot, readyImage, pause, viewerUrl, presentation} = browser;
    const {absoluteRoot, first} = fixtures;
    await browser.start();
    const geometry = await evaluate(`(async () => {
        const {ThumbnailStrip} = await import('/static/viewer/thumbnail-strip.js');
        const {TaskScope} = await import('/static/shared/dom.js');
        const host = document.createElement('div');
        host.style.cssText='position:fixed;left:0;top:0;width:300px';
        const container = document.createElement('div');
        container.className='viewer-strip';
        container.style.cssText='gap:10px;padding-inline:14px;--thumbnail-default-height:80px;--thumbnail-default-width:72px';
        host.append(container);document.body.append(host);
        const strip = new ThumbnailStrip(container, {thumbnail:async () => {}, schedule:() => {}}, () => {});
        try {
            strip.visible = true; strip.scope = new TaskScope();
            strip.window.paths=['one.jpg','two.jpg'];
            strip.edges.forEach(edge => { edge.done = true; });
            strip.setSize(80);
            const first=strip.nodes.get('one.jpg').button,second=strip.nodes.get('two.jpg').button;
            const a=first.getBoundingClientRect(),b=second.getBoundingClientRect();
            return {offset:strip.layout.items[1].left,actualOffset:b.left-a.left,
                padding:strip.paddingStart,actualPadding:a.left-container.getBoundingClientRect().left,
                width:a.width,height:a.height};
        } finally { strip.resizeObserver.disconnect(); strip.stop(); host.remove(); }
    })()`);
    assert.deepEqual(geometry, {offset:82,actualOffset:82,padding:14,actualPadding:14,width:72,height:80},
        'Thumbnail positioning follows CSS geometry rather than duplicated constants');
    const pagePositions = await evaluate(`(async () => {
        const {ThumbnailStrip} = await import('/static/viewer/thumbnail-strip.js');
        const {CollectionWindow} = await import('/static/data/collection-window.js');
        const {TaskScope} = await import('/static/shared/dom.js');
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;width:300px';
        const container = document.createElement('div');
        container.className = 'viewer-strip';
        container.style.cssText = '--strip-folder-width:82px;--strip-folder-gap:8px';
        host.append(container); document.body.append(host);
        const strip = new ThumbnailStrip(container, {thumbnail:async () => {}, schedule:() => {}}, () => {});
        try {
            strip.labelRoot = 'Album'; strip.visible = true; strip.scope = new TaskScope();
            strip.image = 'Album/B/2.jpg'; strip.followImage = false;
            strip.window = new CollectionWindow(async ({reverse}) => ({
                images:reverse ? ['Album/A/1.jpg'] : ['Album/E/1.jpg', 'Album/E/2.jpg'],
                cursor:null, warnings:[],
            }), {root:'Album', pageSize:2, maxPaths:6});
            strip.window.paths = ['Album/B/1.jpg', 'Album/B/2.jpg', 'Album/C/1.jpg', 'Album/C/2.jpg', 'Album/D/1.jpg'];
            strip.reflow();
            const left = path => strip.nodes.get(path).button.getBoundingClientRect().left;
            const beforePrepend = left(strip.image);
            await strip.discover(strip.edges[0]);
            const prependShift = left(strip.image) - beforePrepend;
            const anchor = 'Album/C/1.jpg', index = strip.paths.indexOf(anchor);
            strip.scrollTo(strip.paddingStart + strip.layout.items[index].thumbnailLeft - 40);
            strip.render();
            const beforeTrim = left(anchor);
            await strip.discover(strip.edges[1]);
            return {prependShift, trimShift:left(anchor) - beforeTrim, count:strip.paths.length};
        } finally { strip.resizeObserver.disconnect(); strip.stop(); host.remove(); }
    })()`);
    assert.ok(Math.abs(pagePositions.prependShift) < 1 && Math.abs(pagePositions.trimShift) < 1,
        'Inline album titles preserve visible thumbnail positions when pages prepend and trim: ' + JSON.stringify(pagePositions));
    assert.equal(pagePositions.count, 6, 'Album title geometry respects the bounded path window');
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
    await waitFor("import('/static/data/media-cache.js').then(module=>Boolean(module.originals.peek('root3.jpg')))");
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
