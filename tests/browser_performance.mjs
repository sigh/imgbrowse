/** Exercise real browser caches and bounded windows with the --performance fixture. */
import assert from 'node:assert/strict';
import {connectBrowser} from './browser-harness.mjs';
import {ScreenMode, ReadingLayout, ImageSize} from '../image_browser/web/static/state.js';
const [port, base] = process.argv.slice(2);
const browser = await connectBrowser(port, base);
const {evaluate, waitFor: wait} = browser;
await browser.start('/?folder=Large&view=grid');
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
const grid = await evaluate("({count:testApp.grid.directory.window.paths.length,first:testApp.grid.directory.window.paths[0],nodes:document.querySelectorAll('.card').length})");
assert.ok(grid.count <= 2000 && grid.first !== 'Large/page0.jpg',JSON.stringify(grid));
assert.ok(grid.nodes < 100);
await evaluate(`(async()=>{
 const grid=testApp.grid;
 while(grid.loadingPage) await new Promise(resolve=>setTimeout(resolve,5));
 grid.viewport.scrollTop=0;
 await grid.loadPage(true);
})()`);
await wait(`testApp.grid.directory.window.paths[0] !== ${JSON.stringify(grid.first)}`);
assert.ok(await evaluate('testApp.grid.directory.window.paths.length <= 2000'));

await evaluate("testApp.mediaLink('Large/page0.jpg', 'Large').click()");
await wait("document.getElementById('viewer-image').dataset.path==='Large/page0.jpg'");
await wait("testApp.viewer.navigation.prefetchPath==='Large/page1.jpg'");
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
await evaluate("testApp.mediaLink('Large/page5.jpg', 'Large').click()");
await wait("document.getElementById('viewer-image').dataset.path === 'Large/page5.jpg'");
await evaluate(`testApp.setMode(${JSON.stringify(ScreenMode.OVERVIEW)})`);
await wait("testApp.state.mode === 'overview' && document.querySelector('.card[data-path=\"Large/page5.jpg\"]')");
assert.equal(await evaluate('testApp.state.image'), 'Large/page5.jpg');
assert.ok(await evaluate('testApp.grid.directory.window.paths.length <= 2000'));
await evaluate(`testApp.setMode(${JSON.stringify(ScreenMode.VIEW)})`);
await wait("document.getElementById('viewer-image').dataset.path === 'Large/page5.jpg' && !document.getElementById('viewer-image').hidden");
await evaluate(`testApp.setMode(${JSON.stringify(ScreenMode.BROWSE)})`);
await wait("testApp.state.mode === 'browse'");

// A direct middle-of-collection entry and sustained reading keep paths and originals bounded.
await browser.open(browser.viewerUrl('Large/page1200.jpg', ImageSize.DEFAULT, 'Large', ReadingLayout.SCROLL));
await browser.readyImage('Large/page1200.jpg');
await evaluate("import('/gallery.js').then(({app})=>window.testApp=app)");
await wait("testApp.viewer.continuous.paths.length > 8");
assert.ok(await evaluate("testApp.viewer.continuous.paths.every(path=>Number(path.slice('Large/page'.length,-4))>1180)"), 'Scroll starts around the selected image without scanning from the start');
for (let index=1201; index<=1250; index++) {
    await evaluate('testApp.viewer.requestMove(false)');
    await browser.readyImage(`Large/page${index}.jpg`);
    assert.ok(await evaluate("document.querySelectorAll('.reader-item').length <= 32 && document.querySelectorAll('.reader-item img').length <= 5"));
}
const column = await evaluate("({paths:testApp.viewer.continuous.paths.length,first:testApp.viewer.continuous.paths[0],images:document.querySelectorAll('.reader-item img').length})");
assert.ok(column.paths <= 32 && column.first !== 'Large/page1192.jpg',JSON.stringify(column));
// Reverse across the discarded prefix; the same source point survives rediscovery.
const atTop = () => evaluate("(()=>{const image=document.getElementById('viewer-image'),canvas=document.getElementById('viewer-canvas');return (canvas.getBoundingClientRect().top-image.getBoundingClientRect().top)/(image.width/image.naturalWidth)})()");
for (let index=1249; index>=1200; index--) {
    await evaluate('testApp.viewer.requestMove(true)');
    await browser.readyImage(`Large/page${index}.jpg`);
    assert.ok(Math.abs(await atTop())<2,'Previous navigation retains the selected page at the top while preceding items are inserted');
}
assert.ok(await evaluate('testApp.viewer.continuous.paths.length <= 32'));
const continuousMedia = await evaluate("import('/static/media-cache.js').then(module=>({bytes:module.originals.bytes,entries:module.originals.values.size,pending:module.originals.pending.size}))");
assert.ok(continuousMedia.bytes <= 96*1024*1024 && continuousMedia.entries <= 4);
await evaluate(`testApp.setMode(${JSON.stringify(ScreenMode.BROWSE)})`);
await wait("testApp.state.mode === 'browse' && document.querySelectorAll('.reader-item').length === 0");
assert.equal(browser.exceptions.length,0,JSON.stringify(browser.exceptions));
console.log('Performance browser checks passed:' ,JSON.stringify({grid,strip,media,column,continuousMedia}));
browser.close();
