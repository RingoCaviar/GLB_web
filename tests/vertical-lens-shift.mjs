import assert from 'node:assert/strict';
import {
  createVerticalLensShiftAdapter,
} from '../src/vertical-lens-shift-core.js';

const sceneKey = Symbol('scene');
const needsRenderKey = Symbol('needsRender');
const { applyVerticalLensShift, verticalLensShiftCapability } = createVerticalLensShiftAdapter({
  getScene: (viewer) => viewer?.[sceneKey],
  requestRender: (viewer) => viewer?.[needsRenderKey]?.(),
  canRequestRender: (viewer) => typeof viewer?.[needsRenderKey] === 'function',
});

function compatibleViewer() {
  const calls = [];
  const camera = {
    isPerspectiveCamera: true,
    setViewOffset: (...args) => calls.push(['set', ...args]),
    clearViewOffset: () => calls.push(['clear']),
    updateProjectionMatrix: () => calls.push(['update']),
  };
  const viewer = {
    [sceneKey]: { camera, width: 640, height: 480 },
    [needsRenderKey]: () => calls.push(['render']),
  };
  return { viewer, camera, calls };
}

{
  const { viewer } = compatibleViewer();
  assert.deepEqual(verticalLensShiftCapability(viewer), { available: true, reason: null });
}

{
  const { viewer, calls } = compatibleViewer();
  assert.deepEqual(applyVerticalLensShift(viewer, 0.25), { applied: true, reason: null });
  assert.deepEqual(calls, [
    ['set', 640, 480, 0, -120, 640, 480],
    ['update'],
    ['render'],
  ]);
}

{
  const { viewer, calls } = compatibleViewer();
  applyVerticalLensShift(viewer, 0);
  assert.deepEqual(calls, [['clear'], ['update'], ['render']]);
}

for (const [viewer, reason] of [
  [{}, 'SCENE_UNAVAILABLE'],
  [{ [sceneKey]: { camera: { isPerspectiveCamera: false } } }, 'PERSPECTIVE_CAMERA_UNAVAILABLE'],
  [{ [sceneKey]: { camera: { isPerspectiveCamera: true } } }, 'VIEW_OFFSET_UNAVAILABLE'],
  [{ [sceneKey]: { camera: compatibleViewer().camera } }, 'RENDER_REQUEST_UNAVAILABLE'],
]) {
  assert.deepEqual(verticalLensShiftCapability(viewer), { available: false, reason });
  assert.deepEqual(applyVerticalLensShift(viewer, 0.2), { applied: false, reason });
}

console.log('vertical lens shift tests passed');
