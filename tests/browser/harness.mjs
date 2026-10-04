/** Shared Chrome protocol and input helpers for browser journeys. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {readState, stateUrl, ScreenMode, ImageSize, ReadingLayout} from '../../image_browser/web/static/shared/state.js';

export async function connectBrowser(port, base, screenshots = '') {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise(resolve => socket.addEventListener('open', resolve, {once: true}));
    let sequence = 0;
    const pending = new Map();
    const exceptions = [];
    const requests = [];
    const held = [];
    const network = {images: false, walk: false, folders: false, metadata: false};
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
        if (message.method === 'Fetch.requestPaused') {
            const {requestId, request} = message.params;
            if ((network.images && request.url.includes('/image?')) || (network.walk && request.url.includes('/api/walk'))
                || (network.folders && request.url.includes('/api/folder')) || (network.metadata && request.url.includes('/api/metadata'))) held.push(requestId);
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
    async function click(id) {
        const rect = await evaluate(`document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().toJSON()`);
        for (const type of ['mousePressed', 'mouseReleased']) {
            await call('Input.dispatchMouseEvent', {type, button:'left', clickCount:1, x:rect.x+rect.width/2, y:rect.y+rect.height/2});
        }
    }
    async function newTab(selector, button = 'middle', modifiers = 0) {
        const before = new Set((await call('Target.getTargets')).targetInfos.map(target => target.targetId));
        const current = await evaluate('location.href');
        const rect = await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
        for (const type of ['mousePressed', 'mouseReleased']) {
            await call('Input.dispatchMouseEvent', {type, button, modifiers, clickCount:1, x:rect.x+rect.width/2, y:rect.y+rect.height/2});
        }
        let opened;
        for (let attempt=0; attempt<100; attempt++) {
            opened = (await call('Target.getTargets')).targetInfos.find(target => target.type === 'page' && !before.has(target.targetId) && target.url.startsWith(base));
            if (opened) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(opened, 'Native modified navigation opens another tab: ' + selector);
        assert.equal(await evaluate('location.href'), current, 'Modified navigation preserves the current tab');
        await call('Target.closeTarget', {targetId:opened.targetId});
        await call('Page.bringToFront');
        return new URL(opened.url).searchParams;
    }
    const imageIs = path => `import('/static/shared/state.js').then(({readState}) => readState().image === ${JSON.stringify(path)})`;
    const waitImage = path => waitFor(imageIs(path));
    const keyCodes = {ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40, Tab:9, Escape:27};
    const key = (key, repeat = false) => nativeKey(key, keyCodes[key] ?? key.toUpperCase().charCodeAt(0), 0, repeat);
    async function nativeKey(key, code, modifiers = 0, repeat = false) {
        for (const type of ['keyDown', 'keyUp']) {
            await call('Input.dispatchKeyEvent', {type, key, code: key, windowsVirtualKeyCode: code, modifiers, autoRepeat:type === 'keyDown' && repeat});
            if (type === 'keyDown' && key === 'Enter') await call('Input.dispatchKeyEvent', {type:'char', text:'\r', modifiers});
        }
    }
    const wheel = async (deltaY, interval = 70) => { await call('Input.dispatchMouseEvent', {type:'mouseWheel', x:700, y:350, deltaX:0, deltaY}); await new Promise(resolve => setTimeout(resolve, interval)); };
    async function screenshot(name) {
        if (screenshots) writeFileSync(join(screenshots, name + '.png'), Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
    }


    const readyImage = path => waitFor(`(() => { const image = document.getElementById('viewer-image'); return image?.dataset.path === ${JSON.stringify(path)} && !image.hidden && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0 && !document.getElementById('viewer-zoom-in').disabled; })()`);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const position = () => evaluate("({top:document.getElementById('viewer-canvas').scrollTop,max:document.getElementById('viewer-canvas').scrollHeight-document.getElementById('viewer-canvas').clientHeight})");
    const viewerUrl = (image, size = ImageSize.DEFAULT, folder = 'Album', layout = ReadingLayout.STRIP) => stateUrl({...readState(''), folder, collection: folder, mode: ScreenMode.VIEW, image, size, layout});
    async function presentation(layout) {
        await evaluate(`document.querySelector('[data-reading-layout="${layout}"]').click()`);
    }
    // Seed an exact numeric size for geometry/legacy-link scenarios; reader tests exercise −/+.
    async function setZoom(percent) {
        await evaluate(`import('/gallery.js').then(({app}) => app.changeSize(String(${percent}/100)))`);
    }
    async function openInfo(waitLoaded = true) {
        if (await evaluate("document.getElementById('folder-tree').hidden")) await click('folders-toggle');
        if (!await evaluate("document.getElementById('item-info').open")) await click('metadata-toggle');
        if (waitLoaded) await waitFor("document.querySelector('#metadata-panel .copy-path') && !document.getElementById('metadata-details').classList.contains('loading') && !document.getElementById('folder-tree').hidden");
    }

    const headerPositions = () => evaluate(`(() => {
        const header = document.querySelector('.app-header');
        return {
            navigation: header.querySelector('.mode-navigation').getBoundingClientRect().toJSON(),
            modes: [...header.querySelectorAll('[data-mode], [data-reading-layout]')].map(button => button.getBoundingClientRect().toJSON()),
            height: header.offsetHeight,
            location: header.querySelector('.item-location').getBoundingClientRect().toJSON(),
            sorting: header.querySelector('.sort-controls').getBoundingClientRect().toJSON(),
        };
    })()`);

    async function start(path = '/') {
        await call('Fetch.disable');
        network.images = network.walk = network.folders = network.metadata = false;
        held.length = 0;
        await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
        await open('/');
        await evaluate('sessionStorage.clear()');
        await open(path);
    }
    await call('Runtime.enable');
    await call('Network.enable');
    await call('Page.enable');
    return {call, evaluate, waitFor, open, start, click, newTab, imageIs, waitImage, key,
        nativeKey, wheel, screenshot, readyImage, pause, position, viewerUrl, presentation, setZoom, openInfo, headerPositions,
        requests, exceptions, network, held, close: () => socket.close()};
}
