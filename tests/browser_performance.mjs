/** Exercise real browser caches and bounded windows with the --performance fixture. */
import assert from 'node:assert/strict';
import {connectBrowser} from './browser-harness.mjs';
import {ScreenMode} from '../image_browser/web/static/state.js';
const [port, base] = process.argv.slice(2);
const browser = await connectBrowser(port, base);
const {call, evaluate, waitFor: wait} = browser;
await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
await call('Page.navigate', {url:base + '/?folder=Large&view=grid'});
await wait("document.readyState === 'complete' && document.querySelector('.card')");
await evaluate("import('/gallery.js').then(module=>window.testApp=module.app)");
await evaluate(`(async()=>{
 const grid=testApp.grid;
 for(let i=0;i<42;i++) {
  while(grid.loadingPage) await new Promise(resolve=>setTimeout(resolve,5));
  grid.viewport.scrollTop=grid.viewport.scrollHeight;
  await grid.loadPage();
 }
})()`);
const grid = await evaluate("({count:testApp.grid.directory.images.length,first:testApp.grid.directory.images[0].path,nodes:document.querySelectorAll('.card').length})");
assert.ok(grid.count <= 2000 && grid.first !== 'Large/page0.jpg',JSON.stringify(grid));
assert.ok(grid.nodes < 100);
await evaluate(`(async()=>{
 const grid=testApp.grid;
 while(grid.loadingPage) await new Promise(resolve=>setTimeout(resolve,5));
 grid.viewport.scrollTop=0;
 await grid.loadPage(true);
})()`);
await wait(`testApp.grid.directory.images[0].path !== ${JSON.stringify(grid.first)}`);
assert.ok(await evaluate('testApp.grid.directory.images.length <= 2000'));

await evaluate("testApp.openViewer('Large/page0.jpg','Large')");
await wait("document.getElementById('viewer-image').dataset.path==='Large/page0.jpg'");
await wait("testApp.viewer.prefetchPath==='Large/page1.jpg'");
await wait("import('/static/media-cache.js').then(module=>module.originals.values.has('Large/page1.jpg'))");
await evaluate("testApp.viewer.requestMove(false)");
await wait("document.getElementById('viewer-image').dataset.path==='Large/page1.jpg'");
await evaluate(`(async()=>{
 const strip=testApp.viewer.filmstrip;
 for(let i=0;i<78;i++) {
  while(strip.edges.some(edge=>edge.loading))await new Promise(resolve=>setTimeout(resolve,5));
  strip.container.scrollLeft=strip.container.scrollWidth;
  await strip.discover(strip.edges[1]);
 }
})()`);
const strip = await evaluate("({paths:testApp.viewer.filmstrip.paths.length,nodes:document.querySelectorAll('#viewer-strip button').length})");
assert.ok(strip.paths <= 2048,JSON.stringify(strip));
assert.ok(strip.nodes < 40,JSON.stringify(strip));
// Tab still reaches the current media after discovery evicts it from the path window.
assert.ok(await evaluate("!testApp.viewer.filmstrip.paths.includes(testApp.state.image) && testApp.viewer.filmstrip.container.tabIndex === 0"));
await evaluate("document.querySelector('.strip-resizer').focus()");
await browser.nativeKey('Tab', 9);
await wait("document.activeElement.dataset.path === testApp.state.image && document.getElementById('viewer-strip').contains(document.activeElement)");
assert.equal(await evaluate("document.querySelectorAll('#viewer-strip button[tabindex=\"0\"]').length"), 1);

const media = await evaluate("import('/static/media-cache.js').then(module=>({bytes:module.originals.bytes,entries:module.originals.values.size}))");
assert.ok(media.bytes <= 96*1024*1024 && media.entries <=4);
// Return from an image outside the retained grid window without scanning from the start.
await evaluate("testApp.openViewer('Large/page5.jpg', 'Large')");
await wait("document.getElementById('viewer-image').dataset.path === 'Large/page5.jpg'");
await evaluate("testApp.setMode('overview')");
await wait("testApp.state.mode === 'overview' && document.querySelector('.card[data-path=\"Large/page5.jpg\"]')");
assert.equal(await evaluate('testApp.state.image'), 'Large/page5.jpg');
assert.ok(await evaluate('testApp.grid.directory.images.length <= 2000'));
await evaluate("testApp.setMode('view')");
await wait("document.getElementById('viewer-image').dataset.path === 'Large/page5.jpg' && !document.getElementById('viewer-image').hidden");
await evaluate(`testApp.setMode(${JSON.stringify(ScreenMode.BROWSE)})`);
await wait("testApp.state.mode === 'browse'");
console.log('Performance browser checks passed:' ,JSON.stringify({grid,strip,media}));
browser.close();
