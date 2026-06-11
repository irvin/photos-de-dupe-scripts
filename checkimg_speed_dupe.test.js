#!/usr/bin/env node

const assert = require('assert');
const { describe, it } = require('node:test');
const {
  SPLIT_TIME_SEC,
  splitIntoSequences,
  markPhotosToRemove,
  speedKph,
} = require('./checkimg_speed_dupe');

const SEC = 1000;
const coord = (lat, lon) => ({ lat, lon });

const photo = (name, timeSec, coordinates) => ({
  name,
  time: timeSec * SEC,
  coordinates,
});

describe('splitIntoSequences', () => {
  it('keeps photos within 30 seconds in one sequence', () => {
    const files = [
      photo('a', 0, coord(0, 0)),
      photo('b', 5, coord(0, 0)),
      photo('c', 10, coord(0, 0)),
      photo('d', 15, coord(0, 0)),
    ];
    const { sequences, timeGapSplits } = splitIntoSequences(files);
    assert.strictEqual(sequences.length, 1);
    assert.strictEqual(sequences[0].length, 4);
    assert.strictEqual(timeGapSplits, 0);
  });

  it('splits when adjacent gap exceeds 30 seconds', () => {
    const files = [
      photo('a', 0, coord(0, 0)),
      photo('b', 45, coord(0, 0)),
      photo('c', 50, coord(0, 0)),
    ];
    const { sequences, timeGapSplits } = splitIntoSequences(files);
    assert.strictEqual(sequences.length, 2);
    assert.deepStrictEqual(sequences[0].map(f => f.name), ['a']);
    assert.deepStrictEqual(sequences[1].map(f => f.name), ['b', 'c']);
    assert.strictEqual(timeGapSplits, 1);
  });

  it('splits on invalid or non-positive time delta', () => {
    const files = [
      photo('a', 10, coord(0, 0)),
      photo('b', 10, coord(0, 0)),
      photo('c', 5, coord(0, 0)),
    ];
    const { sequences, timeGapSplits } = splitIntoSequences(files);
    assert.strictEqual(sequences.length, 3);
    assert.strictEqual(timeGapSplits, 2);
  });
});

describe('markPhotosToRemove', () => {
  it('removes nothing for normal driving speeds', () => {
    const files = [
      photo('a', 0, coord(35.0, 139.0)),
      photo('b', 5, coord(35.001, 139.0)),
      photo('c', 10, coord(35.002, 139.0)),
    ];
    const { sequences } = splitIntoSequences(files);
    const { toRemove } = markPhotosToRemove(sequences, 1);
    assert.strictEqual(toRemove.size, 0);
  });

  it('keeps only the last photo in a long stationary run', () => {
    const files = [
      photo('a', 0, coord(35.0, 139.0)),
      photo('b', 5, coord(35.0, 139.0)),
      photo('c', 10, coord(35.0, 139.0)),
      photo('d', 15, coord(35.0, 139.0)),
    ];
    const { sequences } = splitIntoSequences(files);
    const { toRemove } = markPhotosToRemove(sequences, 1);
    assert.deepStrictEqual([...toRemove].sort(), ['a', 'b', 'c']);
  });

  it('does not compare photos across a capture gap', () => {
    const files = [
      photo('a', 0, coord(35.0, 139.0)),
      photo('b', 45, coord(35.0, 139.0)),
    ];
    const { sequences } = splitIntoSequences(files);
    const { toRemove } = markPhotosToRemove(sequences, 1);
    assert.strictEqual(toRemove.size, 0);
  });

  it('keeps moving photos before a slow segment when speed recovers', () => {
    const files = [];
    let t = 0;
    for (let i = 0; i < 10; i++) {
      files.push(photo(`move-${i}`, t, coord(35.0 + i * 0.001, 139.0)));
      t += 5;
    }
    for (let i = 0; i < 20; i++) {
      files.push(photo(`stop-${i}`, t, coord(35.009, 139.0)));
      t += 5;
    }
    files.push(photo('resume', t, coord(35.02, 139.0)));

    const { sequences } = splitIntoSequences(files);
    const { toRemove } = markPhotosToRemove(sequences, 1);
    for (let i = 0; i < 9; i++) {
      assert.ok(!toRemove.has(`move-${i}`), `move-${i} should be kept`);
    }
    assert.ok(!toRemove.has('resume'));
    assert.ok(!toRemove.has('stop-19'));
    assert.ok(toRemove.has('move-9'));
    assert.strictEqual(toRemove.size, 20);
  });

  it('does not compare across missing GPS photos', () => {
    const files = [
      photo('a', 0, coord(35.0, 139.0)),
      photo('b', 5, null),
      photo('c', 10, coord(35.0, 139.0)),
      photo('d', 15, coord(35.0, 139.0)),
    ];
    const { sequences } = splitIntoSequences(files);
    const { toRemove, unmeasurablePairs } = markPhotosToRemove(sequences, 1);
    assert.strictEqual(toRemove.size, 1);
    assert.ok(toRemove.has('c'));
    assert.strictEqual(unmeasurablePairs, 2);
  });

  it('produces stable results on repeated evaluation', () => {
    const files = [
      photo('a', 0, coord(35.0, 139.0)),
      photo('b', 5, coord(35.0, 139.0)),
      photo('c', 10, coord(35.0, 139.0)),
      photo('d', 15, coord(35.001, 139.0)),
    ];
    const { sequences } = splitIntoSequences(files);
    const first = markPhotosToRemove(sequences, 1);
    const remaining = files.filter(f => !first.toRemove.has(f.name));
    const { sequences: secondSequences } = splitIntoSequences(remaining);
    const second = markPhotosToRemove(secondSequences, 1);
    assert.strictEqual(second.toRemove.size, 0);
  });
});

describe('speedKph', () => {
  it('returns null for non-positive time delta', () => {
    const a = photo('a', 10, coord(0, 0));
    const b = photo('b', 10, coord(1, 1));
    assert.strictEqual(speedKph(a, b), null);
  });
});

describe('constants', () => {
  it('uses a 30 second split threshold', () => {
    assert.strictEqual(SPLIT_TIME_SEC, 30);
  });
});
