import assert from 'node:assert/strict';
import {
  renderThumbnailWithFraming,
  resolveThumbnailCameraFraming,
  withTemporaryThumbnailViewer,
} from '../src/thumbnail-camera-framing.js';

assert.deepEqual(resolveThumbnailCameraFraming({
  theta: 32,
  phi: 90,
  radius: 8,
  fov: 38,
  verticalShift: 0.25,
  buildingCorrection: true,
}), {
  theta: 32,
  phi: 90,
  radius: 'auto',
  fov: 38,
  verticalShift: 0.25,
  buildingCorrection: true,
});

assert.deepEqual(resolveThumbnailCameraFraming(null), {
  theta: 0,
  phi: 75,
  radius: 'auto',
  fov: 45,
  verticalShift: 0,
  buildingCorrection: false,
});

console.log('thumbnail camera framing tests passed');

{
  const viewer = { id: 'independent-viewer' };
  let received;
  const cameraFraming = resolveThumbnailCameraFraming({
    theta: 32, phi: 90, fov: 38, verticalShift: -0.2,
  });
  await renderThumbnailWithFraming(viewer, cameraFraming, async (target, options) => {
    received = { target, options };
    return { blob: { size: 1 } };
  });
  assert.equal(received.target, viewer);
  assert.equal(received.options.cameraFraming, cameraFraming);
  assert.equal(received.options.width, 640);
  assert.equal(received.options.height, 480);
}

{
  const calls = [];
  const viewer = { remove: () => calls.push('remove') };
  await assert.rejects(
    withTemporaryThumbnailViewer(viewer, async () => { throw new Error('render failed'); }, () => calls.push('reset')),
    /render failed/,
  );
  assert.deepEqual(calls, ['reset', 'remove']);
}
