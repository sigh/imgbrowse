/** End-to-end checks through Chrome's DevTools protocol; no browser library needed. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

const [debugPort, base, screenshots] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, {once: true}));
let sequence = 0;
const pending = new Map();
const exceptions = [];
const requests = [];
const held = [];
let pauseImages = false;
let pauseWalk = false;
socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
    if (message.method === 'Fetch.requestPaused') {
        const {requestId, request} = message.params;
        if ((pauseImages && request.url.includes('/image?')) || (pauseWalk && request.url.includes('/api/walk'))) held.push(requestId);
        else call('Fetch.continueRequest', {requestId}).catch(() => {});
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
    else callback.resolve(message.result);
});

function call(method, params = {}) {
    return new Promise((resolve, reject) => {
        pending.set(++sequence, {resolve, reject});
        socket.send(JSON.stringify({id: sequence, method, params}));
    });
}
async function evaluate(expression) {
    const response = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
}
async function waitFor(expression) {
    for (let attempt = 0; attempt < 160; attempt++) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out: ' + expression + '\n' + JSON.stringify(exceptions) + '\n' + await evaluate("document.getElementById('grid-status')?.textContent"));
}
async function open(path) {
    const url = new URL(path, base).href;
    await evaluate('window.__leavingPage = true');
    await call('Page.navigate', {url});
    await waitFor("!window.__leavingPage && document.readyState === 'complete'");
}
const click = id => evaluate(`{ const button=document.getElementById(${JSON.stringify(id)}); button.focus(); button.click(); }`);
const imageIs = path => `new URLSearchParams(location.search).get('image') === ${JSON.stringify(path)}`;
const waitImage = path => waitFor(imageIs(path));
const key = (key, repeat = false) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({key, repeat})}))`);
const wheel = async deltaY => { await call('Input.dispatchMouseEvent', {type:'mouseWheel', x:700, y:350, deltaX:0, deltaY}); await new Promise(resolve => setTimeout(resolve, 70)); };
async function screenshot(name) {
    if (screenshots) writeFileSync(join(screenshots, name + '.png'), Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
}


const readyImage = path => waitFor(`document.getElementById('viewer-image').dataset.path === ${JSON.stringify(path)} && !document.getElementById('viewer-zoom').disabled`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const position = () => evaluate("({top:document.getElementById('viewer-canvas').scrollTop,max:document.getElementById('viewer-canvas').scrollHeight-document.getElementById('viewer-canvas').clientHeight})");
const viewerUrl = (image, size = 'page', folder = 'Album') => '/?' + new URLSearchParams({folder, image, size});
const first = 'Album/Chapter 1/page2.jpg';
const second = 'Album/Chapter 1/page10.jpg';
const last = 'Album/Chapter 2/deep/page1.jpg';
await call('Runtime.enable');
await call('Network.enable');
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
await open('/');
await waitFor("document.querySelectorAll('.card').length > 5");
assert.ok(await evaluate("document.querySelectorAll('.card').length < 50"));
await screenshot('grid');

// Filtering is immediate and makes no directory request. Both presentations preserve an item.
const folderRequests = () => requests.filter(url => url.includes('/api/folder')).length;
const countBeforeFilter = folderRequests();
await evaluate("{ const input=document.getElementById('filter'); input.value='root12'; input.dispatchEvent(new Event('input')); }");
await waitFor("document.getElementById('summary').textContent.includes('11 matches')");
assert.equal(folderRequests(), countBeforeFilter);
await click('refresh');
await waitFor("!document.getElementById('refresh').disabled");
assert.equal(folderRequests(), countBeforeFilter + 1);
assert.ok(await evaluate("document.getElementById('summary').textContent.includes('11 matches')"));
await evaluate("{ const input=document.getElementById('filter'); input.value=''; input.dispatchEvent(new Event('input')); }");
await waitFor("!new URLSearchParams(location.search).has('filter')");
await evaluate("document.getElementById('grid-viewport').scrollTop = 1800");
await pause(100);
const anchor = await evaluate('history.state.position.path');
await click('layout-list');
await waitFor("document.querySelector('.list-item')");
assert.equal(await evaluate('history.state.position.path'), anchor);
assert.ok(await evaluate("[...document.querySelectorAll('.list-name')].some(node=>node.textContent=== " + JSON.stringify(anchor) + ")"));
assert.equal(await evaluate("document.querySelectorAll('#grid img').length"), 0);
await screenshot('list');
const historyBeforeSameLayout = await evaluate('history.length');
await click('layout-list');
assert.equal(await evaluate('history.length'), historyBeforeSameLayout);

// Back preserves folder position; close uses the opener entry and Forward reopens the viewer.
await open('/?folder=Album');
await waitFor("document.querySelectorAll('.card').length === 2");
await click('read-folder');
await readyImage(first);
await click('viewer-next');
await readyImage(second);
await click('viewer-close');
await waitFor("document.getElementById('viewer').hidden");
assert.equal(await evaluate('document.activeElement.id'), 'read-folder');
await evaluate('history.forward()');
await readyImage(second);
await evaluate('history.back()');
await waitFor("document.getElementById('viewer').hidden");
await click('scope-all');
await waitFor("document.querySelectorAll('.folder-heading a').length === 2");
await evaluate("document.querySelector('.folder-heading a').click()");
await waitFor("new URLSearchParams(location.search).get('folder') === 'Album/Chapter 1'");
assert.equal(await evaluate("document.getElementById('scope-all').getAttribute('aria-pressed')"), 'true');

// Recursive paging and Back reuse discovered items without rebuilding the traversal.
await open('/?recursive=1');
await waitFor("document.getElementById('summary').textContent.includes('60 images')");
for (let page=0; page<5; page++) {
    await evaluate("document.getElementById('grid-viewport').scrollTop = document.getElementById('grid-viewport').scrollHeight");
    await pause(100);
}
await waitFor("document.getElementById('summary').textContent === '168 images'");
await evaluate("document.getElementById('grid-viewport').scrollTop = 1800");
await pause(100);
const recursiveAnchor = await evaluate('history.state.position.path');
await click('layout-list');
await pause(100);
assert.equal(await evaluate('history.state.position.path'),recursiveAnchor);
await evaluate('history.back()');
await waitFor("document.getElementById('layout-previews').getAttribute('aria-pressed') === 'true'");
assert.equal(await evaluate('history.state.position.path'),recursiveAnchor);

// Fit page never upscales a small photo. Native wheel events turn fitted pages.
await open(viewerUrl('root2.jpg', 'page', ''));
await readyImage('root2.jpg');
assert.ok(await evaluate("document.getElementById('viewer-image').width <= 320"));
await call('Input.dispatchMouseEvent', {type:'mouseWheel', x:700,y:350,deltaX:0,deltaY:120});
await readyImage('root3.jpg');
await open(viewerUrl(first));
await readyImage(first);
await screenshot('viewer');
await click('viewer-next');
await readyImage(second);
await click('viewer-next');
await readyImage(last);
const heightAtEnd = await evaluate("document.getElementById('viewer-image').height");
await click('viewer-next');
await waitFor("document.getElementById('viewer-next').getAttribute('aria-label') === 'Go to first image'");
assert.equal(await evaluate("document.getElementById('viewer-image').height"), heightAtEnd);
await key('ArrowRight', true);
assert.ok(await evaluate(imageIs(last)));
await key('ArrowRight');
await readyImage(first);
assert.equal(await evaluate("document.getElementById('viewer-wrap')"), null);

// Edge gestures consume momentum; reverse wheel entry is at the previous image's bottom.
await key('w');
await waitFor("new URLSearchParams(location.search).get('size') === 'width'");
assert.ok((await position()).max > 1000);
await evaluate("document.getElementById('viewer-canvas').scrollTop = 400");
await wheel(120);
assert.ok((await position()).top > 400);
assert.ok(await evaluate(imageIs(first)));
await wheel(100000);
assert.equal((await position()).top, (await position()).max);
await wheel(70);
await wheel(20);
assert.ok(await evaluate(imageIs(first)));
await pause(300);
await wheel(100);
await readyImage(second);
assert.equal((await position()).top, 0);
await wheel(20);
assert.equal((await position()).top, 0);
await pause(300);
await wheel(-100);
await readyImage(first);
assert.ok(Math.abs((await position()).top - (await position()).max) <= 2);
await click('viewer-next');
await readyImage(second);
await click('viewer-prev');
await readyImage(first);
assert.equal((await position()).top, 0);

// Zoom preserves the source image point; manual sizing survives navigation and URLs.
await evaluate("document.getElementById('viewer-canvas').scrollTop = 450");
const sourcePoint = () => evaluate("(()=>{const c=document.getElementById('viewer-canvas'),i=document.getElementById('viewer-image'),b=c.getBoundingClientRect(),r=i.getBoundingClientRect();return (b.top+c.clientHeight/2-r.top)/(r.width/i.naturalWidth);})()");
const beforeZoom = await sourcePoint();
await click('viewer-zoom');
await click('viewer-zoom-in');
await click('viewer-zoom');
assert.ok(Math.abs(await sourcePoint() - beforeZoom) < 3);
await evaluate("document.getElementById('viewer-canvas').scrollLeft = 0");
await call('Input.dispatchMouseEvent',{type:'mouseWheel',x:700,y:350,deltaX:120,deltaY:0});
await pause(150);
assert.ok(await evaluate("document.getElementById('viewer-canvas').scrollLeft > 0"));
const size = await evaluate("document.getElementById('viewer-zoom').dataset.size");
assert.equal(await evaluate("new URLSearchParams(location.search).get('size')"), size);
await click('viewer-next');
await readyImage(second);
assert.equal(await evaluate("document.getElementById('viewer-zoom').dataset.size"), size);
await evaluate("document.getElementById('viewer-stage').dispatchEvent(new WheelEvent('wheel',{deltaY:100,ctrlKey:true,cancelable:true}))");
assert.ok(await evaluate(imageIs(second)));

await click('viewer-thumbnails');
await waitFor("document.querySelectorAll('#viewer-strip button').length === 3");
// Hidden filmstrip cancels preview work and does not request thumbnails on later pages.
await evaluate("document.getElementById('viewer-canvas').scrollTop = 450");
const beforeStrip = await sourcePoint();
await click('viewer-thumbnails');
await pause(150);
assert.ok(Math.abs(await sourcePoint() - beforeStrip) < 3);
const thumbnailsBefore = requests.filter(url=>url.includes('/thumbnail?')).length;
await click('viewer-next');
await readyImage(last);
await pause(300);
assert.equal(requests.filter(url=>url.includes('/thumbnail?')).length, thumbnailsBefore);
await key('Escape');
await waitFor("document.getElementById('viewer').hidden");
assert.ok(await evaluate("document.activeElement.getClientRects().length > 0"));

// Delayed originals leave the old page stable; cancelled work cannot reopen a closed viewer.
await open(viewerUrl(first));
await readyImage(first);
await call('Fetch.enable', {patterns:[{urlPattern:'*/image?*'},{urlPattern:'*/api/walk'}]});
pauseImages = true;
await click('viewer-next');
await waitImage(second);
await waitFor("document.getElementById('viewer-status').textContent.includes('Loading')");
assert.equal(await evaluate("document.getElementById('viewer-image').dataset.path"), first);
assert.equal(await evaluate("document.getElementById('viewer-zoom').disabled"), false);
await click('viewer-zoom');
assert.equal(await evaluate("document.getElementById('size-menu').hidden"), false);
await evaluate("document.querySelector('[data-size=width]').click()");
assert.equal(await evaluate("new URLSearchParams(location.search).get('size')"), 'width');
assert.equal(await evaluate("document.getElementById('viewer-image').dataset.path"), first);

