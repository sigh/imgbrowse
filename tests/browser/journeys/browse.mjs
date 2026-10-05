import assert from 'node:assert/strict';
import {join} from 'node:path';
import {statSync} from 'node:fs';

export async function run(browser, fixtures) {
    const {call, evaluate, waitFor, open, click, nativeKey, screenshot, pause, position, requests} = browser;
    await browser.start();
    await open('/');
    await waitFor("document.querySelectorAll('.card').length > 5");
    await waitFor("document.querySelector('.folder-card[data-path=Album] .item-modified[datetime]')");
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('.grid-row'), row => {
        const cards = Array.from(row.querySelectorAll('.card'));
        return !cards.some(card => card.classList.contains('folder-card'))
            || cards.every(card => card.classList.contains('folder-card'));
    }).every(Boolean)`), 'Folders and files occupy separate grid rows');
    const albumModified = statSync(join(fixtures.fixtureRoot, 'Album')).mtime.toISOString();
    assert.equal(await evaluate("import('/static/data/metadata-data.js').then(({formatMetadataDate}) => document.querySelector('.folder-card[data-path=Album] .item-modified').textContent === formatMetadataDate(" + JSON.stringify(albumModified) + "))"),
        true, 'Browse displays the filesystem modified time using the shared formatter');
    // An unrelated cancellation must settle once, rather than freezing the folder
    // view with an endless chain of immediately retried promises.
    const cancellationCheck = await evaluate(`(async () => {
        const {PreviewLoader} = await import('/static/ui/preview-loader.js');
        const loader = new PreviewLoader(document.getElementById('grid-viewport'), document.getElementById('viewer'));
        const controller = new AbortController();
        let attempts = 0;
        let result;
        try {
            await loader.enqueue(() => {
                if (++attempts <= 1000) throw new DOMException('Source cancelled', 'AbortError');
                return 'retried';
            }, document.querySelector('.card .picture'), controller.signal);
            result = 'unexpected retry';
        } catch (error) { result = error.name; }
        await new Promise(resolve => requestAnimationFrame(resolve));
        return {attempts, result, scopeAborted: controller.signal.aborted};
    })()`);
    assert.deepEqual(cancellationCheck, {attempts: 1, result: 'AbortError', scopeAborted: false});
    assert.ok(await evaluate("document.querySelectorAll('.card').length < 50"));
    await waitFor("document.querySelector('.picture img')?.naturalWidth > 0");
    const resizedPictureHeight = await evaluate(`import('/gallery.js').then(({app}) => {
        const viewport = app.grid.viewport;
        const originalStyle = viewport.getAttribute('style');
        try {
            for (const [name, value] of Object.entries({
                '--card-image-height':'90px', '--grid-min-row-height':'0px',
                '--grid-row-padding':'9px', '--card-caption-padding':'11px',
                '--card-border-width':'3px', '--card-caption-gap':'13px',
                '--grid-min-column-width':'400px',
            })) viewport.style.setProperty(name, value);
            app.grid.relayout();
            return document.querySelector('.folder-card .picture').getBoundingClientRect().height;
        } finally {
            if (originalStyle === null) viewport.removeAttribute('style');
            else viewport.setAttribute('style', originalStyle);
            app.grid.relayout();
        }
    })`);
    assert.ok(Math.abs(resizedPictureHeight - 90) < 1,
        'Virtual rows preserve the CSS preview height when borders, padding, and controls determine their size: ' + resizedPictureHeight);
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('.card .picture'), picture => {
        const frame = picture.getBoundingClientRect(), card = picture.closest('.card').getBoundingClientRect();
        const image = picture.querySelector('img')?.getBoundingClientRect();
        return frame.left >= card.left-.5 && frame.right <= card.right+.5
            && frame.top >= card.top-.5 && frame.bottom <= card.bottom+.5
            && (!image || image.left >= frame.left-.5 && image.right <= frame.right+.5
                && image.top >= frame.top-.5 && image.bottom <= frame.bottom+.5);
    }).every(Boolean)`), 'Preview frames and images stay within their cards');
    assert.equal(await evaluate("document.getElementById('layout-previews').getBoundingClientRect().right"), await evaluate("document.getElementById('layout-list').getBoundingClientRect().left"), 'Layout choices remain a contiguous button group');
    await screenshot('grid');
    const folderModeAction = await evaluate("document.getElementById('read-strip').getBoundingClientRect().toJSON()");
    const actionColors = await evaluate("(() => {const style=id=>getComputedStyle(document.getElementById(id)); return {action:style('read-strip').backgroundColor, neutral:style('layout-list').backgroundColor, selected:style('layout-previews').backgroundColor};})()");
    assert.equal(actionColors.action, actionColors.neutral, 'View uses neutral action styling');
    assert.notEqual(actionColors.action, actionColors.selected, 'View does not appear permanently selected');
    await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:folderModeAction.x+folderModeAction.width/2, y:folderModeAction.y+folderModeAction.height/2});
    assert.notEqual(await evaluate("getComputedStyle(document.getElementById('read-strip')).backgroundColor"), actionColors.action, 'Hover feedback is visible');
    assert.deepEqual(await evaluate("document.getElementById('read-strip').getBoundingClientRect().toJSON()"), folderModeAction, 'Hover preserves button geometry');
    await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:700, y:450});
    const imageNameBounds = await evaluate("document.querySelector('.card-caption .image-name').getBoundingClientRect().toJSON()");
    await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:imageNameBounds.x+imageNameBounds.width/2, y:imageNameBounds.y+imageNameBounds.height/2});
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.card-caption .image-name')).backgroundColor"), 'rgba(0, 0, 0, 0)', 'Content links stay unfilled under the shared hover rules');
    await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:700, y:450});

    assert.equal(await evaluate("document.getElementById('read-strip').textContent.trim()"), '', 'Opening the viewer uses one icon action');
    assert.ok(await evaluate("[...document.querySelectorAll('.mode-navigation')].every(group => [...group.querySelectorAll('a')].map(button => button.dataset.mode).join(',') === 'browse,overview' && group.querySelectorAll('[aria-current=page]').length === 1 && !group.querySelector('button:disabled'))"), 'Every screen uses the same fixed navigation group with one selected destination');
    assert.ok(await evaluate("[...document.querySelectorAll('[data-layout]')].every(button => button.textContent.trim()==='' && button.querySelector('svg') && button.getAttribute('aria-label') && button.title)"), 'Layout choices use named icons');
    await pause(150);
    const visibleCards = await evaluate(`(() => {
        const bounds = document.getElementById('grid-viewport').getBoundingClientRect();
        return [...document.querySelectorAll('.card')].filter(card => {
            const rect = card.querySelector('.picture').getBoundingClientRect();
            return rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right;
        }).map(card => card.dataset.path);
    })()`);
    assert.ok(await evaluate('document.querySelectorAll(".card").length') > visibleCards.length, 'Fixture must include DOM overscan');
    for (const request of requests.filter(url => new URL(url).pathname === '/thumbnail')) {
        assert.ok(visibleCards.includes(new URL(request).searchParams.get('path')), 'Only visible card paths may request thumbnails: ' + request);
    }
    assert.equal(await evaluate("document.getElementById('item-info').open"), true, 'Info is expanded by default');
    await click('folders-toggle');
    await browser.openInfo();
    assert.deepEqual(await evaluate("(() => { const style=getComputedStyle(document.getElementById('metadata-copy')); return {width:style.width,height:style.height}; })()"),
        {width:'24px', height:'20px'}, 'Shared controls do not override the compact Copy geometry');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.folder-card .card-name')).textDecorationLine"),
        'none', 'Folder captions only underline on hover');
    await evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => { window.copiedPath=text; }}}); document.querySelector('#metadata-panel .copy-path').click()");
    await waitFor("window.copiedPath");
    const absoluteRoot = await evaluate('window.copiedPath');
    assert.ok(absoluteRoot.startsWith('/'));
    await evaluate("{ const info=document.querySelector('#metadata-toggle'); info.focus(); }");
    await waitFor("document.getElementById('metadata-panel').textContent.includes('direct media')");
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#metadata-toggle')).backgroundColor"), actionColors.selected, 'Expanded Info has no selected-mode treatment');

    assert.equal(await evaluate("(!document.getElementById('folder-tree').hidden && document.getElementById('item-info').open)"), true);
    assert.ok(await evaluate("document.querySelector('#item-info > summary') && document.querySelector('#metadata-panel .copy-path') && !document.querySelector('.app-header > .item-location .copy-path')"), 'Copy belongs in Info alongside the full path');
    assert.equal(await evaluate("[...document.querySelectorAll('#metadata-details dt')].some(row => row.textContent === 'Type')"), false);
    assert.equal(await evaluate("import('/static/data/metadata-data.js').then(({formatMetadataDate}) => formatMetadataDate('2005-01-10T17:08:17'))"), '2005-01-10 17:08');
    const folderActions = await evaluate("document.querySelector('.sort-controls').getBoundingClientRect().toJSON()");

    assert.equal(await evaluate("document.getElementById('metadata-panel').textContent.includes('including archives') || document.getElementById('metadata-panel').textContent.includes('Scope')"), false);
    assert.ok(folderActions.right <= await evaluate('innerWidth'));
    await screenshot('folder-info');
    assert.ok(await evaluate("(() => {const panel=document.getElementById('item-info').getBoundingClientRect(), sidebar=document.getElementById('folder-tree').getBoundingClientRect(); return panel.bottom===sidebar.bottom && panel.top>=document.getElementById('folder-navigation').getBoundingClientRect().bottom;})()"), 'Info occupies the bottom of the sidebar below the tree');
    await nativeKey('Escape', 27);
    await waitFor("!(!document.getElementById('folder-tree').hidden && document.getElementById('item-info').open)");
    assert.equal(await evaluate('document.activeElement.id'), 'folders-toggle');
    await browser.openInfo();
    await call('Input.dispatchMouseEvent', {type:'mousePressed', x:800, y:20, button:'left', clickCount:1});
    await call('Input.dispatchMouseEvent', {type:'mouseReleased', x:800, y:20, button:'left', clickCount:1});
    assert.ok(await evaluate("!document.getElementById('folder-tree').hidden && document.getElementById('item-info').open"), 'Desktop Info stays open while browsing outside the sidebar');
    await click('metadata-toggle');
    await click('folders-toggle');

    // Filtering reuses the name index; only missing complete entries need a page.
    const folderRequests = () => requests.filter(url => new URL(url).pathname === '/api/folder').length;
    const countBeforeFilter = folderRequests();
    await evaluate("{ const input=document.getElementById('filter'); input.value='root12'; input.dispatchEvent(new Event('input')); }");
    await waitFor("document.getElementById('folder-summary').textContent.includes('11 matches')");
    await waitFor("document.querySelector('.card[data-path=\"root120.jpg\"] .item-modified[datetime]')");
    assert.equal(folderRequests(), countBeforeFilter);
    await call('Page.reload');
    await waitFor("document.getElementById('folder-summary')?.textContent.includes('11 matches')");
    await waitFor("document.querySelector('.card[data-path=\"root120.jpg\"] .item-modified[datetime]')");
    assert.equal(folderRequests(), countBeforeFilter + 1);
    assert.ok(await evaluate("document.getElementById('folder-summary').textContent.includes('11 matches')"));
    await evaluate("{ const input=document.getElementById('filter'); input.value=''; input.dispatchEvent(new Event('input')); }");
    await waitFor("!new URLSearchParams(location.search).has('filter')");
    await evaluate("document.getElementById('grid-viewport').scrollTop = 1800");
    await pause(160);
    const anchor = await evaluate('history.state.position.path');
    const beforeLayout = await evaluate('history.length');
    await click('layout-list');
    await waitFor("document.querySelector('.list-item')");
    await waitFor("document.querySelector('.list-item .item-modified[datetime]')");
    assert.ok(await evaluate("document.querySelector('.list-item .item-modified').getAttribute('aria-label').startsWith('Modified: ')"));
    assert.equal(await evaluate('history.length'), beforeLayout);
    assert.equal(await evaluate('history.state.position.path'), anchor);
    assert.ok(await evaluate("[...document.querySelectorAll('.list-name')].some(node=>node.textContent=== " + JSON.stringify(anchor) + ")"));
    assert.equal(await evaluate("document.querySelectorAll('#grid img').length"), 0);
    await screenshot('list');
    const historyBeforeSameLayout = await evaluate('history.length');
    await click('layout-list');
    assert.equal(await evaluate('history.length'), historyBeforeSameLayout);

}
