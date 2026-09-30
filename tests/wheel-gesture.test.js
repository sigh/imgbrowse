import assert from 'node:assert/strict';
import test from 'node:test';
import {WheelGesture} from '../image_browser/web/static/wheel-gesture.js';

test('momentum cannot turn another page after reaching an edge', () => {
    const gesture = new WheelGesture();
    assert.equal(gesture.update(80, 0), true);
    gesture.consume();
    for (const [time, delta] of [[16, 60], [50, 35], [100, 12], [170, 2]]) {
        assert.equal(gesture.update(delta, time), false);
        assert.equal(gesture.consumed, true);
    }
    assert.equal(gesture.update(80, 500), true);
    assert.equal(gesture.consumed, false);
});

test('a reversal starts a new directional gesture', () => {
    const gesture = new WheelGesture();
    gesture.update(80, 0);
    gesture.consume();
    assert.equal(gesture.update(-80, 100), true);
    assert.equal(gesture.consumed, false);
});
