import assert from 'node:assert/strict';
import {SortCriterion, SortOrder} from '../../image_browser/web/static/state.js';

export async function run(browser, {first, second, last}) {
    const {start, click, evaluate, waitFor, readyImage, waitImage, presentation, setZoom, nativeKey, screenshot, call, viewerUrl} = browser;
    const app = expression => `import('/gallery.js').then(({app}) => ${expression})`;
    const state = expression => `import('/static/state.js').then(({readState}) => ${expression})`;
    async function change(field, value) {
        if (field === 'sort') {
            if (!await evaluate("document.getElementById('sort-popover').matches(':popover-open')")) await click('sort-toggle');
            await evaluate(`document.querySelector('#sort-popover input[value="${value}"]').click()`);
        } else {
            await closeSort();
            if (await evaluate(state('readState().order')) !== value) await click('sort-direction-toggle');
        }
        await waitFor(app('!app.grid.loadingFolder && !app.viewer.loadingImage && !app.viewer.navigation.moving'));
    }
    const closeSort = () => evaluate("{ const popover=document.getElementById('sort-popover'); if (popover.matches(':popover-open')) popover.hidePopover(); }");
    async function pointerClick(x, y) {
        await call('Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', clickCount:1});
        await call('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', clickCount:1});
    }

    await start('/?folder=Album%2FChapter%201');
    await waitFor(app('app.grid.items.length === 2'));
    assert.deepEqual(await evaluate(app('app.grid.items.map(item => item.path)')), [first, second]);
    await change('sort', SortCriterion.MODIFIED);
    await waitFor(app(`app.grid.items[0]?.path === ${JSON.stringify(second)}`));
    assert.equal(await evaluate("document.getElementById('sort-direction-toggle').title"), 'Oldest first; switch to newest first');
    assert.equal(await evaluate("document.querySelector('#sort-toggle .sort-caption').textContent"), 'File modified');
    assert.equal(await evaluate("document.querySelectorAll('#sort-popover input[type=radio]').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('#sort-popover select').length"), 0);

    // Native radio keys change only the criterion and retain focus in the picker.
    await evaluate("document.querySelector('#sort-popover input:checked').focus()");
    await nativeKey('ArrowUp', 38);
    await waitFor(state("readState().sort === 'natural'"));
    await nativeKey('ArrowDown', 40);
    await waitFor(state("readState().sort === 'modified'"));
    assert.equal(await evaluate(state('readState().order')), 'asc');
    assert.ok(await evaluate("document.getElementById('sort-popover').matches(':popover-open') && document.activeElement.value === 'modified'"));
    await closeSort();

    // The visible direction arrow reverses directly with pointer or keyboard.
    const arrow = await evaluate("(() => { const rect=document.getElementById('sort-direction-toggle').getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()");
    await pointerClick(arrow.x, arrow.y);
    await waitFor(state("readState().order === 'desc'"));
    assert.equal(await evaluate(state('readState().sort')), 'modified');
    assert.ok(await evaluate("!document.getElementById('sort-popover').matches(':popover-open')"));
    assert.equal(await evaluate("document.getElementById('sort-direction-toggle').getAttribute('aria-label')"), 'Switch to oldest first');
    await nativeKey(' ', 32);
    await waitFor(state("readState().order === 'asc'"));
    await waitFor(app(`app.grid.items[0]?.path === ${JSON.stringify(second)}`));

    // Native folder navigation carries the current ordering, including history changes.
    await click('folders-toggle');
    await waitFor(app("!app.tree.pending.size && document.querySelector('.tree-row[data-path=\"Album/Chapter 2\"] a')"));
    const treePaths = await evaluate(app('app.tree.rows.map(row => row.path)'));
    await evaluate("window.sortedBreadcrumb=document.querySelector('#item-path a')");
    await change('order', SortOrder.DESCENDING);
    for (const selector of ['#item-path a', '.tree-row[data-path="Album/Chapter 2"] a']) {
        const destination = await browser.newTab(selector);
        assert.equal(destination.get('sort'), SortCriterion.MODIFIED);
        assert.equal(destination.get('order'), SortOrder.DESCENDING);
    }
    await evaluate('sortedBreadcrumb.focus(); history.back()');
    await waitFor(state("readState().order === 'asc'"));
    await waitFor(app('!app.grid.loadingFolder'));
    assert.ok(await evaluate("document.querySelector('#item-path a')===sortedBreadcrumb && document.activeElement===sortedBreadcrumb"), 'Refreshing native destinations retains breadcrumb identity and focus');
    for (const selector of ['#item-path a', '.tree-row[data-path="Album/Chapter 2"] a']) {
        const destination = await evaluate(`new URL(document.querySelector(${JSON.stringify(selector)}).href).searchParams.toString()`);
        assert.equal(new URLSearchParams(destination).get('sort'), SortCriterion.MODIFIED);
        assert.equal(new URLSearchParams(destination).get('order'), null, 'History restores default direction in native links');
    }
    assert.deepEqual(await evaluate(app('app.tree.rows.map(row => row.path)')), treePaths, 'The tree retains natural folder order');
    await click('folders-toggle');
    const destination = await browser.newTab(`.card[data-path="${second}"] .picture`);
    assert.equal(destination.get('sort'), 'modified');
    await evaluate(`document.querySelector('.card[data-path="${first}"] .picture').click()`);
    await readyImage(first);
    await setZoom(50);

    const cases = [
        [SortCriterion.NAME, SortOrder.ASCENDING, [first, second]], [SortCriterion.MODIFIED, SortOrder.ASCENDING, [second, first]],
        [SortCriterion.NAME, SortOrder.DESCENDING, [second, first]], [SortCriterion.MODIFIED, SortOrder.DESCENDING, [first, second]],
    ];
    for (const layout of ['strip', 'single', 'scroll']) {
        await presentation(layout);
        await readyImage(first);
        for (const [criterion, direction, expected] of cases) {
            await evaluate(app("{ app.viewer.canvas.scrollTop = app.viewer.scrolling ? app.viewer.continuous.current.top + 40 : 40; }"));
            await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            const point = await evaluate(app('app.viewer.viewport.point()'));
            await change('sort', criterion);
            await change('order', direction);
            await readyImage(first);
            await waitFor(app(`app.viewer.navigation.paths.join('|') === ${JSON.stringify(expected.join('|'))}`));
            if (layout === 'strip') await waitFor(app(`app.viewer.filmstrip.paths.join('|') === ${JSON.stringify(expected.join('|'))}`));
            assert.equal(await evaluate(state('readState().size')), '0.5');
            assert.ok(Math.abs((await evaluate(app('app.viewer.viewport.point()'))).y - point.y) < 3, `${layout} retains the reading point when sorting`);
            await closeSort();
            const firstButton = expected[0] === first ? 'viewer-next' : 'viewer-prev';
            const returnButton = expected[0] === first ? 'viewer-prev' : 'viewer-next';
            await click(firstButton);
            await waitImage(second);
            await readyImage(second);
            await click(returnButton);
            await waitImage(first);
            await readyImage(first);
        }
    }

    await presentation('single');
    await readyImage(first);
    await change('order', 'asc');
    await evaluate('history.back()');
    await waitFor(state("readState().order === 'desc'"));
    await readyImage(first);
    await evaluate('history.forward()');
    await waitFor(state("readState().order === 'asc'"));
    await readyImage(first);
    await closeSort();
    await click('sort-toggle');
    await evaluate("document.querySelector('#sort-popover input:checked').focus()");
    await nativeKey('Escape', 27);
    await waitFor("!document.getElementById('sort-popover').matches(':popover-open')");
    assert.equal(await evaluate(state('readState().mode')), 'view', 'Escape closes Sort before closing the viewer');
    assert.equal(await evaluate('document.activeElement.id'), 'sort-toggle');
    await click('sort-toggle');
    await pointerClick(5, 150);
    await waitFor("!document.getElementById('sort-popover').matches(':popover-open')");

    await start('/?folder=Album&sort=modified');
    await waitFor(app(`app.grid.items.map(item => item.path).join('|') === ${JSON.stringify(['Album/Chapter 2', 'Album/Chapter 1'].join('|'))}`));
    await change('order', 'desc');
    await waitFor(app(`app.grid.items.map(item => item.path).join('|') === ${JSON.stringify(['Album/Chapter 1', 'Album/Chapter 2'].join('|'))}`));

    await start('/?folder=Album&view=grid&sort=modified');
    await waitFor(app(`app.grid.items.map(item => item.path).join('|') === ${JSON.stringify([last, second, first].join('|'))}`));
    await change('order', 'desc');
    await waitFor(app(`app.grid.items.map(item => item.path).join('|') === ${JSON.stringify([first, second, last].join('|'))}`));
    const listing = await evaluate("fetch('/api/folder?path=Album&sort=modified&order=desc').then(response => response.json())");
    assert.deepEqual(listing.folders, ['Chapter 1', 'Chapter 2']);
    assert.deepEqual(listing.natural_folders, ['Chapter 1', 'Chapter 2']);
    const invalid = await evaluate("fetch('/api/folder?sort=capture').then(response => response.status)");
    assert.equal(invalid, 400);
    await change('order', 'asc');
    await waitFor(app(`app.grid.items.map(item => item.path).join('|') === ${JSON.stringify([last, second, first].join('|'))}`));
    const ascending = await evaluate("fetch('/api/folder?path=Album&sort=modified').then(response => response.json())");
    assert.deepEqual(ascending.folders, ['Chapter 2', 'Chapter 1']);
    assert.deepEqual(ascending.natural_folders, ['Chapter 1', 'Chapter 2'], 'Tree publications retain natural folder order');
    await change('sort', 'natural');
    await waitFor(app(`app.grid.items.map(item => item.path).join('|') === ${JSON.stringify([first, second, last].join('|'))}`));
    await change('order', 'desc');
    await waitFor(app(`app.grid.items.map(item => item.path).join('|') === ${JSON.stringify([last, second, first].join('|'))}`));
    await closeSort();
    await screenshot('sorting-overview');
    await change('sort', 'modified');
    assert.equal(await evaluate(state('readState().order')), 'desc', 'Criterion selection retains direction');
    await waitFor("document.getElementById('sort-popover').matches(':popover-open')");
    await screenshot('sorting-controls');
    await call('Emulation.setDeviceMetricsOverride', {width:320,height:844,deviceScaleFactor:1,mobile:true});
    await waitFor("(() => { const rect=document.getElementById('sort-popover').getBoundingClientRect(); return rect.left>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight && document.documentElement.scrollWidth<=innerWidth; })()");
    await screenshot('sorting-controls-mobile');

    // Exercise the real labels as touch targets, including the independent arrow.
    await call('Emulation.setTouchEmulationEnabled', {enabled:true});
    await waitFor("document.querySelector('#sort-popover label').offsetHeight === 44");
    async function tap(selector) {
        const rect = await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
        await call('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[{x:rect.left+rect.width/2,y:rect.top+rect.height/2}]});
        await call('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
    }
    await tap('#sort-popover label:has(input[value="natural"])');
    await waitFor(state("readState().sort === 'natural'"));
    await tap('#sort-popover label:has(input[value="modified"])');
    await waitFor(state("readState().sort === 'modified'"));
    await tap('#sort-direction-toggle');
    await waitFor(state("readState().order === 'asc'"));
    await waitFor("!document.getElementById('sort-popover').matches(':popover-open')");
    await call('Emulation.setTouchEmulationEnabled', {enabled:false});

    // The header has one CSS transition; resizing never replaces the full label.
    await start(viewerUrl(last, '0.5', 'Album', 'single') + '&sort=modified');
    await readyImage(last);
    await click('sort-toggle');
    const geometry = () => evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        const path=rect('#item-path'), popup=rect('#sort-popover'), header=rect('.app-header');
        const buttons=['.header-start','.reading-navigation','.viewer-tools','#sort-toggle','#sort-direction-toggle'].map(rect);
        const identities=[...document.querySelectorAll('#item-path .selected-folder, #item-path .item-name')].map(node=>node.getBoundingClientRect());
        resolve({height:header.height, buttons, label:document.querySelector('.sort-caption').textContent,
            fits:document.documentElement.scrollWidth<=innerWidth && buttons.every(box=>box.left>=0 && box.right<=innerWidth)
                && identities.every(box=>box.left>=path.left-.5 && box.right<=path.right+.5)
                && path.right<=buttons[3].left && popup.left>=0 && popup.right<=innerWidth && popup.top>=header.bottom && popup.bottom<=innerHeight});
    })))`);
    for (const width of [320, 390, 619, 620, 680, 1024]) {
        await call('Emulation.setDeviceMetricsOverride', {width,height:844,deviceScaleFactor:1,mobile:false});
        let before;
        for (const mode of ['browse-folder', 'overview-folder', 'read-single']) {
            await click(mode);
            await waitFor(app('!app.grid.loadingFolder && !app.viewer.loadingImage && !app.viewer.navigation.moving'));
            if (!await evaluate("document.getElementById('sort-popover').matches(':popover-open')")) await click('sort-toggle');
            const current = await geometry();
            assert.ok(current.fits, `Header and picker fit at ${width}px in ${mode}`);
            assert.equal(current.label, 'File modified');
            assert.deepEqual(current.buttons.slice(3, 5).map(box=>[box.width,box.height]), [[96,32],[32,32]]);
            assert.equal(current.height, width < 620 ? 85 : 45);
            if (before) assert.deepEqual(current.buttons, before.buttons, `Controls retain their positions at ${width}px`);
            before = current;
        }
        if (width === 320 || width === 680) await screenshot(`sorting-reader-${width}`);
    }
    let previousHeight, transitions = 0;
    for (let width = 420; width <= 760; width += 4) {
        await call('Emulation.setDeviceMetricsOverride', {width,height:300,deviceScaleFactor:1,mobile:false});
        const current = await geometry();
        assert.ok(current.fits, `Continuous resize fits at ${width}px and a short viewport`);
        assert.equal(current.label, 'File modified');
        if (previousHeight && current.height !== previousHeight) transitions++;
        previousHeight = current.height;
    }
    assert.equal(transitions, 1);
}
