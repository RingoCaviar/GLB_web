import assert from 'node:assert/strict';
import {
  applyBuildingCorrection,
  applyViewerCameraFraming,
} from '../src/camera-framing-application.js';

function fixture() {
  const calls = [];
  const viewer = {
    cameraOrbit: '',
    fieldOfView: '',
    updateComplete: Promise.resolve().then(() => calls.push('updated')),
    jumpCameraToGoal: () => calls.push('jump'),
  };
  return { viewer, calls };
}

{
  const { viewer, calls } = fixture();
  await applyViewerCameraFraming(viewer, {
    theta: 22.5,
    phi: 90,
    radius: 3.25,
    fov: 37,
  }, {
    applyProjection: () => calls.push('projection'),
  });

  assert.equal(viewer.cameraOrbit, '22.5deg 90deg 3.25m');
  assert.equal(viewer.fieldOfView, '37deg');
  assert.deepEqual(calls, ['updated', 'projection']);
}

{
  const { viewer, calls } = fixture();
  await applyViewerCameraFraming(viewer, {
    theta: 0,
    phi: 75,
    radius: 'auto',
    fov: 45,
  }, {
    immediate: true,
    applyProjection: () => calls.push('projection'),
  });

  assert.equal(viewer.cameraOrbit, '0deg 75deg auto');
  assert.deepEqual(calls, ['updated', 'jump', 'projection']);
}

console.log('camera framing application tests passed');

assert.deepEqual(applyBuildingCorrection({
  theta: 35,
  phi: 61,
  radius: 4,
  fov: 42,
  verticalShift: 0.2,
}, true), {
  theta: 35,
  phi: 61,
  radius: 4,
  fov: 42,
  verticalShift: 0.2,
  buildingCorrection: true,
});
