import assert from 'node:assert/strict';
import test from 'node:test';
import {WheelGesture, WheelMode} from '../../image_browser/web/static/viewer/wheel-gesture.js';

test('fitted pages respond immediately and continued movement turns more pages', () => {
    const wheel = new WheelGesture();
    assert.deepEqual(wheel.update(1, 0), {native: false, turn: true, fresh: true});
    for (let i = 1; i < 10; i++) assert.equal(wheel.update(10, i * 8).turn, false);
    assert.equal(wheel.update(10, 80).turn, true);
    assert.equal(wheel.update(10, 88).turn, false);
    assert.equal(wheel.update(-1, 96).turn, true, 'Reversing responds immediately');
    assert.equal(wheel.update(-1, 500).turn, true, 'A new gesture responds immediately');
});

test('native scrolling continues to the edge; a new gesture turns the page', () => {
    const wheel = new WheelGesture();
    assert.deepEqual(wheel.update(80, 0, WheelMode.NATIVE_SCROLL), {native: true, turn: false, fresh: true});
    assert.equal(wheel.update(80, 50, WheelMode.EDGE_TURN).native, true);
    assert.deepEqual(wheel.update(80, 500, WheelMode.EDGE_TURN), {native: false, turn: true, fresh: true});
    assert.deepEqual(wheel.update(60, 550, WheelMode.NATIVE_SCROLL), {native: false, turn: false, fresh: false});
    assert.equal(wheel.update(-1, 560, WheelMode.NATIVE_SCROLL).native, true);
});

test('switching to fitted pages uses page turns without waiting for the gesture to end', () => {
    const wheel = new WheelGesture();
    wheel.update(80, 0, WheelMode.NATIVE_SCROLL);
    assert.deepEqual(wheel.update(100, 50, WheelMode.PAGE_TURN), {native: false, turn: true, fresh: false});
});
