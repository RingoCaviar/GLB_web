import assert from 'node:assert/strict';
import { FloatType } from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { encodeHdr, grayscaleFloat, resizeFloat } from '../scripts/preprocess-environments.mjs';

const source = new Float32Array(16 * 8 * 4);
for (let index = 0; index < source.length; index += 4) {
  source[index] = 1; source[index + 1] = .5; source[index + 2] = .25; source[index + 3] = 1;
}
const resized = resizeFloat(source, 16, 8, 8);
assert.deepEqual({ width: resized.width, height: resized.height }, { width: 8, height: 4 });
const grayscale = grayscaleFloat(resized.data);
assert.equal(grayscale[0], grayscale[1]);
assert.equal(grayscale[1], grayscale[2]);
const bytes = encodeHdr(grayscale, resized.width, resized.height);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const decoded = new RGBELoader().setDataType(FloatType).parse(buffer);
assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: 8, height: 4 });
console.log('environment preprocess tests passed');
