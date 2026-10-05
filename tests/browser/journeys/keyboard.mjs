import assert from 'node:assert/strict';
import {ReadingLayout} from '../../../image_browser/web/static/shared/state.js';

export async function run(browser, {first, second}) {
    const {evaluate, waitFor, nativeKey, open, readyImage, viewerUrl, click, call} = browser;
    await browser.start();
    for (const layout of Object.values(ReadingLayout)) {
        await open(viewerUrl(first, '2', 'Album', layout));
        await readyImage(first);
        await evaluate("document.getElementById('viewer-canvas').focus(); document.getElementById('viewer-canvas').scrollLeft=0; document.getElementById('viewer-canvas').scrollTop=200");
        assert.ok(await evaluate("document.getElementById('viewer-canvas').scrollWidth-document.getElementById('viewer-canvas').clientWidth > 160"));
        const opening = await evaluate('({url:location.href, length:history.length})');
        await nativeKey('ArrowRight', 39, 8);
        await waitFor("document.getElementById('viewer-canvas').scrollLeft === 80");
        for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', {
            type, key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39, modifiers:8, autoRepeat:type==='keyDown',
        });
        await waitFor("document.getElementById('viewer-canvas').scrollLeft === 160");
        await nativeKey('ArrowLeft', 37, 8);
        await waitFor("document.getElementById('viewer-canvas').scrollLeft === 80");
        await nativeKey('ArrowLeft', 37, 8);
        await nativeKey('ArrowLeft', 37, 8);
        assert.equal(await evaluate("document.getElementById('viewer-canvas').scrollLeft"), 0);
        await evaluate("document.getElementById('viewer-canvas').scrollLeft=100000");
        const edge = await evaluate("document.getElementById('viewer-canvas').scrollLeft");
        await nativeKey('ArrowRight', 39, 8);
        assert.equal(await evaluate("document.getElementById('viewer-canvas').scrollLeft"), edge, 'Panning stops at the edge');
        assert.deepEqual(await evaluate('({url:location.href, length:history.length})'), opening, 'Panning and repeats do not navigate or create history');
        const top = await evaluate("document.getElementById('viewer-canvas').scrollTop");
        await nativeKey('ArrowDown', 40);
        await waitFor(`document.getElementById('viewer-canvas').scrollTop > ${top}`);
        assert.equal(await evaluate('location.href'), opening.url, 'Vertical panning retains its current behavior');

        await evaluate("document.getElementById('viewer-canvas').scrollLeft=80");
        const point = () => evaluate("import('/gallery.js').then(({app})=>app.viewer.viewport.point())");
        const inspected = await point();
        await click('viewer-zoom-in');
        assert.ok(Math.abs((await point()).x-inspected.x)<2, 'Zoom retains the horizontally inspected point');
        await browser.presentation(layout === ReadingLayout.SCROLL ? ReadingLayout.SINGLE : ReadingLayout.SCROLL);
        await readyImage(first);
        assert.ok(Math.abs((await point()).x-inspected.x)<2, 'Presentation changes retain the horizontally inspected point');
        await nativeKey('f', 70);
        await evaluate("document.getElementById('viewer-canvas').focus()");
        const fitted = await evaluate('location.href');
        await nativeKey('ArrowRight', 39, 8);
        assert.equal(await evaluate('location.href'), fitted, 'Shift+arrow never falls back to a page turn when the image fits');
        await nativeKey('ArrowRight', 39);
        await readyImage(second);
        await nativeKey('ArrowLeft', 37);
        await readyImage(first);
    }
    await browser.start(viewerUrl(first));
    await readyImage(first);
    await waitFor("document.querySelector('#viewer-strip button[data-path=\"Album/Chapter 1/page10.jpg\"]')");
    assert.ok(await evaluate("!document.getElementById('viewer').hasAttribute('aria-modal') && document.getElementById('viewer').getAttribute('role') === 'region'"));
    assert.ok(await evaluate("!document.querySelector('.app-header').inert && document.querySelector('.toolbar').inert && document.getElementById('grid-viewport').hidden && document.getElementById('summary').hidden"));

    await evaluate("document.querySelector('.strip-resizer').focus()");
    await nativeKey('Tab', 9);
    assert.equal(await evaluate('document.activeElement.dataset.path'), first);
    assert.equal(await evaluate("document.querySelectorAll('#viewer-strip button[tabindex=\"0\"]').length"), 1);
    await nativeKey('ArrowRight', 39);
    await readyImage(second);
    assert.equal(await evaluate('document.activeElement.dataset.path'), second);
    await nativeKey('Tab', 9, 8);
    assert.ok(await evaluate("document.activeElement.classList.contains('strip-resizer')"));
    await nativeKey('Tab', 9);
    assert.equal(await evaluate('document.activeElement.dataset.path'), second);
    await nativeKey('Tab', 9);
    assert.ok(await evaluate("!document.getElementById('viewer-strip').contains(document.activeElement)"), 'Tab leaves the thumbnails in one step');
    await click('viewer-prev');
    await readyImage(first);
    assert.equal(await evaluate('document.activeElement.id'), 'viewer-prev', 'Navigation outside the strip keeps its focus');

    await browser.openInfo();
    await waitFor("document.getElementById('metadata-panel').textContent.includes('1000 × 1800')");
    await click('metadata-toggle');
    await click('metadata-toggle');
    assert.equal(await evaluate('document.activeElement.id'), 'metadata-toggle');
    assert.ok(await evaluate("document.getElementById('folder-tree').contains(document.getElementById('item-info'))"));
    await nativeKey('ArrowRight', 39);
    await readyImage(second);
    await nativeKey('ArrowLeft', 37, 8);
    await readyImage(first);
    await evaluate("window.copyControl=document.getElementById('metadata-copy');copyControl.focus()");
    await nativeKey('ArrowRight', 39);
    await readyImage(second);
    await waitFor("!document.getElementById('metadata-details').classList.contains('loading')");
    assert.ok(await evaluate("document.activeElement === copyControl && copyControl === document.getElementById('metadata-copy')"), 'Metadata updates retain copy-control focus without moving it');
    const beforeVerticalKey = await evaluate('location.href');
    await nativeKey('ArrowDown', 40);
    assert.equal(await evaluate('location.href'), beforeVerticalKey, 'Vertical keys outside the reader keep native behavior');
    await nativeKey('ArrowLeft', 37);
    await readyImage(first);
    await nativeKey('Escape', 27);
    assert.ok(await evaluate("document.activeElement.id === 'folders-toggle' && !document.getElementById('viewer').hidden"));
    await nativeKey('Tab', 9);
    assert.equal(await evaluate('document.activeElement.id'), 'browse-folder', 'Native Tab follows the header order');

    await click('overview-folder');
    await waitFor("!document.getElementById('overview').hidden && document.querySelector('#overview .picture')");
    await evaluate("document.getElementById('grid-viewport').focus()");
    await nativeKey('Tab', 9);
    assert.ok(await evaluate("document.getElementById('overview').contains(document.activeElement) && document.activeElement.matches('a')"), 'Overview uses native Tab order');

    await open(viewerUrl('root40.jpg', undefined, ''));
    await readyImage('root40.jpg');
    await waitFor("document.querySelectorAll('#viewer-strip button').length > 10");
    await evaluate("window.focusedThumbnail=document.querySelector('#viewer-strip [aria-current]'); focusedThumbnail.focus(); document.getElementById('viewer-strip').scrollLeft=0");
    await waitFor("focusedThumbnail.getBoundingClientRect().left >= document.getElementById('viewer-strip').getBoundingClientRect().right");
    assert.ok(await evaluate("focusedThumbnail.isConnected && document.activeElement === focusedThumbnail && document.querySelectorAll('#viewer-strip button').length < 40"), 'Virtualization retains keyboard focus with a bounded DOM');
    await evaluate("document.querySelector('.strip-resizer').focus()");
    await nativeKey('Tab', 9);
    await waitFor(`(() => {
        const thumbnail = focusedThumbnail.getBoundingClientRect(), strip = document.getElementById('viewer-strip').getBoundingClientRect();
        return document.activeElement === focusedThumbnail && thumbnail.left >= strip.left && thumbnail.right <= strip.right;
    })()`);

    await open('/?folder=Mixed&compact=1');
    await waitFor("document.querySelector('[data-path=\"Mixed/2.webm\"] .list-name')");
    assert.equal(await evaluate("document.querySelector('[data-path=\"Mixed/2.webm\"] .list-name').getAttribute('aria-label')"), 'View video 2.webm');
    await open('/?compact=1');
    await waitFor("document.querySelector('[data-path=\"Mixed\"] .list-name')");
    assert.equal(await evaluate("document.querySelector('[data-path=\"Mixed\"] .list-name').getAttribute('aria-label')"), 'Open folder Mixed');

    await open(viewerUrl('Mixed/1.jpg', undefined, 'Mixed'));
    await readyImage('Mixed/1.jpg');
    await waitFor("document.querySelector('#viewer-strip button[data-path=\"Mixed/2.webm\"]')");
    await evaluate("document.querySelector('#viewer-strip [aria-current]').focus()");
    await nativeKey('ArrowRight', 39);
    await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
    assert.equal(await evaluate('document.activeElement.dataset.path'), 'Mixed/2.webm');
    assert.ok(await evaluate("document.getElementById('viewer-strip').contains(document.activeElement)"), 'Video entry preserves thumbnail focus');
    await nativeKey('ArrowRight', 39);
    await readyImage('Mixed/3.jpg');
    await click('viewer-prev');
    await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
    assert.equal(await evaluate('document.activeElement.id'), 'viewer-prev', 'Video entry preserves navigation-button focus');

    await open(viewerUrl('Mixed/2.webm', undefined, 'Mixed'));
    await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
    assert.ok(await evaluate("(() => { const video=document.getElementById('viewer-video'); video.focus(); return ['Tab', 'ArrowRight', ' '].every(key => video.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true, cancelable:true}))); })()"), 'Video keys retain their native behavior');
    assert.ok(await evaluate("document.getElementById('viewer-video').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', shiftKey:true, bubbles:true, cancelable:true}))"), 'Shift+arrow retains native video behavior');
}
