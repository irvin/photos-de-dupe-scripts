const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const piexif = require('piexifjs');

const {
  PANORAMAX_CSV,
  buildCsvText,
  findFoldersWithJpeg,
  formatOffsetColon,
  parseExifDateTime,
  parseTimezoneOffset,
  readCaptureTimeFromExif,
  writePanoramaxCsv,
} = require('./make_panoramax_csv');

describe('make_panoramax_csv helpers', () => {
  it('parses timezone and formats +12:00', () => {
    assert.strictEqual(parseTimezoneOffset('+12:00'), 12 * 60);
    assert.strictEqual(formatOffsetColon(12 * 60), '+12:00');
    assert.strictEqual(formatOffsetColon(-(5 * 60 + 30)), '-05:30');
  });

  it('parses EXIF DateTimeOriginal', () => {
    assert.deepStrictEqual(parseExifDateTime('2026:08:14 18:06:32'), {
      year: 2026,
      month: 8,
      day: 14,
      hour: 18,
      minute: 6,
      second: 32,
      ms: 0,
    });
  });

  it('builds CSV with header, sort, and LF', () => {
    const text = buildCsvText([
      {
        file: 'b.jpg',
        capture_time: '2026-08-14T18:06:33+12:00',
      },
      {
        file: 'a.jpg',
        capture_time: '2026-08-14T18:06:32+12:00',
      },
    ]);
    assert.strictEqual(
      text,
      'file,capture_time\na.jpg,2026-08-14T18:06:32+12:00\nb.jpg,2026-08-14T18:06:33+12:00\n'
    );
  });

  it('finds every subdirectory that contains JPEGs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-csv-folders-'));
    try {
      const a = path.join(root, 'A');
      const b = path.join(root, 'nested', 'B');
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(b, { recursive: true });
      fs.writeFileSync(path.join(a, 'x.jpg'), 'x');
      fs.writeFileSync(path.join(b, 'y.JPG'), 'y');
      fs.writeFileSync(path.join(root, 'readme.txt'), 'no');
      const found = findFoldersWithJpeg(root).map((d) => path.relative(root, d));
      assert.deepStrictEqual(found.sort(), ['A', path.join('nested', 'B')].sort());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readCaptureTimeFromExif', () => {
  it('reads DateTimeOriginal + OffsetTimeOriginal from a real sample when present', () => {
    const sample =
      '/Users/Irvin/Downloads/360 photos/wip/20260814/MIO/2026-08-14T18-06-32+1200_f00157.jpg';
    if (!fs.existsSync(sample)) {
      return;
    }
    const result = readCaptureTimeFromExif(sample, null);
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.capture_time, '2026-08-14T18:06:32+12:00');
    assert.strictEqual(result.offsetSource, 'exif');

    const forced = readCaptureTimeFromExif(sample, 9 * 60);
    assert.strictEqual(forced.error, undefined);
    assert.strictEqual(forced.capture_time, '2026-08-14T18:06:32+09:00');
    assert.strictEqual(forced.offsetSource, 'forced');
  });

  it('writes panoramax.csv atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-csv-write-'));
    try {
      const target = writePanoramaxCsv(dir, [
        {
          file: '2026-08-14T18-06-32+1200_f00157.jpg',
          capture_time: '2026-08-14T18:06:32+12:00',
        },
      ]);
      assert.strictEqual(target, path.join(dir, PANORAMAX_CSV));
      const text = fs.readFileSync(target, 'utf8');
      assert.ok(text.startsWith('file,capture_time\n'));
      assert.match(text, /2026-08-14T18:06:32\+12:00/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// silence unused import if piexif tree-shaken in lint environments
void piexif;