await key('Escape');
await waitFor("document.getElementById('viewer').hidden");
pauseImages = false;
for (const requestId of held.splice(0)) await call('Fetch.continueRequest',{requestId}).catch(()=>{});
await pause(150);
assert.ok(await evaluate("document.getElementById('viewer').hidden"));

// A delayed walk isn't an end boundary. Empty and single-image collections have no dead controls.
pauseWalk = true;
await open('/?folder=Empty&viewer=1');
await waitFor("document.getElementById('viewer-status').textContent.includes('Finding')");
assert.ok(await evaluate("document.getElementById('viewer-next').disabled"));
pauseWalk = false;
for (const requestId of held.splice(0)) await call('Fetch.continueRequest',{requestId}).catch(()=>{});
await waitFor("document.getElementById('viewer-status').textContent.includes('No images')");
assert.ok(await evaluate("document.getElementById('viewer-zoom').disabled"));
await call('Fetch.disable');
await open('/?folder=Single&viewer=1');
await readyImage('Single/only.jpg');
await waitFor("document.getElementById('viewer-prev').disabled && document.getElementById('viewer-next').disabled");

await open(viewerUrl('Album/Chapter 1/missing.jpg'));
await waitFor("!document.getElementById('viewer-retry').hidden");
assert.ok(await evaluate("!document.getElementById('viewer-next').disabled"));
await click('viewer-next');
await readyImage(first);
await click('viewer-refresh');
await readyImage(first);

