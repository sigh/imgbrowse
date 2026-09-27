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
socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
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
    throw new Error('Timed out: ' + expression);
}
async function open(path) {
    const url = new URL(path, base).href;
    await call('Page.navigate', {url});
    await waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
}
const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const imageIs = path => `new URLSearchParams(location.search).get('image') === ${JSON.stringify(path)}`;
const waitImage = path => waitFor(imageIs(path));
const key = (key, repeat = false) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({key, repeat})}))`);
const wheel = deltaY => evaluate(`document.getElementById('viewer').dispatchEvent(new WheelEvent('wheel', {deltaY: ${deltaY}, cancelable: true}))`);
async function screenshot(name) {
    if (screenshots) writeFileSync(join(screenshots, name + '.png'), Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
}

await call('Runtime.enable');
await open('/');
await waitFor("document.querySelectorAll('.card').length > 0");
assert.ok(await evaluate("document.querySelectorAll('.card').length < 50"));
assert.match(await evaluate("document.getElementById('summary').textContent"), /160 direct images/);
await screenshot('grid');
await evaluate("document.getElementById('grid-viewport').scrollTop = 2500");
await waitFor("[...document.querySelectorAll('.grid-row')].some(node => parseInt(node.style.top) > 2000)");
assert.ok(await evaluate("document.querySelectorAll('.card').length < 50"));

await click('recursive');
await waitFor("document.getElementById('summary').textContent.includes('60 images')");
for (let page = 0; page < 5; page++) {
    await evaluate("{ const viewport = document.getElementById('grid-viewport'); viewport.scrollTop = viewport.scrollHeight; }");
    await new Promise(resolve => setTimeout(resolve, 150));
}
await waitFor("document.getElementById('summary').textContent === '164 images'");
assert.ok(await evaluate("document.querySelectorAll('.card').length < 50"));

await open('/?folder=Album');
await waitFor("document.querySelectorAll('.card').length === 2");
await click('read-folder');
await waitImage('Album/Chapter 1/page2.jpg');
await waitFor("document.getElementById('viewer-image').naturalWidth > 0");
await screenshot('viewer');
await click('viewer-next');
await waitImage('Album/Chapter 1/page10.jpg');
await click('viewer-next');
await waitImage('Album/Chapter 2/deep/page1.jpg');
await click('viewer-next');
await waitFor("!document.getElementById('viewer-wrap').hidden");
assert.equal(await evaluate("document.getElementById('viewer-cancel')"), null);
await key('ArrowRight', true);
assert.ok(await evaluate(imageIs('Album/Chapter 2/deep/page1.jpg')));
await key('ArrowRight');
await waitImage('Album/Chapter 1/page2.jpg');
await key('ArrowLeft');
await waitFor("!document.getElementById('viewer-wrap').hidden");
await wheel(-100);
await waitImage('Album/Chapter 2/deep/page1.jpg');
await new Promise(resolve => setTimeout(resolve, 350));
await wheel(100);
await waitFor("!document.getElementById('viewer-wrap').hidden");
await wheel(100);
assert.ok(await evaluate(imageIs('Album/Chapter 2/deep/page1.jpg')));
await new Promise(resolve => setTimeout(resolve, 350));
await wheel(100);
await waitImage('Album/Chapter 1/page2.jpg');
await click('viewer-next');
assert.equal(await evaluate("document.getElementById('viewer-status').textContent"), '');
await waitImage('Album/Chapter 1/page10.jpg');
await click('viewer-close');
await waitFor("document.getElementById('viewer').hidden");
assert.equal(await evaluate("document.getElementById('recursive').checked"), false);

await click('recursive');
await waitFor("document.getElementById('summary').textContent === '3 images'");
assert.equal(await evaluate("document.querySelectorAll('.folder-heading').length"), 2);
await evaluate('history.back()');
await waitFor("!document.getElementById('recursive').checked && document.querySelectorAll('.card').length === 2");
await open('/?' + new URLSearchParams({folder: 'Odd & #', image: 'Odd & #/a ?#%.jpg'}));
await waitFor("document.getElementById('viewer-image').naturalWidth > 0");
await open('/?' + new URLSearchParams({category: 'Album', image: 'Album/Chapter%201/page2.jpg'}));
await waitFor("document.getElementById('viewer-name').textContent === 'Album/Chapter 1/page2.jpg'");
await open('/?folder=Names');
await waitFor("document.querySelector('.card-caption a')?.textContent.endsWith('Chapter 123')");
assert.ok(await evaluate("document.querySelector('.card-caption').getBoundingClientRect().bottom <= document.querySelector('.card').getBoundingClientRect().bottom"));
await screenshot('long-names');
await open('/?folder=Empty&viewer=1');
await waitFor("document.getElementById('viewer-status').textContent.includes('No images')");
assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
console.log('Browser smoke passed: virtual grid, recursive viewer, natural order, gesture wrapping, history, URLs, long names, empty folders.');
socket.close();
