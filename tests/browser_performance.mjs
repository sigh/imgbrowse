/** Exercise real browser caches and bounded windows with the --performance fixture. */
import assert from 'node:assert/strict';
const [port, base] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, {once: true}));
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
});
function call(method, params = {}) {
    return new Promise((resolve, reject) => {
        pending.set(++sequence, {resolve, reject}); socket.send(JSON.stringify({id: sequence, method, params}));
    });
}
async function evaluate(expression) {
    const result = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
async function wait(expression) {
    for (let i = 0; i < 200; i++) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error('Timed out: ' + expression);
}
await call('Page.enable'); await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
await call('Page.navigate', {url:base + '/?folder=Large&recursive=1&compact=1'});
await wait("document.readyState === 'complete' && document.querySelector('.list-item')");
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
await evaluate("if(!testApp.viewer.thumbnailsVisible)testApp.viewer.toggleThumbnails()");
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
const media = await evaluate("import('/static/media-cache.js').then(module=>({bytes:module.originals.bytes,entries:module.originals.values.size}))");
assert.ok(media.bytes <= 96*1024*1024 && media.entries <=4);
console.log('Performance browser checks passed:',JSON.stringify({grid,strip,media}));
socket.close();
