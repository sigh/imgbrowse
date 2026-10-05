import assert from 'node:assert/strict';

export async function run(browser) {
    const {open, evaluate, waitFor, call, screenshot} = browser;
    const rows = () => evaluate(`Array.from(document.querySelectorAll('.list-item'), card => {
        const rect = selector => card.querySelector(selector)?.getBoundingClientRect().toJSON();
        const date = card.querySelector('.item-modified');
        return {card:card.getBoundingClientRect().toJSON(), name:rect('.list-name'),
            date:rect('.item-modified'), detail:rect('.list-duration, .list-file-type'),
            dateFits:date.scrollWidth <= date.clientWidth};
    })`);
    function checkColumns(items) {
        assert.ok(items.length);
        for (const {card, name, date, detail, dateFits} of items) {
            assert.ok(date.left >= name.right, 'Modified date has its own column after the name');
            assert.ok(date.top < name.bottom && date.bottom > name.top, 'Name and date share a row');
            assert.ok(date.right <= card.right && dateFits, 'The complete date fits inside the row');
            assert.ok(!detail || detail.right <= date.left, 'File type and duration precede the date column');
            assert.ok(Math.abs(date.right - items[0].date.right) < 1, 'Date columns align across item types');
        }
    }
    await browser.start('/?compact=1');
    await waitFor("document.querySelector('.list-item .item-modified[datetime]') && !document.getElementById('grid-viewport').matches('[aria-busy=true]')");
    checkColumns(await rows());
    await screenshot('list-dates-desktop');

    await open('/?compact=1&folder=Mixed');
    await waitFor("document.querySelectorAll('.list-item .item-modified[datetime]').length === 4");
    checkColumns(await rows());
    await screenshot('list-dates-video');

    await open('/?compact=1&folder=Other%20files');
    await waitFor("document.querySelector('.other-files-toggle')");
    await evaluate("document.querySelector('.other-files-toggle').click()");
    await waitFor("document.querySelectorAll('.list-item .item-modified[datetime]').length === 2");
    checkColumns(await rows());

    // Wrapping names must remain inside their virtual rows at both breakpoints.
    await open('/?compact=1&folder=Names');
    await waitFor("document.querySelector('.list-item .item-modified[datetime]')");
    for (const width of [701, 700, 390, 320, 1440]) {
        await call('Emulation.setDeviceMetricsOverride', {width, height:900, deviceScaleFactor:1, mobile:false});
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const items = await rows();
        for (const {card, name, date, dateFits} of items) {
            assert.ok(name.bottom <= card.bottom && date.bottom <= card.bottom, `Row fits its content at ${width}px`);
            assert.ok(dateFits, `Full modified date stays visible at ${width}px`);
            if (width <= 700) {
                assert.ok(date.top >= name.bottom, 'Narrow rows stack the date beneath the name');
                assert.ok(Math.abs(date.left - name.left) < 1, 'Stacked dates align with the name');
            }
        }
        if (width > 700) checkColumns(items);
        assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'List has no horizontal overflow');
        if (width === 390) await screenshot('list-dates-mobile');
    }
}
