import assert from 'node:assert/strict';
import { FloatType } from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { encodeHdr, flipVertically, grayscaleFloat, resizeFloat } from '../scripts/preprocess-environments.mjs';

const source = new Float32Array(16 * 8 * 4);
for (let index = 0; index < source.length; index += 4) {
  source[index] = 1; source[index + 1] = .5; source[index + 2] = .25; source[index + 3] = 1;
}
source[0] = 10;
source[(7 * 16) * 4] = 20;
const flipped = flipVertically(source, 16, 8);
assert.equal(flipped[0], 20, '垂直翻转应将最后一行写入首行');
assert.equal(flipped[(7 * 16) * 4], 10, '垂直翻转应将首行写入最后一行');
assert.deepEqual(flipVertically(flipped, 16, 8), source, '两次垂直翻转应还原像素');
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
