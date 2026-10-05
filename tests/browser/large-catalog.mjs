import assert from 'node:assert/strict';
import {connectBrowser} from './harness.mjs';

const [port, base] = process.argv.slice(2);
const browser = await connectBrowser(port, base);
const {evaluate, waitFor} = browser;
try {
    await browser.start('/?folder=Large.cbz&compact=1&filter=page30999');
    await waitFor("document.querySelector('.card[data-path=\"Large.cbz/page30999.jpg\"] .item-modified[datetime]')");
    await evaluate("import('/gallery.js').then(({app}) => window.testApp = app)");
    assert.equal(await evaluate('testApp.grid.directory.listing.images.length'), 31000);
    assert.equal(await evaluate("document.querySelectorAll('#grid .card').length"), 1);
    const index = await evaluate("fetch('/api/folder?path=Large.cbz').then(response=>response.json())");
    // The server cannot retain this index, so the second request rebuilds it.
    const facts = await evaluate(`fetch('/api/folder/entries', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({path:'Large.cbz', revision:${JSON.stringify(index.revision)},
            items:[{name:'page00000.jpg',type:'image'},{name:'page30999.jpg',type:'image'}]})}).then(response=>response.json())`);
    assert.equal(facts.entries.length, 2);
    assert.equal(facts.entries[1].status, 'ready');
    await evaluate("document.querySelector('#sort-popover input[value=modified]').click()");
    await waitFor("testApp.grid.directory && !testApp.grid.directory.preparation && !testApp.grid.loadingFolder && testApp.state.sort === 'modified'");
    await waitFor("document.querySelector('.card[data-path=\"Large.cbz/page30999.jpg\"] .item-modified[datetime]')");
    assert.equal(await evaluate('testApp.grid.directory.listing.images.length'), 31000);
    assert.ok(await evaluate("import('/static/data/api.js').then(module=>module.entries.records.values.size <= 60)"));
    assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
    console.log('Large archive browser checks passed: 31,000 members with index and view retention disabled');
} finally { browser.close(); }
