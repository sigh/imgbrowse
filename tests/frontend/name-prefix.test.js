import assert from 'node:assert/strict';
import test from 'node:test';
import {namePrefix} from '../../image_browser/web/static/shared/name-prefix.js';

test('shared titles shrink before complete chapter numbers and names', () => {
    const names = ['Long collection - Chapter 02.cbz', 'Long collection - Chapter 01.cbz'];
    const before = [...names];
    const prefix = namePrefix(names);
    assert.equal(prefix, 'Long collection - Chapter '.length);
    assert.deepEqual(names.map(name => name.slice(prefix)), ['02.cbz', '01.cbz']);
    assert.deepEqual(names, before, 'Display order remains the server ordering');
    assert.equal(namePrefix([...names].reverse()), prefix);
});

test('unrelated names and partial words use ordinary end truncation', () => {
    assert.equal(namePrefix(['Cowboy Bebop', 'Cats']), 0);
    assert.equal(namePrefix(['Cowboy Bebop', 'Cowboy Movie']), 'Cowboy '.length);
    assert.equal(namePrefix(['Cowboy', 'Cowbells']), 0);
    assert.equal(namePrefix(['Long collection - 01', 'Long collection - 02', 'Unrelated']), 0);
});

test('a single shared prefix preserves differences in the middle of names', () => {
    const names = ['Series 001 Issue', 'Series 001 Special', 'Series 002 Issue', 'Series 002 Special'];
    const prefix = namePrefix(names);
    assert.deepEqual(names.map(name => name.slice(prefix)), ['001 Issue', '001 Special', '002 Issue', '002 Special']);
});

test('Unicode and repeated spaces stay intact at the boundary', () => {
    assert.equal(namePrefix(['Series 😃', 'Series 😄']), 'Series '.length);
    assert.equal(namePrefix(['Series 😃  01', 'Series 😃  02']), 'Series 😃  '.length);
    assert.equal(namePrefix(['A😀', 'A😀Extra']), 0);
    assert.equal(namePrefix(['Album_001.cbz', 'Album_002.cbz']), 'Album_'.length);
});

test('empty listings, single names, and a complete shared name stay intact', () => {
    for (const names of [[], ['only'], ['', 'another'], ['same', 'same'], ['Series ', 'Series Extra']]) {
        assert.equal(namePrefix(names), 0);
    }
    assert.equal(namePrefix(['Series Volume', 'Series Volume Special']), 'Series '.length);
});

test('large listings preserve full numeric identifiers', () => {
    const names = Array.from({length:2400}, (_, index) => 'A long collection prefix - ' + String(index).padStart(4, '0'));
    const prefix = namePrefix(names);
    assert.equal(prefix, 'A long collection prefix - '.length);
    assert.ok(names.every(name => name.slice(prefix).length === 4));
});
