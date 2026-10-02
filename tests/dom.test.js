import assert from 'node:assert/strict';
import test from 'node:test';
import {TaskScope} from '../image_browser/web/static/dom.js';

test('disposing a task scope aborts requests and releases resources only once', async () => {
    const scope = new TaskScope();
    let released = 0;
    let delayed = false;
    scope.onDispose(() => released++);
    scope.delay(() => { delayed = true; }, 5);
    scope.dispose();
    scope.dispose();
    scope.onDispose(() => released++);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(released, 2);
    assert.equal(scope.signal.aborted, true);
    assert.equal(delayed, false);
});