// Continued wheel input advances fitted pages without requiring a pause after every image.
await open(viewerUrl('root2.jpg', 'page', ''));
await readyImage('root2.jpg');
for (let i=0; i<12; i++) await wheel(60);
await pause(100);
assert.ok(await evaluate("Number(new URLSearchParams(location.search).get('image').match(/root(\\d+)/)[1]) >= 4"));

// A visible strip retains buttons and their order as pages turn; discovery is demand driven.
await click('viewer-thumbnails');
await waitFor("document.querySelectorAll('#viewer-strip button').length >= 32");
await evaluate("window.retainedThumbnail=document.querySelector('#viewer-strip button')");
const stripPaths = await evaluate("Array.from(document.querySelectorAll('#viewer-strip button'),button=>button.dataset.path)");
await click('viewer-next');
await pause(200);
assert.ok(await evaluate('window.retainedThumbnail.isConnected'));
assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#viewer-strip button'),button=>button.dataset.path)"),stripPaths);
await evaluate("document.getElementById('viewer-strip').scrollLeft=100000");
await waitFor(`document.querySelectorAll('#viewer-strip button').length > ${stripPaths.length}`);
assert.ok(await evaluate("document.querySelectorAll('#viewer-strip button').length < 165"));
await screenshot('thumbnails');
await click('viewer-zoom');
assert.equal(await evaluate("document.querySelectorAll('#size-menu > button').length"),3);
await screenshot('sizing');
await key('Escape');
assert.ok(await evaluate("document.getElementById('size-menu').hidden && !document.getElementById('viewer').hidden"));
await click('viewer-thumbnails');

