import assert from 'node:assert/strict';
import {
  loadSharedCameraFraming,
  saveSharedCameraFraming,
  SHARED_CAMERA_FRAMING_STORAGE_KEY,
} from '../src/shared-camera-framing.js';

const values = new Map();
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
};

assert.deepEqual(loadSharedCameraFraming(storage), { theta: 0, phi: 75, fov: 45, verticalShift: 0, buildingCorrection: false });
assert.equal(saveSharedCameraFraming({ theta: 22.5, phi: 60, fov: 37, verticalShift: 0.25, buildingCorrection: true }, storage), true);
assert.deepEqual(loadSharedCameraFraming(storage), { theta: 22.5, phi: 60, fov: 37, verticalShift: 0.25, buildingCorrection: true });
assert.equal(saveSharedCameraFraming({ theta: 999, phi: -2, fov: 200, verticalShift: -9 }, storage), true);
assert.deepEqual(loadSharedCameraFraming(storage), { theta: 180, phi: 1, fov: 90, verticalShift: -0.5, buildingCorrection: false });
assert.equal(saveSharedCameraFraming({ theta: 'bad', phi: 60, fov: 37 }, storage), false);
values.set(SHARED_CAMERA_FRAMING_STORAGE_KEY, JSON.stringify({ theta: 10, phi: 80, fov: 50 }));
assert.deepEqual(loadSharedCameraFraming(storage), { theta: 10, phi: 80, fov: 50, verticalShift: 0, buildingCorrection: false });
values.set(SHARED_CAMERA_FRAMING_STORAGE_KEY, '{broken');
assert.deepEqual(loadSharedCameraFraming(storage), { theta: 0, phi: 75, fov: 45, verticalShift: 0, buildingCorrection: false });

console.log('shared camera framing tests passed');
