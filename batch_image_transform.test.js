const assert = require('assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  mcu,
  transformWithSharp,
  args,
  buildFastMetadataArgFile,
  validateFastCropOrigin,
  validateOutputDimensions,
  validateSampleConsistency,
} = require('./batch_image_transform');

describe('fast crop MCU validation', () => {
  it('derives MCU dimensions from JPEG sampling factors', () => {
    assert.deepStrictEqual(mcu('2x2'), { w: 16, h: 16 });
    assert.deepStrictEqual(mcu('2x1'), { w: 16, h: 8 });
    assert.deepStrictEqual(mcu('1x2'), { w: 8, h: 16 });
  });

  it('rejects a crop origin that jpegtran would silently move', () => {
    assert.throws(
      () => validateFastCropOrigin({ sampling: '2x2' }, { x: 8, y: 8 }),
      /未對齊 MCU 16x16/
    );
    assert.doesNotThrow(
      () => validateFastCropOrigin({ sampling: '2x2' }, { x: 16, y: 32 })
    );
  });
});

describe('normal transform orientation', () => {
  it('normalizes EXIF orientation before rotating and cropping', async () => {
    const sharp = require('sharp');
    const width = 32;
    const height = 16;
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const channel = i % width < width / 2 ? 0 : 2;
      pixels[i * 3 + channel] = 255;
    }
    const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-image-transform-test-'));
    try {
      const output = path.join(tempDir, 'output.jpg');
      await transformWithSharp(input, output, {
        crop: { x: 6, y: 4 }, cropOrigin: { x: 2, y: 1 }, rotate: 90, quality: 95,
      });
      const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 6);
      assert.equal(info.height, 4);
      // EXIF 方向和指定旋轉各轉 90°，所以原本右半的藍色落在裁切框內。
      assert.ok(data[2] > 200 && data[0] < 50);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('output dimension validation', () => {
  it('rejects a crop that was clipped to different dimensions', () => {
    assert.throws(
      () => validateOutputDimensions({ width: 16, height: 16 }, { x: 32, y: 32 }),
      /裁切結果為 16x16/
    );
    assert.doesNotThrow(
      () => validateOutputDimensions({ width: 32, height: 32 }, { x: 32, y: 32 })
    );
  });
});

describe('sample consistency validation', () => {
  it('rejects mixed dimensions or sampling factors', () => {
    assert.throws(
      () => validateSampleConsistency([
        { width: 1920, height: 1080, sampling: '2x2' },
        { width: 1920, height: 1080, sampling: '1x1' },
      ]),
      /抽查 JPEG 規格不一致/
    );
    assert.doesNotThrow(
      () => validateSampleConsistency([
        { width: 1920, height: 1080, sampling: '2x2' },
        { width: 1920, height: 1080, sampling: '2x2' },
      ])
    );
  });
});

describe('numeric CLI validation', () => {
  const base = ['node', 'batch_image_transform.js', '--input-dir', 'in', '--output-dir', 'out', '--crop', '10x10'];

  it('rejects invalid concurrency and sample counts', () => {
    assert.throws(() => args([...base, '--concurrency', 'nope']), /--concurrency/);
    assert.throws(() => args([...base, '--sample-count', '0']), /--sample-count/);
  });

  it('rejects invalid rotation and JPEG quality', () => {
    assert.throws(() => args([...base, '--rotate-deg', 'NaN']), /--rotate-deg/);
    assert.throws(() => args([...base, '--jpeg-quality', '101']), /--jpeg-quality/);
  });
});

describe('fast metadata update scope', () => {
  it('builds an ExifTool batch containing only written output files', () => {
    const text = buildFastMetadataArgFile(
      ['/output/new-a.jpg', '/output/new-b.jpg'],
      { x: 1920, y: 816 }
    );

    assert.match(text, /-ExifImageWidth=1920/);
    assert.match(text, /-ExifImageHeight=816/);
    assert.match(text, /\/output\/new-a\.jpg/);
    assert.match(text, /\/output\/new-b\.jpg/);
    assert.doesNotMatch(text, /-r|-ext/);
  });
});
