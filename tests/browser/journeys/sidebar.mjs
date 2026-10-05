import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

export async function run(browser, {fixtureRoot, first}) {
    const {evaluate, waitFor, call, click, nativeKey, readyImage, open, screenshot} = browser;
    const prefix = 'A very long shared collection title - Chapter ';
    const jojo = "Library/Jojo's Bizarre Adventures/v01";
    const names = [prefix + '01 - Dawn.cbz', prefix + '02 - Noon.cbz', prefix + '03 - Evening.cbz'];
    const folders = {
        'Sidebar spacing':['Cats', 'Cowboy Bebop'],
        'Sidebar words':['Cowboy Bebop', 'Cowboy Movie', 'Cowboy  Bebop'],
        'Angel Heart':['Angel Heart - vol01.cbz', 'Angel Heart - vol02.cbz', 'Angel Heart - vol03.cbz'],
        'Sidebar middle':['A very long collection series 001 Issue.cbz', 'A very long collection series 002 Issue.cbz'],
        'Sidebar tails':[prefix + '01 - ' + 'A lengthy description of the chapter and its publication details '.repeat(2),
            prefix + '02 - ' + 'A lengthy description of the chapter and its publication details '.repeat(2)],
        'Sidebar unrelated':['An unrelated lengthy folder name that cannot fit in the narrow sidebar',
            'Different lengthy folder name that cannot fit in the narrow sidebar'],
        [jojo]:Array.from({length:8}, (_, index) => 'JOJO-v01-' + String(index + 1).padStart(2, '0')),
        'Sidebar names':names,
    };
    const abbreviated = {
        'Angel Heart':['…vol01.cbz', '…vol02.cbz', '…vol03.cbz'],
        'Sidebar middle':['…001 Issue.cbz', '…002 Issue.cbz'],
        'Sidebar tails':folders['Sidebar tails'].map(name => '…' + name.slice(prefix.length)),
        'Sidebar names':['…01 - Dawn.cbz', '…02 - Noon.cbz', '…03 - Evening.cbz'],
    };
    for (const [folder, children] of Object.entries(folders)) {
        for (const name of children) mkdirSync(join(fixtureRoot, folder, name), {recursive:true});
    }
    const checkSpacing = async folder => {
        const spacing = await evaluate(`Array.from(document.querySelectorAll('.tree-row'), row => {
            if (!row.dataset.path.startsWith(${JSON.stringify(folder + '/')})) return null;
            const label = row.querySelector('.tree-label');
            const reference = document.createElement('span');
            reference.textContent = label.textContent;
            reference.style.cssText = 'position:absolute;white-space:pre;';
            label.append(reference);
            const natural = reference.getBoundingClientRect().width;
            reference.remove();
            const range = document.createRange();
            range.selectNodeContents(label);
            return {name:label.textContent, rendered:range.getBoundingClientRect().width, natural};
        }).filter(Boolean)`);
        assert.equal(spacing.length, folders[folder].length);
        for (const name of spacing) {
            assert.ok(Math.abs(name.rendered - name.natural) < 1, 'Names that fit keep their natural spacing: ' + JSON.stringify(name));
        }
    };
    const checkLabels = async (folder, expected = folders[folder], clipped = false) => {
        const labels = await evaluate(`Array.from(document.querySelectorAll('.tree-row'), row => {
            if (!row.dataset.path.startsWith(${JSON.stringify(folder + '/')})) return null;
            const link = row.querySelector('a'), label = link.querySelector('.tree-label');
            return {name:link.getAttribute('aria-label'), title:link.title, text:label.textContent,
                singleText:label.childNodes.length === 1 && label.firstChild.nodeType === Node.TEXT_NODE,
                clipped:label.scrollWidth > label.clientWidth, ellipsis:getComputedStyle(label).textOverflow};
        }).filter(Boolean)`);
        assert.equal(labels.length, expected.length, folder);
        for (const label of labels) {
            const index = folders[folder].indexOf(label.name);
            assert.ok(index >= 0 && label.title.endsWith('/' + label.name), 'Full names stay available on hover and to assistive technology');
            assert.equal(label.text, expected[index], 'The whole shared prefix is omitted consistently');
            assert.ok(label.singleText, 'Each name is one text node');
            assert.equal(label.clipped, clipped, 'Remaining overflow uses the same end truncation rule');
            assert.equal(label.ellipsis, 'ellipsis');
        }
    };
    await browser.start();
    await evaluate("import('/static/data/api.js').then(({refreshScope})=>refreshScope(''))");
    for (const folder of Object.keys(folders)) {
        await open('/?folder=' + encodeURIComponent(folder));
        await waitFor("document.querySelector('.card')");
        if (await evaluate("document.getElementById('folder-tree').hidden")) await click('folders-toggle');
        const selector = `.tree-row[data-path="${folder}"] a`;
        await waitFor(`document.querySelector(${JSON.stringify(selector)})`);
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        const childSelector = `.tree-row[data-path=${JSON.stringify(folder + '/' + folders[folder][0])}] .tree-label`;
        await waitFor(`document.querySelector(${JSON.stringify(childSelector)})`);
        await evaluate(`document.querySelector(${JSON.stringify(childSelector)}).scrollIntoView({block:'start'})`);
        await waitFor(`Array.from(document.querySelectorAll('.tree-row')).filter(row => row.dataset.path.startsWith(${JSON.stringify(folder + '/')})).length === ${folders[folder].length}`);
        await checkLabels(folder, abbreviated[folder], ['Sidebar tails', 'Sidebar unrelated'].includes(folder));
        if (folder === 'Sidebar spacing' || folder === 'Sidebar words') {
            await checkSpacing(folder);
            await screenshot(folder === 'Sidebar words' ? 'sidebar-words' : 'sidebar-spacing');
        } else if (folder !== 'Sidebar names' && folder !== jojo) {
            await screenshot(folder.toLowerCase().replaceAll(' ', '-'));
        }
        if (folder === 'Angel Heart' || folder === jojo) {
            const narrowNames = folder === jojo ? folders[jojo].map(name => '…' + name.slice('JOJO-v01-'.length)) : abbreviated[folder];
            await evaluate("document.getElementById('sidebar-resizer').focus()");
            await nativeKey('Home', 36);
            await waitFor("document.getElementById('folder-tree').getBoundingClientRect().width === 180");
            if (folder === jojo) {
                const geometry = await evaluate(`(() => {
                    const label=document.querySelector(${JSON.stringify(childSelector)});
                    const viewport=document.getElementById('folder-navigation');
                    return {rowRight:label.closest('.tree-row').getBoundingClientRect().right,
                        labelRight:label.getBoundingClientRect().right, viewportRight:viewport.getBoundingClientRect().right,
                        scrollWidth:viewport.scrollWidth, width:viewport.clientWidth};
                })()`);
                assert.ok(geometry.rowRight <= geometry.viewportRight && geometry.labelRight <= geometry.viewportRight,
                    'Nested rows and labels stay within the visible sidebar: ' + JSON.stringify(geometry));
                assert.ok(geometry.scrollWidth <= geometry.width, 'Indentation does not widen the sidebar content');
            }
            await waitFor(`document.querySelector(${JSON.stringify(childSelector)}).textContent === ${JSON.stringify(narrowNames[0])}`);
            await checkLabels(folder, narrowNames);
            await screenshot(folder === jojo ? 'jojo-narrow' : 'angel-heart-narrow');
            await nativeKey('End', 35);
            await waitFor(`document.querySelector(${JSON.stringify(childSelector)}).textContent === ${JSON.stringify(folders[folder][0])}`);
            await checkLabels(folder);
            await checkSpacing(folder);
            await screenshot(folder === jojo ? 'jojo-wide' : 'angel-heart-wide');
            await evaluate("document.getElementById('folder-tree').style.setProperty('--tree-width','240px'); sessionStorage.setItem('sidebarWidth','240');");
            const restoredNames = abbreviated[folder] || folders[folder];
            await waitFor(`document.querySelector(${JSON.stringify(childSelector)}).textContent === ${JSON.stringify(restoredNames[0])}`);
            await checkLabels(folder, abbreviated[folder]);
        }
    }
    await evaluate("window.sidebarLabel=document.querySelector('.tree-row[data-path^=\"Sidebar names/A very long\"] .tree-label'); window.sidebarNameWidth=sidebarLabel.fullWidth;");
    await screenshot('sidebar-names');

    const width = () => evaluate("document.getElementById('folder-tree').getBoundingClientRect().width");
    const initialWidth = await width();
    const handle = await evaluate("document.getElementById('sidebar-resizer').getBoundingClientRect().toJSON()");
    const point = {x:handle.right - 3, y:handle.top + 150};
    await call('Input.dispatchMouseEvent', {type:'mousePressed', button:'left', clickCount:1, ...point});
    await call('Input.dispatchMouseEvent', {type:'mouseMoved', button:'left', buttons:1, x:point.x+120, y:point.y});
    await call('Input.dispatchMouseEvent', {type:'mouseReleased', button:'left', clickCount:1, x:point.x+120, y:point.y});
    await waitFor(`document.getElementById('folder-tree').getBoundingClientRect().width === ${initialWidth + 120}`);
    assert.equal(await evaluate("sessionStorage.getItem('sidebarWidth')"), String(initialWidth + 120));
    assert.ok(await evaluate("sidebarLabel === document.querySelector('.tree-row[data-path^=\"Sidebar names/A very long\"] .tree-label') && sidebarNameWidth === sidebarLabel.fullWidth"), 'Resizing reuses mounted labels and their full-name measurements');
    await checkLabels('Sidebar names', abbreviated['Sidebar names']);
    await screenshot('sidebar-wider');
    await evaluate("document.getElementById('sidebar-resizer').focus()");
    const url = await evaluate('location.href');
    await nativeKey('ArrowLeft', 37);
    assert.equal(await width(), initialWidth + 104);
    assert.equal(await evaluate('location.href'), url, 'Resizer arrows do not navigate folders or images');
    await nativeKey('Home', 36);
    assert.equal(await width(), 180);
    await nativeKey('End', 35);
    assert.equal(await width(), 600);
    assert.equal(await evaluate("document.getElementById('sidebar-resizer').getAttribute('aria-valuenow')"), '600');
    await waitFor("sidebarLabel.textContent.startsWith('A very long')");
    await checkLabels('Sidebar names');
    await checkSpacing('Sidebar names');

    await open(browser.viewerUrl(first));
    await readyImage(first);
    assert.equal(await width(), 600, 'Sidebar width survives navigation');
    await evaluate('window.sidebarReloading=true');
    await call('Page.reload');
    await waitFor("!window.sidebarReloading && document.readyState === 'complete'");
    await readyImage(first);
    assert.equal(await width(), 600, 'Sidebar width survives reload');
    const sourcePoint = () => evaluate("import('/gallery.js').then(({app}) => app.viewer.viewport.point())");
    const before = await sourcePoint();
    const imageUrl = await evaluate('location.href');
    await evaluate("document.getElementById('sidebar-resizer').focus()");
    await nativeKey('ArrowLeft', 37);
    await waitFor("import('/gallery.js').then(({app}) => app.viewer.viewport.box.width === document.getElementById('viewer-canvas').clientWidth)");
    const after = await sourcePoint();
    assert.ok(Math.abs(before.y-after.y) < 2, 'Resizing preserves the viewed passage');
    assert.equal(await evaluate('location.href'), imageUrl, 'Resizing leaves the viewed image selected');

    await call('Emulation.setDeviceMetricsOverride', {width:800,height:900,deviceScaleFactor:1,mobile:false});
    await waitFor("document.getElementById('folder-tree').getBoundingClientRect().width === 480");
    assert.equal(await evaluate("sessionStorage.getItem('sidebarWidth')"), '584', 'Viewport clamping preserves the preferred width');
    await call('Emulation.setDeviceMetricsOverride', {width:320,height:844,deviceScaleFactor:1,mobile:true});
    await open(browser.viewerUrl(first));
    await readyImage(first);
    const canvas = await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()");
    await click('folders-toggle');
    await waitFor("document.getElementById('folder-tree').getBoundingClientRect().width === 288");
    assert.deepEqual(await evaluate("document.getElementById('viewer-canvas').getBoundingClientRect().toJSON()"), canvas, 'A narrow sidebar continues to overlay the image');
    assert.equal(await evaluate("document.getElementById('sidebar-resizer').getAttribute('aria-valuemax')"), '288');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await screenshot('sidebar-mobile');
    await click('folders-toggle');
    await call('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await click('folders-toggle');
    await waitFor("document.getElementById('folder-tree').getBoundingClientRect().width === 584");
}
