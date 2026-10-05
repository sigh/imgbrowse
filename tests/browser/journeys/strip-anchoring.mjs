import assert from 'node:assert/strict';

export async function run(browser) {
    await browser.start();
    const results = await browser.evaluate(`(async () => {
        const {ThumbnailStrip} = await import('/static/viewer/thumbnail-strip.js');
        const {TaskScope} = await import('/static/shared/dom.js');
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;width:300px';
        const container = document.createElement('div');
        container.className = 'viewer-strip';
        host.append(container); document.body.append(host);
        const strip = new ThumbnailStrip(container, {thumbnail:async () => {}, schedule:() => {}}, () => {});
        strip.resizeObserver.disconnect();
        try {
            strip.labelRoot = 'Album'; strip.collection = 'Album';
            strip.ordering = {sort:'natural', order:'asc'};
            strip.visible = true; strip.scope = new TaskScope();
            strip.window.paths = Array.from({length:30}, (_, index) =>
                'Album/Chapter' + String(index+1).padStart(2,'0') + (index % 3 === 1 ? '/clip.webm' : '/page.jpg'));
            strip.edges.forEach(edge => { edge.done = true; });
            const setup = (index, selectedIndex = index) => {
                strip.labelRoot = 'Album'; strip.image = strip.paths[selectedIndex];
                strip.followImage = true; strip.setSize(64); strip.followImage = false;
                strip.scrollTo(strip.paddingStart + strip.layout.items[index].left + 50);
                strip.render();
                return strip.nodes.get(strip.paths[index]);
            };
            const resize = [[6, 6], [7, 7], [6, 0], [7, 0], [6, 7]].map(([index, selectedIndex]) => {
                const item = setup(index, selectedIndex);
                const before = item.label.getBoundingClientRect();
                strip.setSize(128);
                const grown = item.label.getBoundingClientRect();
                strip.setSize(48);
                const shrunk = item.label.getBoundingClientRect();
                return {growShift:grown.left-before.left, shrinkShift:shrunk.left-before.left,
                    beforeWidth:before.width, grownWidth:grown.width, shrunkWidth:shrunk.width};
            });
            const imagePoints = [6, 7].map(index => {
                const item = setup(index);
                strip.scrollTo(strip.paddingStart + strip.layout.items[index].thumbnailLeft
                    + strip.width * .4);
                strip.render();
                const before = item.button.getBoundingClientRect(), viewport = container.getBoundingClientRect();
                const fraction = (viewport.left - before.left) / before.width;
                strip.setSize(128);
                const after = item.button.getBoundingClientRect();
                return after.left + fraction * after.width - viewport.left;
            });
            const item = setup(6), button = item.button;
            button.focus({preventScroll:true});
            const before = button.getBoundingClientRect().left;
            const state = {collection:'Album', image:strip.image, sort:'natural', order:'asc'};
            strip.show({...state, folder:'Album/Chapter07'}, true);
            const removedTitle = button.getBoundingClientRect().left - before;
            strip.show({...state, folder:'Album'}, true);
            const restoredTitle = button.getBoundingClientRect().left - before;
            const retained = strip.nodes.get(strip.image).button === button && document.activeElement === button;
            strip.followImage = true; strip.centerImage();
            const settleScroll = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await settleScroll();
            button.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
            for (const options of [{deltaY:50, ctrlKey:true}, {deltaY:50, metaKey:true}, {deltaY:0}]) {
                container.dispatchEvent(new WheelEvent('wheel', {...options, cancelable:true}));
            }
            strip.setSize(128);
            const viewport = container.getBoundingClientRect();
            const centered = () => {
                const selected = strip.nodes.get(strip.image).button.getBoundingClientRect();
                return Math.abs((selected.left + selected.right - viewport.left - viewport.right) / 2) < 1;
            };
            const centeredAfterInput = centered();
            const scrollLeft = container.scrollLeft;
            container.dispatchEvent(new WheelEvent('wheel', {deltaY:40, cancelable:true}));
            await settleScroll();
            const scrolled = container.scrollLeft > scrollLeft;
            const manualLeft = button.getBoundingClientRect().left;
            strip.setSize(64);
            const manualScroll = scrolled && Math.abs(button.getBoundingClientRect().left - manualLeft) < 1;
            strip.show({...state, folder:'Album', image:strip.paths[7]}, true);
            const selectionCentered = centered();
            return {resize, imagePoints, removedTitle, restoredTitle,
                retained, centeredAfterInput, manualScroll, selectionCentered};
        } finally { strip.stop(); host.remove(); }
    })()`);
    for (const result of results.resize) {
        assert.ok(Math.abs(result.growShift) < 1 && Math.abs(result.shrinkShift) < 1,
            'Manually scrolled album titles stay fixed when thumbnails grow or shrink: ' + JSON.stringify(result));
        assert.equal(result.grownWidth, result.beforeWidth);
        assert.equal(result.shrunkWidth, result.beforeWidth);
    }
    assert.ok(results.imagePoints.every(shift => Math.abs(shift) < 1),
        'Resizing preserves the visible point within both image and video thumbnails: ' + JSON.stringify(results.imagePoints));
    assert.ok(Math.abs(results.removedTitle) < 1 && Math.abs(results.restoredTitle) < 1,
        'Changing the browsing folder preserves the thumbnail position as titles disappear and return: ' + JSON.stringify(results));
    assert.ok(results.retained, 'Title changes retain the selected thumbnail node and keyboard focus');
    assert.ok(results.centeredAfterInput, 'Pointer presses and wheel events that do not scroll keep the selected thumbnail centered during resizing');
    assert.ok(results.manualScroll, 'Actual scrolling preserves the manually chosen viewport during resizing');
    assert.ok(results.selectionCentered, 'Changing the selection centers its thumbnail after manual scrolling');
}
