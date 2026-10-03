import assert from 'node:assert/strict';

export async function run(browser, {first, second}) {
    const {evaluate, waitFor, nativeKey, open, readyImage, viewerUrl, click, call} = browser;
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
    await call('Input.dispatchKeyEvent', {type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9, modifiers:8});
    await call('Input.dispatchKeyEvent', {type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9, modifiers:8});
    assert.ok(await evaluate("document.activeElement.classList.contains('strip-resizer')"));
    await nativeKey('Tab', 9);
    assert.equal(await evaluate('document.activeElement.dataset.path'), second);
    await nativeKey('Tab', 9);
    assert.ok(await evaluate("!document.getElementById('viewer-strip').contains(document.activeElement)"), 'Tab leaves the thumbnails in one step');
    await click('viewer-prev');
    await readyImage(first);
    assert.equal(await evaluate('document.activeElement.id'), 'viewer-prev', 'Navigation outside the strip keeps its focus');

    await evaluate("document.querySelector('#item-actions .item-info').click()");
    await waitFor("document.getElementById('metadata-details').textContent.includes('1000 × 1800')");
    assert.equal(await evaluate('document.activeElement.id'), 'metadata-popover');
    assert.ok(await evaluate("document.getElementById('item-actions').contains(document.getElementById('metadata-popover'))"));
    await nativeKey('ArrowRight', 39);
    await readyImage(first);
    await nativeKey('Escape', 27);
    assert.ok(await evaluate("document.activeElement.matches('#item-actions .item-info') && !document.getElementById('viewer').hidden"));
    await nativeKey('Tab', 9);
    assert.equal(await evaluate('document.activeElement.id'), 'viewer-prev', 'Native Tab follows the header order');

    await click('overview-folder');
    await waitFor("!document.getElementById('overview').hidden && document.querySelector('#overview .picture')");
    await evaluate("document.getElementById('grid-viewport').focus()");
    await nativeKey('Tab', 9);
    assert.ok(await evaluate("document.getElementById('overview').contains(document.activeElement) && document.activeElement.matches('a')"), 'Overview uses native Tab order');

    await open(viewerUrl('root40.jpg', undefined, ''));
    await readyImage('root40.jpg');
    await waitFor("document.querySelectorAll('#viewer-strip button').length > 10");
    await evaluate("window.focusedThumbnail=document.querySelector('#viewer-strip [aria-current]'); focusedThumbnail.focus(); document.getElementById('viewer-strip').scrollLeft=0");
    await waitFor("focusedThumbnail.closest('.strip-tile').classList.contains('pinned')");
    assert.ok(await evaluate("focusedThumbnail.isConnected && document.activeElement === focusedThumbnail && document.querySelectorAll('#viewer-strip button').length < 40"), 'Virtualization retains keyboard focus with a bounded DOM');
    await evaluate("document.querySelector('.strip-resizer').focus()");
    await nativeKey('Tab', 9);
    await waitFor("document.activeElement === focusedThumbnail && !focusedThumbnail.closest('.strip-tile').classList.contains('pinned')");

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
}