// Breadcrumbs leave the reader for the image's actual folder, preserving the grid layout.
await open(viewerUrl(first));
await readyImage(first);
await evaluate("document.querySelector('#viewer-path a:last-child').click()");
await waitFor("document.getElementById('viewer').hidden && document.querySelectorAll('.card').length === 2");
assert.equal(await evaluate("new URLSearchParams(location.search).get('folder')"),'Album/Chapter 1');
assert.equal(await evaluate("document.querySelector('#breadcrumbs [aria-current]').tagName"),'SPAN');

// ZIP/CBZ archives behave like folders, with direct links and natural page order.
await open('/?folder=Packed.cbz');
await waitFor("document.querySelectorAll('.card').length === 3");
assert.equal(await evaluate("document.querySelector('#breadcrumbs [aria-current]').textContent"),'Packed.cbz');
await click('read-folder');
await readyImage('Packed.cbz/page2.jpg');
await click('viewer-next');
await readyImage('Packed.cbz/page10.jpg');
await click('viewer-next');
await readyImage('Packed.cbz/Chapter 3/page1.jpg');
await open(viewerUrl('Packed.cbz/Chapter 3/page1.jpg', 'page', 'Packed.cbz'));
await readyImage('Packed.cbz/Chapter 3/page1.jpg');
await evaluate("document.querySelector('#viewer-path a:last-child').click()");
await waitFor("document.getElementById('viewer').hidden && new URLSearchParams(location.search).get('folder') === 'Packed.cbz/Chapter 3'");

// Special filenames and narrow screens retain controls, full names, and a visible focus target.
await open(viewerUrl('Odd & #/a ?#%.jpg', 'page', 'Odd & #'));
await readyImage('Odd & #/a ?#%.jpg');
await call('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
await open(viewerUrl(first,'width'));
await readyImage(first);
assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
await screenshot('mobile-viewer');
await key('Tab');
assert.ok(await evaluate("document.activeElement.getClientRects().length > 0"));
await open('/?folder=Names&compact=1');
await waitFor("document.querySelector('.list-name')");
assert.ok(await evaluate("document.querySelector('.list-name').getBoundingClientRect().bottom <= document.querySelector('.list-item').getBoundingClientRect().bottom"));
assert.ok(await evaluate("document.querySelector('.list-read').getBoundingClientRect().right < document.querySelector('.list-name').getBoundingClientRect().left"));
assert.equal(await evaluate("document.querySelector('.list-item').firstElementChild.className"),'list-read');
await screenshot('long-names');
assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
console.log('Browser smoke passed: navigation, history, filtering, layout anchors, gesture edges, zoom anchors, slow loads, cancellation, filmstrip, URLs, empty/single images, responsive controls.');
socket.close();
