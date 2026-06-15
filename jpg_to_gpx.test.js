#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const {
  buildGpxXml,
  buildTracks,
  collectJpgFiles,
  discoverBatchJobs,
  parseCliArgs,
} = require('./jpg_to_gpx');

const tempDirs = [];

const makeTempDir = () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpg-to-gpx-test-'));
  tempDirs.push(tempDir);
  return tempDir;
};

const makeRecord = (relPath, utcMs, lat, lon) => ({
  relPath,
  basename: path.basename(relPath),
  utcMs,
  coordinates: { lat, lon, ele: null },
});

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('batch job discovery', () => {
  it('creates one output job for each non-hidden first-level folder', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, 'trip-b', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'trip-a'));
    fs.mkdirSync(path.join(root, '.cache'));
    fs.writeFileSync(path.join(root, 'root.jpg'), '');

    const jobs = discoverBatchJobs(root);

    assert.deepStrictEqual(
      jobs.map((job) => ({
        input: path.relative(root, job.inputFolder),
        output: path.relative(root, job.outputGpx),
      })),
      [
        { input: 'trip-a', output: path.join('trip-a', 'trip-a.gpx') },
        { input: 'trip-b', output: path.join('trip-b', 'trip-b.gpx') },
      ]
    );
  });
});

describe('recursive JPG collection', () => {
  it('includes JPG files in all descendant folders', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, 'part-a', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'part-b'));
    fs.writeFileSync(path.join(root, 'root.jpg'), '');
    fs.writeFileSync(path.join(root, 'part-a', 'one.JPG'), '');
    fs.writeFileSync(path.join(root, 'part-a', 'nested', 'two.jpg'), '');
    fs.writeFileSync(path.join(root, 'part-b', 'ignore.png'), '');

    assert.deepStrictEqual(collectJpgFiles(root), [
      path.join('part-a', 'nested', 'two.jpg'),
      path.join('part-a', 'one.JPG'),
      'root.jpg',
    ]);
  });
});

describe('track construction', () => {
  it('creates named tracks by containing folder and sorts tracks by first point time', () => {
    const inputFolder = path.join('/photos', 'trip-a');
    const records = [
      makeRecord(path.join('later', 'b.jpg'), 20_000, 25, 121),
      makeRecord(path.join('earlier', 'a.jpg'), 10_000, 25, 121),
      makeRecord(path.join('earlier', 'nested', 'c.jpg'), 30_000, 25, 121),
    ];

    const tracks = buildTracks(inputFolder, records, 200, 30);

    assert.deepStrictEqual(
      tracks.map((track) => track.name),
      ['earlier', 'later', 'earlier/nested']
    );
    assert.ok(tracks.every((track) => track.segments.length === 1));
  });

  it('uses the input folder name for JPG files directly under the input folder', () => {
    const inputFolder = path.join('/photos', 'trip-a');
    const tracks = buildTracks(
      inputFolder,
      [makeRecord('root.jpg', 10_000, 25, 121)],
      200,
      30
    );

    assert.strictEqual(tracks[0].name, 'trip-a');
  });

  it('keeps distance and time splitting within each named track', () => {
    const records = [
      makeRecord(path.join('part-a', 'one.jpg'), 0, 25, 121),
      makeRecord(path.join('part-a', 'two.jpg'), 60_000, 25, 121),
      makeRecord(path.join('part-b', 'three.jpg'), 5_000, 25, 121),
    ];

    const tracks = buildTracks('/photos/trip-a', records, 200, 30);
    const partA = tracks.find((track) => track.name === 'part-a');

    assert.strictEqual(tracks.length, 2);
    assert.strictEqual(partA.segments.length, 2);
    assert.strictEqual(partA.timeSplitCount, 1);
  });
});

describe('GPX output', () => {
  it('writes folder names, sequential track numbers, and segments', () => {
    const tracks = buildTracks(
      '/photos/trip-a',
      [
        makeRecord(path.join('part&one', 'a.jpg'), 0, 25, 121),
        makeRecord(path.join('part&one', 'b.jpg'), 60_000, 25, 121),
        makeRecord(path.join('part-two', 'c.jpg'), 120_000, 25, 121),
      ],
      200,
      30
    );

    const xml = buildGpxXml(tracks);

    assert.match(xml, /<name>part&amp;one<\/name>/);
    assert.match(xml, /<name>part&amp;one<\/name>\n   <number>1<\/number>/);
    assert.match(xml, /<name>part-two<\/name>\n   <number>2<\/number>/);
    assert.strictEqual((xml.match(/<trk>/g) || []).length, 2);
    assert.strictEqual((xml.match(/<trkseg>/g) || []).length, 3);
  });
});

describe('CLI parsing', () => {
  it('accepts batch mode with existing shared options', () => {
    const options = parseCliArgs([
      'node',
      'jpg_to_gpx.js',
      '--batch',
      './photos',
      '--timezone',
      '+08:00',
      '--force',
    ]);

    assert.strictEqual(options.batchRoot, './photos');
    assert.strictEqual(options.timezone, '+08:00');
    assert.strictEqual(options.force, true);
    assert.deepStrictEqual(options.positional, []);
  });
});
