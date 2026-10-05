import assert from 'node:assert/strict';
import {statSync} from 'node:fs';
import {join} from 'node:path';

export async function run(browser, {fixtureRoot}) {
    const {open, evaluate, waitFor, call, screenshot} = browser;
    const rows = () => evaluate(`Array.from(document.querySelectorAll('.list-item'), card => {
        const rect = selector => card.querySelector(selector)?.getBoundingClientRect().toJSON();
        const date = card.querySelector('.item-modified');
        const size = card.querySelector('.item-size');
        return {card:card.getBoundingClientRect().toJSON(), name:rect('.list-name'),
            date:rect('.item-modified'), size:rect('.item-size'), detail:rect('.list-duration, .list-file-type'),
            dateFits:date.scrollWidth <= date.clientWidth, sizeFits:size.scrollWidth <= size.clientWidth};
    })`);
    function checkColumns(items) {
        assert.ok(items.length);
        for (const {card, name, date, size, detail, dateFits, sizeFits} of items) {
            assert.ok(size.left >= name.right && date.left >= size.right, 'Size and modified date have separate columns after the name');
            assert.ok(date.top < name.bottom && date.bottom > name.top, 'Name and date share a row');
            assert.ok(size.top < name.bottom && size.bottom > name.top && sizeFits, 'Size fits on the name row');
            assert.ok(date.right <= card.right && dateFits, 'The complete date fits inside the row');
            assert.ok(!detail || detail.right <= size.left, 'File type and duration precede the size column');
            assert.ok(Math.abs(date.right - items[0].date.right) < 1, 'Date columns align across item types');
            assert.ok(Math.abs(size.right - items[0].size.right) < 1, 'Size columns align across item types');
        }
    }
    async function checkSizes(folder) {
        const sizes = await evaluate(`Array.from(document.querySelectorAll('.list-item'), card => ({
            path:card.dataset.path, type:card.dataset.type, text:card.querySelector('.item-size').textContent,
            title:card.querySelector('.item-size').title
        }))`);
        for (const item of sizes) {
            if (item.type === 'folder') assert.equal(item.text, '—', 'Folders have no calculated size');
            else {
                const file = folder === 'Packed.cbz' ? 'root2.jpg' : item.path;
                const bytes = statSync(join(fixtureRoot, file)).size;
                assert.equal(item.title, `Size: ${bytes.toLocaleString()} bytes`, 'Size matches the file or uncompressed archive member');
                assert.ok(item.text !== '—' && item.text !== '…', 'Loaded files show formatted sizes');
            }
        }
    }
    await browser.start('/?compact=1');
    await waitFor("document.querySelector('.list-item .item-modified[datetime]') && !document.getElementById('grid-viewport').matches('[aria-busy=true]')");
    checkColumns(await rows());
    await checkSizes('');
    await screenshot('list-dates-desktop');

    await evaluate("document.getElementById('layout-previews').click()");
    await waitFor("document.querySelector('.card-name') && !document.getElementById('grid-viewport').matches('[aria-busy=true]')");
    const requests = browser.requests.filter(url => new URL(url).pathname === '/api/folder/entries').length;
    await evaluate("document.getElementById('layout-list').click()");
    await waitFor("document.querySelector('.list-name') && !document.getElementById('grid-viewport').matches('[aria-busy=true]')");
    assert.equal(browser.requests.filter(url => new URL(url).pathname === '/api/folder/entries').length, requests,
        'List sizes reuse the facts already requested for the visible cards');

    await open('/?compact=1&folder=Mixed');
    await waitFor("document.querySelectorAll('.list-item .item-modified[datetime]').length === 4");
    checkColumns(await rows());
    await checkSizes('Mixed');
    await screenshot('list-dates-video');

    await open('/?compact=1&folder=Other%20files');
    await waitFor("document.querySelector('.other-files-toggle')");
    await evaluate("document.querySelector('.other-files-toggle').click()");
    await waitFor("document.querySelectorAll('.list-item .item-modified[datetime]').length === 2");
    checkColumns(await rows());
    await checkSizes('Other files');

    await open('/?compact=1&folder=Packed.cbz');
    await waitFor("document.querySelectorAll('.list-item').length === 3 && !document.getElementById('grid-viewport').matches('[aria-busy=true]')");
    checkColumns(await rows());
    await checkSizes('Packed.cbz');

    // Wrapping names must remain inside their virtual rows at both breakpoints.
    await open('/?compact=1&folder=Names');
    await waitFor("document.querySelector('.list-item .item-modified[datetime]')");
    for (const width of [701, 700, 390, 320, 1440]) {
        await call('Emulation.setDeviceMetricsOverride', {width, height:900, deviceScaleFactor:1, mobile:false});
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const items = await rows();
        for (const {card, name, date, size, dateFits, sizeFits} of items) {
            assert.ok(name.bottom <= card.bottom && date.bottom <= card.bottom, `Row fits its content at ${width}px`);
            assert.ok(dateFits, `Full modified date stays visible at ${width}px`);
            assert.ok(sizeFits && size.right <= card.right && size.bottom <= card.bottom, `Size fits inside the row at ${width}px`);
            if (width <= 700) {
                assert.ok(date.top >= name.bottom, 'Narrow rows stack the date beneath the name');
                assert.ok(Math.abs(date.left - name.left) < 1, 'Stacked dates align with the name');
                assert.ok(size.left >= date.right && Math.abs(size.top - date.top) < 1, 'Size and date share the second line');
            }
        }
        if (width > 700) checkColumns(items);
        assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'List has no horizontal overflow');
        if (width === 390) await screenshot('list-dates-mobile');
    }

    // Resizing the sidebar also reduces the space available to the list.
    await call('Emulation.setDeviceMetricsOverride', {width:940, height:900, deviceScaleFactor:1, mobile:false});
    await evaluate("document.getElementById('folders-toggle').click(); document.getElementById('folder-tree').style.setProperty('--tree-width', '600px')");
    await waitFor("document.getElementById('grid-viewport').clientWidth <= 340");
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    for (const {card, name, date, size, dateFits, sizeFits} of await rows()) {
        assert.ok(date.top >= name.bottom, 'A wide sidebar activates the narrow list layout');
        assert.ok(dateFits && sizeFits && size.right <= card.right, 'File details fit beside a wide sidebar');
    }
}
