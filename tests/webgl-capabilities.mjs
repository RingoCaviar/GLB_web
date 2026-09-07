import assert from 'node:assert/strict';
import { exportDimensionCapability } from '../src/webgl-capabilities.js';

const context = {
  MAX_TEXTURE_SIZE: 1,
  MAX_RENDERBUFFER_SIZE: 2,
  getParameter: (parameter) => parameter === 1 ? 16384 : 8192,
};
assert.deepEqual(exportDimensionCapability(context), {
  available: true, maximumDimension: 8192, textureSize: 16384, renderbufferSize: 8192,
});
assert.deepEqual(exportDimensionCapability(null), { available: false, maximumDimension: null });
assert.deepEqual(exportDimensionCapability({ getParameter: () => 0, MAX_TEXTURE_SIZE: 1, MAX_RENDERBUFFER_SIZE: 2 }), {
  available: false, maximumDimension: null,
});
console.log('webgl capabilities tests passed');
