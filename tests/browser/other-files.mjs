import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export async function run(browser, fixtures) {
    const {call, evaluate, waitFor, open, click, nativeKey, screenshot, requests} = browser;
    const expanded = () => evaluate("document.querySelector('.other-files-toggle')?.getAttribute('aria-expanded')");
    const toggle = () => evaluate("document.querySelector('.other-files-toggle').click()");
    const filter = value => evaluate(`document.getElementById('filter').value=${JSON.stringify(value)};document.getElementById('filter').dispatchEvent(new Event('input'))`);
    await browser.start('/?folder=Single');
    await waitFor("document.querySelector('.card') && !document.getElementById('grid-viewport').getAttribute('aria-busy').includes('true')");
    assert.equal(await evaluate("document.querySelector('.other-files-heading')"), null, 'Supported-only folders have no extra section');

    await open('/?folder=Other+files');
    await waitFor("document.querySelector('.other-files-toggle')");
    assert.equal(await expanded(), 'false');
    assert.equal(await evaluate("document.getElementById('grid-status').textContent"), 'No supported media.');
    assert.equal(await evaluate("document.querySelectorAll('.other-file').length"), 0);
    const openingUrl = await evaluate('location.href');
    await toggle();
    await waitFor("document.querySelectorAll('.other-file').length === 2");
    assert.equal(await evaluate('location.href'), openingUrl, 'Disclosure does not navigate or alter collection identity');
    assert.ok(await evaluate("document.querySelectorAll('.other-file.list-item').length === 2 && document.getElementById('layout-previews').getAttribute('aria-pressed') === 'true'"), 'Other files stay compact within Preview layout');
    assert.ok(await evaluate("document.querySelector('.other-files-heading').getBoundingClientRect().top > document.getElementById('grid-status').getBoundingClientRect().bottom"), 'Empty-media feedback precedes the disclosure');
    await screenshot('other-files-only');

    await evaluate("document.querySelector('.other-file[data-path=\"Other files/sunrise.heic\"] button').click()");
    await waitFor("document.getElementById('metadata-title').textContent === 'sunrise.heic' && document.querySelector('.copy-path')");
    assert.equal(await evaluate("document.getElementById('metadata-status').textContent"), 'This file type cannot be viewed.');
    assert.ok(await evaluate("document.getElementById('item-path').textContent.includes('Other files') && !document.getElementById('item-path').textContent.includes('sunrise')"), 'File inspection preserves browsing context');
    await evaluate("window.copiedPath=null; Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async path=>{window.copiedPath=path;}}});document.querySelector('.copy-path').click()");
    await waitFor('copiedPath !== null');
    assert.equal(await evaluate('copiedPath'), join(fixtures.absoluteRoot, 'Other files/sunrise.heic'));
    await screenshot('other-file-info');
    await nativeKey('Escape', 27);
    assert.equal(await evaluate("document.activeElement.closest('.card')?.dataset.path"), 'Other files/sunrise.heic');
    await filter('sunrise');
    await waitFor("document.querySelectorAll('.other-file').length === 1 && document.querySelector('.other-files-toggle').textContent.includes('1 matching')");
    await toggle();
    assert.equal(await expanded(), 'false');
    assert.equal(await evaluate("document.getElementById('filter').value"), 'sunrise');
    await toggle();
    await click('layout-list');
    await waitFor("document.getElementById('grid-viewport').classList.contains('compact')");
    assert.equal(await evaluate("document.querySelectorAll('.other-file').length"), 1);
    await call('Emulation.setDeviceMetricsOverride', {width:320,height:844,deviceScaleFactor:1,mobile:false});
    await waitFor("document.querySelector('.other-file').getBoundingClientRect().width < 320");
    assert.ok(await evaluate("document.documentElement.scrollWidth === innerWidth && document.getElementById('grid-viewport').scrollWidth === document.getElementById('grid-viewport').clientWidth"));
    await screenshot('other-files-mobile');
    assert.equal(requests.filter(url => {
        const request = new URL(url);
        return ['/thumbnail', '/image', '/api/video'].includes(request.pathname) && request.searchParams.get('path')?.startsWith('Other files/');
    }).length, 0, 'Other files never request previews, originals or video extraction');

    await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await open('/?folder=Packed.cbz');
    await waitFor("document.querySelector('.other-files-toggle')");
    assert.equal(await expanded(), 'false', 'A new folder starts with its disclosure closed');
    await toggle();
    await waitFor("document.querySelectorAll('.other-file').length === 2");
    assert.ok(await evaluate("document.querySelectorAll('.card:not(.other-file)').length > 0"), 'Supported archive contents stay above the separate list');
    await evaluate("document.querySelector('.other-file[data-path=\"Packed.cbz/clip.mp4\"] button').click()");
    await waitFor("document.getElementById('metadata-status').textContent === 'Videos inside archives cannot be viewed.'");
    assert.ok(await evaluate("document.querySelector('.metadata-path-text').textContent.endsWith('/Packed.cbz/clip.mp4')"));
    await nativeKey('Escape', 27);
    await click('overview-folder');
    await waitFor("document.getElementById('summary').textContent === '3 items'");
    assert.equal(await evaluate("document.querySelector('.other-files-heading')"), null, 'Overview remains a media collection');

    const large = join(fixtures.fixtureRoot, 'Many other files');
    mkdirSync(large);
    for (let index=0; index<1000; index++) {
        const extension = index===999 ? 'html' : index===998 ? 'markdown' : 'txt';
        writeFileSync(join(large, `notes${index}.${extension}`), 'notes');
    }
    await open('/?folder=Many+other+files');
    await waitFor("document.querySelector('.other-files-toggle')?.textContent.includes('1000')");
    await toggle();
    assert.ok(await evaluate("document.querySelectorAll('.other-file').length < 40"), 'Expanded other-file lists reuse virtual rows');
    await evaluate("document.getElementById('grid-viewport').scrollTop = document.getElementById('grid-viewport').scrollHeight");
    await waitFor("document.querySelector('.other-file[data-path=\"Many other files/notes999.html\"]')");
    assert.ok(await evaluate("document.querySelectorAll('.other-file').length < 40"));
    assert.ok(await evaluate("[...document.querySelectorAll('.list-file-type')].every(value=>{const text=document.createRange();text.selectNodeContents(value);return text.getBoundingClientRect().width <= value.clientWidth-parseFloat(getComputedStyle(value).paddingRight)+1;})"), 'File types use their natural width without clipping');

    // Put a mixed folder's disclosure at the bottom of a short viewport before expanding it.
    await call('Emulation.setDeviceMetricsOverride', {width:320,height:400,deviceScaleFactor:1,mobile:false});
    await open('/?folder=Packed.cbz');
    await waitFor("document.querySelector('.card')");
    await evaluate("document.getElementById('grid-viewport').scrollTop=document.getElementById('grid-viewport').scrollHeight");
    await waitFor("document.querySelector('.other-files-toggle')?.getBoundingClientRect().bottom <= document.getElementById('grid-viewport').getBoundingClientRect().bottom");
    await toggle();
    await waitFor("document.querySelector('.other-file')");
    assert.ok(await evaluate("(()=>{const pane=document.getElementById('grid-viewport').getBoundingClientRect(),heading=document.querySelector('.other-files-heading').getBoundingClientRect(),file=document.querySelector('.other-file').getBoundingClientRect();return heading.top>=pane.top-1 && file.top>=pane.top && file.bottom<=pane.bottom;})()"), 'Expansion brings the heading and first opened row into view');
    assert.equal(await evaluate("document.activeElement.classList.contains('other-files-toggle')"), true);
    await screenshot('other-files-expanded-mobile');

    await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await open('/?folder=Mixed&compact=1');
    await waitFor("document.querySelector('[data-path=\"Mixed/2.webm\"] .list-duration')?.textContent");
    assert.ok(await evaluate("(()=>{const value=document.querySelector('.list-duration');value.textContent='123:45:56';const text=document.createRange();text.selectNodeContents(value);return text.getBoundingClientRect().width <= value.clientWidth-parseFloat(getComputedStyle(value).paddingRight)+1;})()"), 'Long video durations use their natural width without clipping');
    await open('/?folder=Empty');
    await waitFor("document.getElementById('grid-status').textContent === 'This folder is empty.'");
    assert.equal(await evaluate("document.querySelector('.other-files-heading')"), null);
}
