/** Run independent browser journeys against the temporary fixture collection. */
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {connectBrowser} from './harness.mjs';

const [port, base, screenshots, fixtureRoot] = process.argv.slice(2);
const browser = await connectBrowser(port, base, screenshots);
const fixtures = {fixtureRoot, absoluteRoot: realpathSync(fixtureRoot),
    first: 'Album/Chapter 1/page2.jpg', second: 'Album/Chapter 1/page10.jpg',
    last: 'Album/Chapter 2/deep/page1.jpg'};
const journeys = ['browse', 'navigation-return', 'reader', 'scroll', 'loading', 'strip-archives', 'responsive', 'video', 'keyboard', 'failures', 'tree', 'other-files', 'sorting', 'catalog-contracts', 'list-layout', 'strip-anchoring', 'sidebar'];
const selected = process.env.SMOKE_JOURNEY;
assert.ok(!selected || journeys.includes(selected), 'Unknown SMOKE_JOURNEY: ' + selected);
try {
    for (const name of journeys.filter(name => !selected || name === selected)) {
        const {run} = await import('./journeys/' + name + '.mjs');
        try { await run(browser, fixtures); }
        catch (error) { error.message = name + ': ' + error.message; throw error; }
    }
    assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
    assert.equal(browser.requests.filter(url => new URL(url).pathname === '/api/preview').length, 0);
    console.log('Browser smoke passed: ' + (selected || journeys.join(', ')));
} finally {
    browser.close();
}
