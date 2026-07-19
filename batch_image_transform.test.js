const assert = require('assert');
const { describe, it } = require('node:test');

const {
  mcu,
  normalTransformArgs,
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
