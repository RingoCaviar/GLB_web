import assert from 'node:assert/strict';
import { FixedSizeRenderError, hasRenderRestorationFailure, renderFixedSizeImage } from '../src/fixed-size-render-core.js';

const originalStyle = {
  width: '10px', height: '20px', position: 'absolute', inset: '1px', zIndex: '2',
  backgroundColor: 'pink', opacity: '1', pointerEvents: 'auto',
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(overrides = {}) {
  const calls = [];
  const viewer = {
    style: { ...originalStyle },
    skyboxImage: 'studio.hdr',
    shadowIntensity: 0.8,
    updateComplete: Promise.resolve(),
    jumpCameraToGoal: () => calls.push('jump'),
    toBlob: async () => ({ size: 12, id: 'source' }),
    ...overrides,
  };
  const texture = {
    applied: true, mode: 'base-level', textureCount: 3,
    restore: () => calls.push('restore-texture'),
  };
  const runtime = {
    pixelRatio: 2,
    requestFrame: (callback) => callback(),
    createBitmap: async () => ({ width: 640, height: 480, close: () => calls.push('close-bitmap') }),
    beginTextureDetail: () => texture,
    setTimer: () => 1,
    clearTimer: () => {},
  };
  return { viewer, runtime, calls, texture };
}

{
  const { viewer, runtime, calls } = fixture();
  const result = await renderFixedSizeImage(viewer, {
    width: 640, height: 480, background: '#eee', transparent: true,
    preserveShadow: false, textureDetailMode: 'base-level',
  }, runtime);
  assert.deepEqual(result, {
    blob: { size: 12, id: 'source' }, width: 640, height: 480,
    textureDetail: { applied: true, mode: 'base-level', textureCount: 3 },
  });
  assert.deepEqual(viewer.style, originalStyle);
  assert.equal(viewer.skyboxImage, 'studio.hdr');
  assert.equal(viewer.shadowIntensity, 0.8);
  assert.deepEqual(calls, ['jump', 'close-bitmap', 'restore-texture']);
}

{
  const { viewer, runtime, calls } = fixture();
  let appliedFraming;
  runtime.createCameraFramingSession = (target, framing) => ({
    apply: async (dimensions) => {
      appliedFraming = { target, framing, dimensions, width: target.style.width, height: target.style.height };
      calls.push('apply-framing');
    },
      restore: async () => {
        assert.deepEqual(target.style, originalStyle);
        calls.push('restore-framing');
      },
  });
  const cameraFraming = { theta: 0, phi: 90, radius: 2, fov: 45, verticalShift: 0.25 };
  await renderFixedSizeImage(viewer, {
    width: 640,
    height: 480,
    cameraFraming,
  }, runtime);
  assert.deepEqual(appliedFraming, {
    target: viewer,
    framing: cameraFraming,
    dimensions: { width: 640, height: 480 },
    width: '320px',
    height: '240px',
  });
  assert.deepEqual(calls, [
    'jump',
    'apply-framing',
    'close-bitmap',
    'restore-texture',
    'restore-framing',
  ]);
}

{
  const item = fixture();
  item.texture.applied = false;
  await assert.rejects(
    renderFixedSizeImage(item.viewer, { width: 640, height: 480, textureDetailMode: 'base-level' }, item.runtime),
    (error) => error.code === 'TEXTURE_DETAIL_UNAVAILABLE',
  );
}

{
  const item = fixture();
  item.runtime.readDrawingBuffer = () => ({ width: 5760, height: 5760 });
  await assert.rejects(
    renderFixedSizeImage(item.viewer, { width: 8192, height: 8192 }, item.runtime),
    (error) => error.code === 'RENDER_BUFFER_TOO_SMALL' && error.details.width === 5760,
  );
}

assert.equal(hasRenderRestorationFailure(new FixedSizeRenderError('RENDER_FAILED')), false);
assert.equal(hasRenderRestorationFailure(new FixedSizeRenderError('RENDER_FAILED', { restorationErrors: [new Error('restore')] })), true);

for (const [options, expectedDuring] of [
  [{ transparent: false, preserveShadow: false }, 0.8],
  [{ transparent: true, preserveShadow: true }, 0.8],
  [{ transparent: true, preserveShadow: false }, 0],
]) {
  let duringCapture;
  const item = fixture({
    toBlob: async function () {
      duringCapture = this.shadowIntensity;
      return { size: 12 };
    },
  });
  await renderFixedSizeImage(item.viewer, { width: 640, height: 480, ...options }, item.runtime);
  assert.equal(duringCapture, expectedDuring);
  assert.equal(item.viewer.shadowIntensity, 0.8);
}

for (const [name, mutate, expected] of [
  ['empty', ({ viewer }) => { viewer.toBlob = async () => null; }, 'EMPTY_RENDER'],
  ['size', ({ runtime }) => { runtime.createBitmap = async () => ({ width: 1, height: 1 }); }, 'RENDER_SIZE_MISMATCH'],
  ['capture', ({ viewer }) => { viewer.toBlob = async () => { throw new Error('gpu'); }; }, 'RENDER_FAILED'],
]) {
  const item = fixture();
  mutate(item);
  await assert.rejects(
    renderFixedSizeImage(item.viewer, { width: 640, height: 480 }, item.runtime),
    (error) => error instanceof FixedSizeRenderError && error.code === expected,
    name,
  );
  assert.deepEqual(item.viewer.style, originalStyle);
  assert.equal(item.viewer.skyboxImage, 'studio.hdr');
}

{
  const pending = deferred();
  const item = fixture({ updateComplete: pending.promise });
  const first = renderFixedSizeImage(item.viewer, { width: 640, height: 480 }, item.runtime);
  await assert.rejects(
    renderFixedSizeImage(item.viewer, { width: 640, height: 480 }, item.runtime),
    (error) => error.code === 'RENDER_BUSY',
  );
  pending.resolve();
  await first;
}

{
  const pending = deferred();
  const item = fixture({ updateComplete: pending.promise });
  const controller = new AbortController();
  const task = renderFixedSizeImage(item.viewer, { width: 640, height: 480, signal: controller.signal }, item.runtime);
  controller.abort(new Error('model changed'));
  await assert.rejects(task, (error) => error.code === 'RENDER_ABORTED');
  assert.deepEqual(item.viewer.style, originalStyle);
}

{
  const item = fixture();
  item.runtime.setTimer = (callback) => { queueMicrotask(callback); return 1; };
  item.viewer.updateComplete = new Promise(() => {});
  await assert.rejects(
    renderFixedSizeImage(item.viewer, { width: 640, height: 480 }, item.runtime),
    (error) => error.code === 'RENDER_TIMEOUT',
  );
}

{
  const item = fixture();
  item.texture.restore = () => { throw new Error('restore failed'); };
  await assert.rejects(
    renderFixedSizeImage(item.viewer, { width: 640, height: 480 }, item.runtime),
    (error) => error.code === 'RENDER_RESTORE_FAILED' && error.restorationErrors.length === 1,
  );
}

{
  const item = fixture();
  item.runtime.createCameraFramingSession = () => ({
    apply: async () => {},
    restore: async () => { throw new Error('camera restore failed'); },
  });
  await assert.rejects(
    renderFixedSizeImage(item.viewer, {
      width: 640,
      height: 480,
      cameraFraming: { theta: 0, phi: 90, radius: 2, fov: 45, verticalShift: 0.2 },
    }, item.runtime),
    (error) => error.code === 'RENDER_RESTORE_FAILED' && error.restorationErrors.length === 1,
  );
  assert.deepEqual(item.viewer.style, originalStyle);
}

for (const [name, fail] of [
  ['camera apply', ({ session }) => { session.apply = async () => { throw new Error('projection failed'); }; }],
  ['texture setup', ({ item }) => { item.runtime.beginTextureDetail = async () => { throw new Error('texture failed'); }; }],
  ['capture', ({ item }) => { item.viewer.toBlob = async () => { throw new Error('capture failed'); }; }],
]) {
  const item = fixture();
  let restored = false;
  const session = {
    apply: async () => {},
    restore: async () => { restored = true; },
  };
  item.runtime.createCameraFramingSession = () => session;
  fail({ item, session });
  await assert.rejects(
    renderFixedSizeImage(item.viewer, {
      width: 640,
      height: 480,
      cameraFraming: { theta: 0, phi: 90, radius: 2, fov: 45, verticalShift: 0.2 },
    }, item.runtime),
    (error) => error.code === 'RENDER_FAILED',
    name,
  );
  assert.equal(restored, true, `${name} 后应恢复相机投影`);
  assert.deepEqual(item.viewer.style, originalStyle);
}

{
  const item = fixture();
  item.viewer.toBlob = async () => { throw new Error('capture failed'); };
  item.texture.restore = () => { throw new Error('restore failed'); };
  await assert.rejects(
    renderFixedSizeImage(item.viewer, { width: 640, height: 480 }, item.runtime),
    (error) => error.code === 'RENDER_FAILED' && error.restorationErrors.length === 1,
  );
}

console.log('fixed size render tests passed');
