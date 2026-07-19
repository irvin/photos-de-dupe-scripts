const assert = require('assert');
const { describe, it } = require('node:test');

const {
  mcu,
  normalTransformArgs,
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
  it('normalizes EXIF orientation before rotating and cropping', () => {
    const commandArgs = normalTransformArgs(
      { input: 'input.jpg' },
      { crop: { x: 100, y: 50 }, cropOrigin: { x: 0, y: 0 }, rotate: 2, quality: 95 },
      'output.jpg'
    );

    assert.ok(commandArgs.indexOf('-auto-orient') < commandArgs.indexOf('-rotate'));
    assert.ok(commandArgs.indexOf('-auto-orient') < commandArgs.indexOf('-crop'));
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
