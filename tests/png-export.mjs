import assert from 'node:assert/strict';
import { finalizePngExport, fxaaPixels } from '../src/png-export.js';

const edge = new Uint8ClampedArray([
  0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
  0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
  0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
]);
const softened = fxaaPixels(edge, 3, 3);
assert.ok(softened[16] > 0 && softened[16] < 255);
assert.equal(softened[19], 255);

const transparentBlob = { id: 'transparent-source' };
assert.equal(await finalizePngExport(transparentBlob, { transparent: true }), transparentBlob);

const calls = [];
const bitmap = { width: 320, height: 180, close: () => calls.push(['close']) };
const outputBlob = { id: 'opaque-output' };
const canvas = {
  width: 0,
  height: 0,
  getContext: () => ({
    set fillStyle(value) { calls.push(['fillStyle', value]); },
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
  }),
  toBlob: (callback, mimeType) => {
    calls.push(['toBlob', mimeType]);
    callback(outputBlob);
  },
};
const opaqueBlob = await finalizePngExport(transparentBlob, {
  transparent: false,
  background: '#123456',
  createBitmap: async () => bitmap,
  createCanvas: () => canvas,
});
assert.equal(opaqueBlob, outputBlob);
assert.deepEqual([canvas.width, canvas.height], [320, 180]);
assert.deepEqual(calls, [
  ['fillStyle', '#123456'],
  ['fillRect', 0, 0, 320, 180],
  ['drawImage', bitmap, 0, 0, 320, 180],
  ['toBlob', 'image/png'],
  ['close'],
]);

const resizedCalls = [];
const resizedCanvas = {
  width: 0,
  height: 0,
  getContext: () => ({
    set imageSmoothingEnabled(value) { resizedCalls.push(['smoothing', value]); },
    set imageSmoothingQuality(value) { resizedCalls.push(['quality', value]); },
    drawImage: (...args) => resizedCalls.push(['drawImage', ...args]),
  }),
  toBlob: (callback) => callback({ id: 'resized-output' }),
};
assert.deepEqual(await finalizePngExport(transparentBlob, {
  transparent: true,
  width: 160,
  height: 90,
  createBitmap: async () => bitmap,
  createCanvas: () => resizedCanvas,
}), { id: 'resized-output' });
assert.deepEqual([resizedCanvas.width, resizedCanvas.height], [160, 90]);
assert.deepEqual(resizedCalls, [
  ['smoothing', true],
  ['quality', 'high'],
  ['drawImage', bitmap, 0, 0, 160, 90],
]);

try {
  await finalizePngExport(transparentBlob, {
    transparent: false,
    background: '#ffffff',
    createBitmap: async () => { throw new Error('decode failed'); },
  });
} catch (error) {
  assert.equal(error.message, 'decode failed');
}

console.log('png export tests passed');
