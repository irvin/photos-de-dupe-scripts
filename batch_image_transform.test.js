const assert = require('assert');
const { describe, it } = require('node:test');

const { mcu, validateFastCropOrigin } = require('./batch_image_transform');

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
