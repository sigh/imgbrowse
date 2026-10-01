/** End-to-end checks through Chrome's DevTools protocol; no browser library needed. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {readState, stateUrl} from '../image_browser/web/static/state.js';

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
async function evaluate(expression, userGesture = false) {
    const response = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, userGesture});
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
const imageIs = path => `import('/static/state.js').then(({readState}) => readState().image === ${JSON.stringify(path)})`;
const waitImage = path => waitFor(imageIs(path));
const key = (key, repeat = false) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({key, repeat})}))`);
async function nativeKey(key, code) {
    for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', {type, key, code: key, windowsVirtualKeyCode: code});
}
const wheel = async deltaY => { await call('Input.dispatchMouseEvent', {type:'mouseWheel', x:700, y:350, deltaX:0, deltaY}); await new Promise(resolve => setTimeout(resolve, 70)); };
async function screenshot(name) {
    if (screenshots) writeFileSync(join(screenshots, name + '.png'), Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
}


const readyImage = path => waitFor(`(() => { const image = document.getElementById('viewer-image'); return image?.dataset.path === ${JSON.stringify(path)} && !image.hidden && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0 && !document.getElementById('viewer-zoom').disabled; })()`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const position = () => evaluate("({top:document.getElementById('viewer-canvas').scrollTop,max:document.getElementById('viewer-canvas').scrollHeight-document.getElementById('viewer-canvas').clientHeight})");
const viewerUrl = (image, size = 'page', folder = 'Album') => stateUrl({...readState(''), folder, collection: folder, viewing: true, image, size});
const first = 'Album/Chapter 1/page2.jpg';
const second = 'Album/Chapter 1/page10.jpg';
const last = 'Album/Chapter 2/deep/page1.jpg';
await call('Runtime.enable');
await call('Network.enable');
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
await open('/');
await waitFor("document.querySelectorAll('.card').length > 5");
// An unrelated cancellation must settle once, rather than freezing the folder
// view with an endless chain of immediately retried promises.
const cancellationCheck = await evaluate(`(async () => {
    const {PreviewLoader} = await import('/static/preview-loader.js');
    const loader = new PreviewLoader(document.getElementById('grid-viewport'), document.getElementById('viewer'));
    const controller = new AbortController();
    let attempts = 0;
    let result;
    try {
        await loader.enqueue(() => {
            if (++attempts <= 1000) throw new DOMException('Source cancelled', 'AbortError');
            return 'retried';
        }, document.querySelector('.card .picture'), controller.signal);
        result = 'unexpected retry';
    } catch (error) { result = error.name; }
    await new Promise(resolve => requestAnimationFrame(resolve));
    return {attempts, result, scopeAborted: controller.signal.aborted};
})()`);
assert.deepEqual(cancellationCheck, {attempts: 1, result: 'AbortError', scopeAborted: false});
assert.ok(await evaluate("document.querySelectorAll('.card').length < 50"));
await waitFor("document.querySelector('.picture img')?.naturalWidth > 0");
assert.ok(await evaluate("(() => {const image=document.querySelector('.picture img').getBoundingClientRect(), frame=document.querySelector('.picture img').parentElement.getBoundingClientRect(); return image.left>=frame.left-.5 && image.right<=frame.right+.5 && image.top>=frame.top-.5 && image.bottom<=frame.bottom+.5;})()"), 'Preview images stay within their card area');
assert.equal(await evaluate("document.getElementById('layout-previews').getBoundingClientRect().right"), await evaluate("document.getElementById('layout-list').getBoundingClientRect().left"), 'Layout choices remain a contiguous button group');
await screenshot('grid');
const folderModeAction = await evaluate("document.getElementById('read-folder').getBoundingClientRect().toJSON()");
const actionColors = await evaluate("(() => {const style=id=>getComputedStyle(document.getElementById(id)); return {action:style('read-folder').backgroundColor, neutral:style('layout-list').backgroundColor, selected:style('layout-previews').backgroundColor};})()");
assert.equal(actionColors.action, actionColors.neutral, 'View uses neutral action styling');
assert.notEqual(actionColors.action, actionColors.selected, 'View does not appear permanently selected');
await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:folderModeAction.x+folderModeAction.width/2, y:folderModeAction.y+folderModeAction.height/2});
assert.notEqual(await evaluate("getComputedStyle(document.getElementById('read-folder')).backgroundColor"), actionColors.action, 'Hover feedback is visible');
assert.deepEqual(await evaluate("document.getElementById('read-folder').getBoundingClientRect().toJSON()"), folderModeAction, 'Hover preserves button geometry');
await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:700, y:450});
const imageNameBounds = await evaluate("document.querySelector('.card-caption .image-name').getBoundingClientRect().toJSON()");
await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:imageNameBounds.x+imageNameBounds.width/2, y:imageNameBounds.y+imageNameBounds.height/2});
assert.equal(await evaluate("getComputedStyle(document.querySelector('.card-caption .image-name')).backgroundColor"), 'rgba(0, 0, 0, 0)', 'Content links stay unfilled under the shared hover rules');
await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:700, y:450});

assert.equal(await evaluate("document.getElementById('read-folder').textContent.trim()"), '', 'Opening the viewer uses one icon action');
assert.equal(await evaluate("document.querySelectorAll('.mode-switch').length"), 0, 'No disabled current-mode controls');
assert.ok(await evaluate("[...document.querySelectorAll('[data-layout]')].every(button => button.textContent.trim()==='' && button.querySelector('svg') && button.getAttribute('aria-label') && button.title)"), 'Layout choices use named icons');
await pause(150);
const visibleCards = await evaluate(`(() => {
    const bounds = document.getElementById('grid-viewport').getBoundingClientRect();
    return [...document.querySelectorAll('.card')].filter(card => {
        const rect = card.querySelector('.picture').getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right;
    }).map(card => card.dataset.path);
})()`);
assert.ok(await evaluate('document.querySelectorAll(".card").length') > visibleCards.length, 'Fixture must include DOM overscan');
for (const request of requests.filter(url => new URL(url).pathname === '/thumbnail')) {
    assert.ok(visibleCards.includes(new URL(request).searchParams.get('path')), 'Only visible card paths may request thumbnails: ' + request);
}
await evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => { window.copiedPath=text; }}}); document.querySelector('#browse-location .copy-path').click()");
await waitFor("window.copiedPath");
const absoluteRoot = await evaluate('window.copiedPath');
assert.ok(absoluteRoot.startsWith('/'));
await evaluate("{ const info=document.querySelector('#browse-actions .item-info'); info.focus(); info.click(); }");
await waitFor("document.getElementById('metadata-details').textContent.includes('Media')");
assert.equal(await evaluate("getComputedStyle(document.querySelector('#browse-actions .item-info')).backgroundColor"), actionColors.selected, 'Expanded Info shares the selected-layout treatment');

assert.equal(await evaluate("document.getElementById('metadata-popover').matches(':popover-open')"), true);
assert.equal(await evaluate("document.querySelector('#metadata-popover button') === null"), true, 'Info itself dismisses the popover');
assert.equal(await evaluate("[...document.querySelectorAll('#metadata-details dt')].some(row => row.textContent === 'Type')"), false);
assert.equal(await evaluate("import('/static/metadata.js').then(({formatMetadataDate}) => formatMetadataDate('2005-01-10T17:08:17'))"), '2005-01-10 17:08');
const folderActions = await evaluate("document.getElementById('browse-actions').getBoundingClientRect().toJSON()");
const folderCopy = await evaluate("document.querySelector('#browse-location .copy-path').getBoundingClientRect().toJSON()");
assert.ok(await evaluate("document.querySelector('#browse-location .copy-path').getBoundingClientRect().right < document.getElementById('breadcrumbs').getBoundingClientRect().left"));
assert.equal(await evaluate("document.getElementById('metadata-details').textContent.includes('including archives') || document.getElementById('metadata-details').textContent.includes('Scope')"), false);
assert.ok(folderActions.right <= await evaluate('innerWidth'));
await screenshot('folder-info');
assert.equal(await evaluate("document.getElementById('metadata-popover').getBoundingClientRect().top"), await evaluate("document.querySelector('.app-header').getBoundingClientRect().bottom + 8"));
await nativeKey('Escape', 27);
await waitFor("!document.getElementById('metadata-popover').matches(':popover-open')");
assert.equal(await evaluate("document.activeElement === document.querySelector('#browse-actions .item-info')"), true);
await evaluate("document.querySelector('#browse-actions .item-info').click()");
await waitFor("document.getElementById('metadata-popover').matches(':popover-open')");
await call('Input.dispatchMouseEvent', {type:'mousePressed', x:10, y:450, button:'left', clickCount:1});
await call('Input.dispatchMouseEvent', {type:'mouseReleased', x:10, y:450, button:'left', clickCount:1});
await waitFor("!document.getElementById('metadata-popover').matches(':popover-open')");


// Filtering is immediate and makes no directory request. Both presentations preserve an item.
const folderRequests = () => requests.filter(url => url.includes('/api/folder')).length;
const countBeforeFilter = folderRequests();
await evaluate("{ const input=document.getElementById('filter'); input.value='root12'; input.dispatchEvent(new Event('input')); }");
await waitFor("document.getElementById('summary').textContent.includes('11 matches')");
assert.equal(folderRequests(), countBeforeFilter);
await call('Page.reload');
await waitFor("document.getElementById('summary')?.textContent.includes('11 matches')");
assert.equal(folderRequests(), countBeforeFilter + 1);
assert.ok(await evaluate("document.getElementById('summary').textContent.includes('11 matches')"));
await evaluate("{ const input=document.getElementById('filter'); input.value=''; input.dispatchEvent(new Event('input')); }");
await waitFor("!new URLSearchParams(location.search).has('filter')");
await evaluate("document.getElementById('grid-viewport').scrollTop = 1800");
await pause(160);
const anchor = await evaluate('history.state.position.path');
const beforeLayout = await evaluate('history.length');
await click('layout-list');
await waitFor("document.querySelector('.list-item')");
assert.equal(await evaluate('history.length'), beforeLayout);
assert.equal(await evaluate('history.state.position.path'), anchor);
assert.ok(await evaluate("[...document.querySelectorAll('.list-name')].some(node=>node.textContent=== " + JSON.stringify(anchor) + ")"));
assert.equal(await evaluate("document.querySelectorAll('#grid img').length"), 0);
await screenshot('list');
const historyBeforeSameLayout = await evaluate('history.length');
await click('layout-list');
assert.equal(await evaluate('history.length'), historyBeforeSameLayout);

// Mode switching reveals the current item and resumes it; Back retraces mode changes.
await open('/?folder=Album');
await waitFor("document.querySelectorAll('.card').length === 2");
await click('read-folder');
await readyImage(first);
assert.ok(await evaluate(`(() => {
    const browse = getComputedStyle(document.getElementById('breadcrumbs'));
    const viewer = getComputedStyle(document.getElementById('viewer-path'));
    return ['fontSize', 'lineHeight', 'gap', 'color'].every(key => browse[key] === viewer[key]);
})()`));
assert.ok(await evaluate("!document.getElementById('refresh') && !document.getElementById('viewer-refresh')"));
await click('viewer-next');
await readyImage(second);
await click('viewer-close');
await waitFor("document.getElementById('viewer').hidden");
await waitFor("document.activeElement.closest('.card')?.dataset.path === 'Album/Chapter 1'");
await click('read-folder');
await readyImage(second);
assert.ok(await evaluate("(() => { const image = document.getElementById('viewer-image'); return !image.hidden && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0; })()"), 'Reopening a cached image must display decoded pixels');
await evaluate('history.back()');
await waitFor("document.getElementById('viewer').hidden");
await open('/?folder=Album&view=grid');
await waitFor("document.querySelectorAll('.folder-heading a').length === 2");
await evaluate("document.querySelector('.folder-heading a').click()");
await waitFor("new URLSearchParams(location.search).get('folder') === 'Album/Chapter 1'");
assert.ok(await evaluate("document.getElementById('viewer').hidden"));

// A folder's View action establishes the same scope for both modes.
const beforeCovers = requests.length;
await open('/?folder=Album');
await waitFor("document.querySelectorAll('.folder-card .picture img').length === 2");
const covers = requests.slice(beforeCovers).filter(url => new URL(url).pathname === '/thumbnail');
assert.deepEqual(covers.map(url => new URL(url).searchParams.get('path')).sort(), ['Album/Chapter 1', 'Album/Chapter 2']);
await open('/?folder=Album&compact=1');
await waitFor("document.querySelector('.list-read')");
await evaluate("document.querySelector('.list-read').click()");
await readyImage(first);
assert.equal(await evaluate("new URLSearchParams(location.search).get('folder')"), 'Album/Chapter 1');
await click('viewer-next');
await readyImage(second);
await click('viewer-close');
await waitFor("document.activeElement.closest('.card')?.dataset.path === 'Album/Chapter 1/page10.jpg'");
await call('Page.reload');
await waitFor("document.querySelector('.list-name')");
await click('read-folder');
await readyImage(second);
await evaluate("document.querySelector('#viewer-path a').click()");
await waitFor("document.getElementById('viewer').hidden");
assert.equal(await evaluate('history.state.selection'), null);

// Recursive paging and Back reuse discovered items without rebuilding the traversal.
await open('/?view=grid');
await waitFor("document.getElementById('summary').textContent.includes('60 items')");
for (let page=0; page<5; page++) {
    await evaluate("document.getElementById('grid-viewport').scrollTop = document.getElementById('grid-viewport').scrollHeight");
    await pause(100);
}
await waitFor("document.getElementById('summary').textContent === '172 items'");
await evaluate("document.getElementById('grid-viewport').scrollTop = 1800");
await pause(160);
const recursiveAnchor = await evaluate('history.state.overviewPosition.path');
await evaluate("document.querySelector('#grid .picture').click()");
await waitFor("!document.getElementById('viewer-stage').hidden");
await evaluate('history.back()');
await waitFor("!document.getElementById('overview').hidden");
assert.equal(await evaluate('history.state.overviewPosition.path'), recursiveAnchor);

// The layout choice keeps the header geometry fixed and survives history and reload.
await open(viewerUrl(first));
await readyImage(first);
const headerPositions = () => evaluate(`(() => ({
    layouts: document.querySelector('.viewer-layouts').getBoundingClientRect().x,
    size: document.querySelector('.size-control').getBoundingClientRect().x,
    width: document.querySelector('.size-control').getBoundingClientRect().width,
}))()`);
const initialPositions = await headerPositions();
await click('view-single');
assert.equal(await evaluate("new URLSearchParams(location.search).get('view')"), 'single');
assert.ok(await evaluate("document.getElementById('viewer-strip').hidden && document.getElementById('viewer-image').dataset.path === 'Album/Chapter 1/page2.jpg'"));
assert.deepEqual(await headerPositions(), initialPositions);
assert.equal(await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().bottom"), await evaluate('innerHeight'), 'Image-only canvas uses all space below the header');
assert.equal(await evaluate("getComputedStyle(document.querySelector('.viewer-feedback')).display"), 'none', 'Empty feedback takes no space');
await call('Page.reload');
await readyImage(first);
assert.equal(await evaluate("document.getElementById('view-single').getAttribute('aria-pressed')"), 'true');
await key('t');
await waitFor("!new URLSearchParams(location.search).has('view') && !document.getElementById('viewer-strip').hidden");
assert.deepEqual(await headerPositions(), initialPositions);
await click('view-grid');
await waitFor("!document.getElementById('overview').hidden");
assert.equal(await evaluate("new URLSearchParams(location.search).get('view')"), 'grid');
assert.ok(await evaluate("document.querySelector('.size-control').classList.contains('unavailable')"));
assert.deepEqual(await headerPositions(), initialPositions);
await evaluate('history.back()');
await waitFor("document.getElementById('view-strip').getAttribute('aria-pressed') === 'true' && !document.getElementById('viewer-strip').hidden");
await readyImage(first);

// Fit page never upscales a small photo. Native wheel events turn fitted pages.
await open(viewerUrl('root2.jpg', 'page', ''));
await readyImage('root2.jpg');
assert.ok(await evaluate("document.getElementById('viewer-image').width <= 320"));
await call('Input.dispatchMouseEvent', {type:'mouseWheel', x:700,y:350,deltaX:0,deltaY:120});
await readyImage('root3.jpg');
await open(viewerUrl(first));
await readyImage(first);
await evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:undefined}); window.originalExecCommand=document.execCommand; document.execCommand=command => { if(command==='copy') { window.copiedPath=document.querySelector('.clipboard-input').value; return true; } return false; }; document.querySelector('#viewer-location .copy-path').click()");
await waitFor("window.copiedPath");
assert.equal(await evaluate('window.copiedPath'), absoluteRoot + '/' + first);
await evaluate('document.execCommand=window.originalExecCommand');
assert.equal(await evaluate("getComputedStyle(document.querySelector('#viewer-strip button.selected')).borderColor"), await evaluate("getComputedStyle(document.getElementById('layout-previews')).borderColor"), 'Current thumbnails and layout choices share the selection accent');
const returnAction = await evaluate("document.getElementById('viewer-close').getBoundingClientRect().toJSON()");
assert.deepEqual(returnAction, folderModeAction, 'Open and return actions have identical positions and dimensions');
assert.equal(folderModeAction.width, 64, 'The primary View action has a wider target');
assert.ok(await evaluate("[...document.querySelectorAll('.viewer-nav')].every(button => button.textContent.trim()==='' && button.querySelector('svg') && button.getAttribute('aria-label') && button.title && button.getBoundingClientRect().height >= 60)"), 'Navigation has no visible labels and keeps generous click targets');
const viewerFrame = await evaluate("({header:document.querySelector('.viewer-header').offsetHeight, canvas:document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()})");
assert.equal(viewerFrame.header, await evaluate("document.querySelector('.app-header').offsetHeight"), 'Image and folder headers have the same height');
assert.ok(viewerFrame.header <= 45, 'Desktop header uses one compact row');
assert.equal(viewerFrame.canvas.y, viewerFrame.header, 'Canvas starts immediately below the header');
assert.equal(await evaluate("document.getElementById('viewer-stage').getBoundingClientRect().bottom"), await evaluate("document.querySelector('.strip-frame').getBoundingClientRect().top"), 'No footer reserves image space');
assert.ok(await evaluate("(() => {const buttons=document.querySelector('.browse-controls').getBoundingClientRect(), filter=document.getElementById('filter').getBoundingClientRect(); return buttons.left===16 && buttons.right < filter.left && buttons.top===filter.top && buttons.height===32 && filter.height===32;})()"), 'Layout controls sit left of the filter in one compact row');
assert.deepEqual(await evaluate("document.getElementById('viewer-actions').getBoundingClientRect().toJSON()"), folderActions, 'Copy and Info keep the same position and size across modes');
assert.deepEqual(await evaluate("document.querySelector('#viewer-location .copy-path').getBoundingClientRect().toJSON()"), folderCopy, 'Copy stays immediately left of the path in both modes');
assert.equal(await evaluate("document.getElementById('viewer-actions').textContent.trim()"), '', 'Header actions use icons with accessible names');
await evaluate("document.querySelector('#viewer-actions .item-info').click()");
await waitFor("document.getElementById('metadata-details').textContent.includes('1000 × 1800')");
assert.equal(await evaluate("(() => { const path=document.querySelector('.metadata-path'); const size=[...document.querySelectorAll('#metadata-details dt')].find(row => row.textContent==='Size').nextElementSibling; return path.getBoundingClientRect().left===size.getBoundingClientRect().left && getComputedStyle(path).fontSize===getComputedStyle(size).fontSize; })()"), true, 'Paths use the same value column and type size as other details');
assert.deepEqual(await evaluate("({header:document.querySelector('.viewer-header').offsetHeight, canvas:document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()})"), viewerFrame, 'Opening Info must not resize or move the viewer');
assert.equal(await evaluate("document.querySelector('#viewer-path .item-info') === null"), true);
assert.match(await evaluate("document.querySelector('#viewer-location .copy-path').getAttribute('aria-label')"), /^(Copy image path|Copied)$/);
await screenshot('image-metadata');
await nativeKey('ArrowRight', 39);
await readyImage(second);
await waitFor("document.getElementById('metadata-title').textContent === 'page10.jpg'");
assert.deepEqual(await evaluate("document.getElementById('viewer-actions').getBoundingClientRect().toJSON()"), folderActions, 'Changing the current item must not move its controls');
assert.equal(await evaluate("document.getElementById('metadata-popover').matches(':popover-open')"), true);
await evaluate("window.copiedPath=null; Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => { window.copiedPath=text; }}})");
const copyBounds = await evaluate("document.querySelector('#viewer-location .copy-path').getBoundingClientRect().toJSON()");
for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', {type, x:copyBounds.x+copyBounds.width/2, y:copyBounds.y+copyBounds.height/2, button:'left', clickCount:1});
await waitFor('window.copiedPath');
assert.equal(await evaluate('window.copiedPath'), absoluteRoot + '/' + second);
assert.equal(await evaluate("document.getElementById('metadata-popover').matches(':popover-open')"), true);
const previousBounds = await evaluate("document.getElementById('viewer-prev').getBoundingClientRect().toJSON()");
for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', {type, x:previousBounds.x+previousBounds.width/2, y:previousBounds.y+previousBounds.height/2, button:'left', clickCount:1});
await readyImage(first);
await waitFor("document.getElementById('metadata-title').textContent === 'page2.jpg'");
assert.equal(await evaluate("document.getElementById('metadata-popover').matches(':popover-open')"), true);
await nativeKey('Escape', 27);
await waitFor("!document.getElementById('metadata-popover').matches(':popover-open')");
assert.equal(await evaluate("document.getElementById('viewer').hidden"), false);

await readyImage(first);
await screenshot('viewer');
await click('viewer-next');
await readyImage(second);
await click('viewer-next');
await readyImage(last);
const heightAtEnd = await evaluate("document.getElementById('viewer-image').height");
await click('viewer-next');
await waitFor("document.getElementById('viewer-next').getAttribute('aria-label') === 'Go to first item'");
assert.equal(await evaluate("document.getElementById('viewer-image').height"), heightAtEnd);
assert.equal(await evaluate("document.getElementById('viewer-next').dataset.icon"), 'first', 'At the end, the arrow becomes an explicit return-to-first action');
assert.equal(await evaluate("document.getElementById('viewer-next').textContent.trim()"), '');
await screenshot('collection-boundary');
await key('ArrowRight', true);
assert.ok(await evaluate(imageIs(last)));
await key('ArrowRight');
await readyImage(first);
assert.equal(await evaluate("document.getElementById('viewer-wrap')"), null);
assert.equal(await evaluate("document.getElementById('viewer-next').dataset.icon"), 'next', 'Normal navigation icon returns after wrapping');

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

assert.equal(await evaluate("document.getElementById('view-strip').getAttribute('aria-pressed')"), 'true');
await waitFor("document.querySelectorAll('#viewer-strip button').length === 3");
assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#viewer-strip .folder-start .strip-folder'), node=>node.textContent)"), ['Chapter 1', 'Chapter 2/deep']);
// Resize through the actual pointer handle, then the keyboard, without changing image.
const resizePoint = await evaluate(`(() => { const r=document.querySelector('.strip-resizer').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
const thumbHeight = await evaluate("document.querySelector('#viewer-strip button').getBoundingClientRect().height");
await call('Input.dispatchMouseEvent', {type:'mousePressed', button:'left', clickCount:1, ...resizePoint});
await call('Input.dispatchMouseEvent', {type:'mouseMoved', button:'left', buttons:1, x:resizePoint.x, y:resizePoint.y-80});
await call('Input.dispatchMouseEvent', {type:'mouseReleased', button:'left', clickCount:1, x:resizePoint.x, y:resizePoint.y-80});
await waitFor(`document.querySelector('#viewer-strip button').getBoundingClientRect().height > ${thumbHeight + 70}`);
await screenshot('strip-resized-chapters');
await evaluate("document.querySelector('.strip-resizer').focus()");
await call('Input.dispatchKeyEvent', {type:'keyDown', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40});
await call('Input.dispatchKeyEvent', {type:'keyUp', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40});
assert.equal(await evaluate("Number(document.querySelector('.strip-resizer').getAttribute('aria-valuenow'))"), thumbHeight + 64);
assert.ok(await evaluate(imageIs(second)));
assert.equal(await evaluate("sessionStorage.getItem('thumbnailSize')"), String(thumbHeight + 64));
await evaluate("import('/gallery.js').then(({app})=>app.viewer.filmstrip.setSize(64))");
await evaluate("sessionStorage.setItem('thumbnailSize','64'); document.getElementById('viewer-canvas').focus()");
await waitFor("import('/gallery.js').then(({app})=>app.viewer.viewport.box.height === document.getElementById('viewer-canvas').clientHeight)");
// Hidden filmstrip cancels preview work and does not request thumbnails on later pages.
await evaluate("document.getElementById('viewer-canvas').scrollTop = 450");
const beforeStrip = await sourcePoint();
await click('view-single');
assert.equal(await evaluate("new URLSearchParams(location.search).get('view')"), 'single');
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
await evaluate("import('/static/media-cache.js').then(module => module.originals.clear())");
const beforeLoading = await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()");
await click('viewer-next');
await waitImage(second);
await waitFor("document.getElementById('viewer-status').textContent.includes('Loading')");
assert.deepEqual(await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()"), beforeLoading, 'Loading feedback does not resize the canvas');
assert.equal(await evaluate("getComputedStyle(document.querySelector('.viewer-feedback')).display"), 'flex', 'Loading feedback is visible');
assert.equal(await evaluate("document.getElementById('viewer-image').dataset.path"), first);
assert.equal(await evaluate("document.getElementById('viewer-zoom').disabled"), false);
await click('viewer-zoom');
assert.equal(await evaluate("document.getElementById('size-menu').hidden"), false);
assert.equal(await evaluate("getComputedStyle(document.getElementById('viewer-zoom')).backgroundColor"), actionColors.selected, 'An open size menu uses the shared expanded state');
await evaluate("document.querySelector('[data-size=width]').click()");
assert.equal(await evaluate("getComputedStyle(document.getElementById('viewer-zoom')).backgroundColor"), actionColors.action, 'Closing the menu restores neutral action styling');
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
assert.equal(await evaluate("getComputedStyle(document.querySelector('.viewer-feedback')).display"), 'flex', 'Error feedback and Retry are visible');
assert.ok(await evaluate("!document.getElementById('viewer-next').disabled"));
await click('viewer-next');
await readyImage(first);
await call('Page.reload');
await waitFor("document.getElementById('viewer-image')?.dataset.path === 'Album/Chapter 1/page2.jpg'");
await readyImage(first);

// Continued wheel input advances fitted pages without requiring a pause after every image.
await open(viewerUrl('root2.jpg', 'page', ''));
await readyImage('root2.jpg');
for (let i=0; i<12; i++) await wheel(60);
await pause(100);
assert.ok(await evaluate("Number(new URLSearchParams(location.search).get('image').match(/root(\\d+)/)[1]) >= 4"));

// A visible strip retains buttons and their order as pages turn; discovery is demand driven.
await click('view-strip');
await waitFor("document.querySelectorAll('#viewer-strip button').length >= 16");
await evaluate("window.retainedThumbnail=document.querySelector('#viewer-strip button')");
const stripPaths = await evaluate("Array.from(document.querySelectorAll('#viewer-strip button'),button=>button.dataset.path)");
await click('viewer-next');
await pause(200);
assert.ok(await evaluate('window.retainedThumbnail.isConnected'));
assert.deepEqual((await evaluate("Array.from(document.querySelectorAll('#viewer-strip button'),button=>button.dataset.path)")).slice(0,stripPaths.length),stripPaths);
// A middle image stays centered as adjacent batches arrive; real ends have no fade.
await open(viewerUrl('root40.jpg', 'page', ''));
await readyImage('root40.jpg');
await waitFor(`(() => {
    const strip = document.getElementById('viewer-strip');
    const selected = strip.querySelector('[aria-current]');
    if (!selected) return false;
    const a = strip.getBoundingClientRect(), b = selected.getBoundingClientRect();
    return Math.abs((a.left+a.right-b.left-b.right)/2) < 2 && strip.classList.contains('more-before') && strip.classList.contains('more-after');
})()`);
const thumbPoint = await evaluate(`(() => {const r=document.querySelector('#viewer-strip [aria-current]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
await call('Input.dispatchMouseEvent', {type:'mousePressed', button:'left', clickCount:1, ...thumbPoint});
await call('Input.dispatchMouseEvent', {type:'mouseReleased', button:'left', clickCount:1, ...thumbPoint});
const stripFocused = await evaluate("document.getElementById('viewer-strip').contains(document.activeElement)");
await call('Input.dispatchKeyEvent', {type:'keyDown', key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39});
await call('Input.dispatchKeyEvent', {type:'keyUp', key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39});
assert.ok(stripFocused);
await readyImage('root41.jpg');
await screenshot('strip-centered');
await evaluate("document.getElementById('viewer-strip').scrollLeft=0");
await waitFor("import('/gallery.js').then(({app})=>app.viewer.filmstrip.edges[0].done)");
await evaluate("document.getElementById('viewer-strip').scrollLeft=0");
await waitFor("!document.getElementById('viewer-strip').classList.contains('more-before')");
assert.ok(await evaluate("document.getElementById('viewer-strip').classList.contains('more-after')"));
await evaluate("window.retainedThumbnail=document.querySelector('#viewer-strip button')");
await evaluate("document.getElementById('viewer-strip').scrollLeft=100000");
await waitFor("document.querySelector('#viewer-strip button').dataset.path !== window.retainedThumbnail.dataset.path");
assert.ok(await evaluate("document.querySelectorAll('#viewer-strip button').length < 40"));
await screenshot('thumbnails');
await click('viewer-zoom');
assert.equal(await evaluate("document.querySelectorAll('#size-menu > button').length"),3);
await screenshot('sizing');
await key('Escape');
assert.ok(await evaluate("document.getElementById('size-menu').hidden && !document.getElementById('viewer').hidden"));
await click('view-single');

// Breadcrumbs leave the reader for the image's actual folder, preserving the grid layout.
await open(viewerUrl(first));
await readyImage(first);
await evaluate("document.querySelector('#viewer-path a[aria-current]').click()");
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
await evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => { window.copiedPath=text; }}}); document.querySelector('#viewer-location .copy-path').click()");
await waitFor('window.copiedPath');
assert.equal(await evaluate('window.copiedPath'), absoluteRoot + '/Packed.cbz/Chapter 3/page1.jpg');
await evaluate("document.querySelector('#viewer-actions .item-info').click()");
await waitFor("document.getElementById('metadata-details').textContent.includes('Packed.cbz/Chapter 3/page1.jpg')");
await nativeKey('Escape', 27);
await waitFor("!document.getElementById('metadata-popover').matches(':popover-open')");

await evaluate("document.querySelector('#viewer-path a[aria-current]').click()");
await waitFor("document.getElementById('viewer').hidden && new URLSearchParams(location.search).get('folder') === 'Packed.cbz/Chapter 3'");

// Special filenames and narrow screens retain controls, full names, and a visible focus target.
await open(viewerUrl('Odd & #/a ?#%.jpg', 'page', 'Odd & #'));
await readyImage('Odd & #/a ?#%.jpg');
await call('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
await open(viewerUrl(first,'width'));
await readyImage(first);
assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
assert.equal(await evaluate("document.querySelector('#viewer-path .browsing-folder').textContent"), 'Album');
assert.ok(await evaluate("getComputedStyle(document.querySelector('#viewer-path [aria-current]')).textDecorationLine.includes('underline')"));
assert.ok(await evaluate("document.getElementById('viewer-close').getBoundingClientRect().right <= innerWidth"));
assert.ok(await evaluate("document.querySelector('.viewer-header').getBoundingClientRect().height <= 85"));
assert.ok(await evaluate("document.getElementById('viewer-close').scrollWidth <= document.getElementById('viewer-close').clientWidth"));
await screenshot('mobile-viewer');
const mobileModeAction = await evaluate("document.getElementById('viewer-close').getBoundingClientRect().toJSON()");
const mobileActions = await evaluate("document.getElementById('viewer-actions').getBoundingClientRect().toJSON()");
const mobileFrame = await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()");
await evaluate("document.querySelector('#viewer-actions .item-info').click()");
await waitFor("document.getElementById('metadata-details').textContent.includes('1000 × 1800')");
assert.deepEqual(await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()"), mobileFrame);
assert.ok(await evaluate("(() => { const rect=document.getElementById('metadata-popover').getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })()"));
assert.ok(await evaluate("document.getElementById('metadata-popover').getBoundingClientRect().top >= document.querySelector('.viewer-header').getBoundingClientRect().bottom"), 'Info must not obscure the location or filename');
await screenshot('mobile-info');
await evaluate("document.querySelector('#viewer-actions .item-info').click()");
assert.equal(await evaluate("document.getElementById('metadata-popover').matches(':popover-open')"), false);
await key('Tab');
assert.ok(await evaluate("document.activeElement.getClientRects().length > 0"));
await open('/?folder=Names&compact=1');
await waitFor("document.querySelector('.list-name')");
assert.deepEqual(await evaluate("document.getElementById('read-folder').getBoundingClientRect().toJSON()"), mobileModeAction, 'Open and return actions have identical geometry on narrow screens');
assert.deepEqual(await evaluate("document.getElementById('browse-actions').getBoundingClientRect().toJSON()"), mobileActions, 'The narrow layout uses the same action position in Browse and View');
assert.ok(await evaluate("document.querySelector('.list-name').getBoundingClientRect().bottom <= document.querySelector('.list-item').getBoundingClientRect().bottom"));
assert.ok(await evaluate("document.querySelector('.list-read').getBoundingClientRect().right < document.querySelector('.list-name').getBoundingClientRect().left"));
assert.equal(await evaluate("document.querySelector('.list-item').firstElementChild.className"),'list-read');
await screenshot('long-names');
await evaluate("document.querySelector('.list-name').click()");
await waitFor("document.querySelector('#breadcrumbs [aria-current]').textContent.includes('Chapter 123')");
await click('read-folder');
await waitFor("document.querySelector('#viewer-path [aria-current]')?.textContent.includes('Chapter 123')");
assert.ok(await evaluate("document.getElementById('viewer-path').scrollLeft > 0"));
assert.ok(await evaluate("document.getElementById('viewer-close').getBoundingClientRect().right <= innerWidth"));
assert.ok(await evaluate("document.querySelector('.viewer-header').getBoundingClientRect().height <= 85"));
await screenshot('long-header');
const longPathOffset = await evaluate("document.getElementById('viewer-path').scrollLeft");
await evaluate("import('/gallery.js').then(({app}) => app.viewer.updateCollectionLabel())");
assert.equal(await evaluate("document.getElementById('viewer-path').scrollLeft"), longPathOffset, 'Refreshing controls preserves the visible part of a long image path');
// Mixed media: placeholder previews, streaming, native controls, seeking, and cleanup.
await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
await open('/?folder=Mixed');
await waitFor(`document.querySelector('[data-path="Mixed/2.webm"] :is(.video-placeholder, .video-badge)')`);
const videoPreviewAvailable = await evaluate("fetch('/thumbnail?path=Mixed/2.webm').then(response => response.ok)");
if (videoPreviewAvailable) {
    await waitFor(`document.querySelector('[data-path="Mixed/2.webm"] img')?.naturalWidth > 0`);
    assert.ok(await evaluate(`Boolean(document.querySelector('[data-path="Mixed/2.webm"] .video-badge'))`));
}
await waitFor(`document.querySelector('[data-path="Mixed/4.mp4"] .video-placeholder')`);
await evaluate(`document.querySelector('[data-path="Mixed/2.webm"] .picture').click()`);
await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
assert.ok(await evaluate("document.activeElement === document.getElementById('viewer-video')"));
if (videoPreviewAvailable) assert.ok(await evaluate("document.getElementById('viewer-video').poster.startsWith('blob:')"));
if (await evaluate("document.getElementById('view-strip').getAttribute('aria-pressed') === 'false'")) await click('view-strip');
await waitFor(`document.querySelector('#viewer-strip button[data-path="Mixed/1.jpg"]')`);
assert.ok(await evaluate(`document.querySelector('#viewer-strip button[data-path="Mixed/2.webm"]').offsetWidth > document.querySelector('#viewer-strip button[data-path="Mixed/1.jpg"]').offsetWidth`));
await call('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
await pause(150);
assert.ok(await evaluate("(()=>{const v=document.getElementById('viewer-video'), r=v.getBoundingClientRect(); return Math.abs(r.width/r.height-v.videoWidth/v.videoHeight)<.02 && r.right<=innerWidth})()"));
await screenshot('video-mobile');
await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
await open(viewerUrl('Mixed/1.jpg', 'page', 'Mixed'));
await readyImage('Mixed/1.jpg');
await click('viewer-next');
await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
assert.ok(await evaluate("document.getElementById('viewer-video').paused && document.querySelector('.size-control').classList.contains('unavailable')"));
assert.deepEqual(await headerPositions(), initialPositions);
await evaluate("window.testVideo=document.getElementById('viewer-video'); testVideo.focus(); testVideo.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true})); testVideo.dispatchEvent(new WheelEvent('wheel', {deltaY:100,bubbles:true}));");
await waitImage('Mixed/2.webm');
await evaluate('testVideo.play()', true);
await waitFor('testVideo.currentTime > 0');
await evaluate('testVideo.pause(); testVideo.currentTime=1.5');
await waitFor('!testVideo.seeking && testVideo.currentTime >= 1.4');
await click('view-grid');
await waitFor("!document.getElementById('overview').hidden && document.querySelector('.selected-media')");
assert.ok(await evaluate("testVideo.paused && !testVideo.hasAttribute('src')"));
await evaluate(`document.querySelector('#overview [data-path="Mixed/2.webm"] .picture').click()`);
await waitFor("document.getElementById('viewer-video')?.currentTime >= 1.4");
assert.ok(await evaluate("document.getElementById('viewer-video').paused"));
await evaluate("window.testVideo=document.getElementById('viewer-video');testVideo.dispatchEvent(new Event('ended'))");
await waitImage('Mixed/2.webm');
await screenshot('video');
await click('viewer-next');
await readyImage('Mixed/3.jpg');
assert.ok(await evaluate("testVideo.paused && !testVideo.hasAttribute('src') && !testVideo.isConnected && !document.querySelector('.size-control').classList.contains('unavailable')"));
await click('viewer-prev');
await waitFor("document.getElementById('viewer-video')?.readyState >= 2");
await evaluate("window.testVideo=document.getElementById('viewer-video')");
await click('viewer-close');
assert.ok(await evaluate("testVideo.paused && !testVideo.hasAttribute('src') && !testVideo.isConnected"));
await open(viewerUrl('Mixed/4.mp4', 'page', 'Mixed'));
await waitFor("document.getElementById('viewer-status').textContent.includes('Unable to play')");
await click('viewer-prev');
await readyImage('Mixed/3.jpg');
assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
assert.equal(requests.filter(url => new URL(url).pathname === '/api/preview').length, 0);
console.log('Browser smoke passed: navigation, history, filtering, layout anchors, gesture edges, zoom anchors, slow loads, cancellation, filmstrip, URLs, empty/single images, responsive controls.');
socket.close();
