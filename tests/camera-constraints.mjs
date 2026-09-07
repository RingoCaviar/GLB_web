import assert from 'node:assert/strict';
import {
  createBounds,
  framingInvariant,
  orbitDirection,
  pointInsideBounds,
  rayBoundsInterval,
  resolveFovChange,
  resolveSafeRadius,
  surfaceRadius,
} from '../src/camera-constraints.js';
import {
  normalizeWheelDelta,
  pointerDistance,
  zoomRadiusByPinch,
  zoomRadiusByWheel,
} from '../src/camera-zoom.js';

const bounds = createBounds(
  { x: 0, y: 0, z: 0 },
  { x: 2, y: 0.02, z: 4 },
);
const angles = [-180, 0, 180];
const polars = [1, 90, 179];

for (const theta of angles) {
  for (const phi of polars) {
    const direction = orbitDirection(theta, phi);
    assert.ok(Number.isFinite(direction.x + direction.y + direction.z));
    const minimum = surfaceRadius({
      bounds,
      target: { x: 0, y: 0, z: 0 },
      theta,
      phi,
    });
    assert.ok(Number.isFinite(minimum) && minimum > 0);
  }
}

const centerToFront = surfaceRadius({
  bounds,
  target: { x: 0, y: 0, z: 0 },
  theta: 0,
  phi: 90,
});
assert.ok(centerToFront > 2 && centerToFront < 2.001);

const centerToCorner = surfaceRadius({
  bounds: createBounds({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 }),
  target: { x: 0, y: 0, z: 0 },
  theta: 45,
  phi: Math.acos(1 / Math.sqrt(3)) * 180 / Math.PI,
});
assert.ok(centerToCorner > Math.sqrt(3) && centerToCorner < Math.sqrt(3) + 0.001);

const surfaceMinimum = surfaceRadius({
  bounds,
  target: { x: 0, y: 0, z: 2 },
  theta: 0,
  phi: 90,
});
assert.ok(surfaceMinimum > 0 && surfaceMinimum < 0.001);

const outsideMinimum = surfaceRadius({
  bounds,
  target: { x: 10, y: 10, z: 10 },
  theta: 180,
  phi: 90,
});
assert.ok(outsideMinimum > 0 && outsideMinimum < 0.001);

const unitBounds = createBounds({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 });
const throughBox = rayBoundsInterval({
  bounds: unitBounds,
  target: { x: 0, y: 0, z: 3 },
  theta: 180,
  phi: 90,
});
assert.ok(Math.abs(throughBox.entry - 2) < 1e-12);
assert.ok(Math.abs(throughBox.exit - 4) < 1e-12);
assert.equal(throughBox.originInside, false);

const missesBox = rayBoundsInterval({
  bounds: unitBounds,
  target: { x: 3, y: 0, z: 3 },
  theta: 180,
  phi: 90,
});
assert.equal(missesBox, null);

const fromInside = rayBoundsInterval({
  bounds: unitBounds,
  target: { x: 0, y: 0, z: 0 },
  theta: 0,
  phi: 90,
});
assert.equal(fromInside.originInside, true);
assert.ok(Math.abs(fromInside.exit - 1) < 1e-12);

const blockedFromFar = resolveSafeRadius({
  bounds: unitBounds,
  target: { x: 0, y: 0, z: 3 },
  theta: 180,
  phi: 90,
  radius: 1,
  previousRadius: 5,
});
assert.ok(blockedFromFar.corrected && blockedFromFar.radius > 4);

const blockedFromNear = resolveSafeRadius({
  bounds: unitBounds,
  target: { x: 0, y: 0, z: 3 },
  theta: 180,
  phi: 90,
  radius: 5,
  previousRadius: 1,
});
assert.ok(blockedFromNear.corrected && blockedFromNear.radius < 2);

const pushedFromInside = resolveSafeRadius({
  bounds: unitBounds,
  target: { x: 0, y: 0, z: 3 },
  theta: 180,
  phi: 90,
  radius: 3,
  previousRadius: 3,
});
assert.ok(pushedFromInside.corrected);
assert.equal(pointInsideBounds(unitBounds, {
  x: 0,
  y: 0,
  z: 3 - pushedFromInside.radius,
}), false);

for (const theta of [-180, -90, 0, 90, 180]) {
  for (const phi of [1, 45, 90, 135, 179]) {
    for (let cycle = 0; cycle < 1000; cycle += 1) {
      const requested = 10 ** ((cycle % 17) - 8);
      const safe = resolveSafeRadius({
        bounds: unitBounds,
        target: cycle % 2 ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: 3 },
        theta,
        phi,
        radius: requested,
        previousRadius: cycle % 3 ? 100 : 1e-8,
      });
      assert.ok(Number.isFinite(safe.radius) && safe.radius > 0);
      const direction = orbitDirection(theta, phi);
      const position = {
        x: (cycle % 2 ? 0 : 0) + direction.x * safe.radius,
        y: (cycle % 2 ? 0 : 0) + direction.y * safe.radius,
        z: (cycle % 2 ? 0 : 3) + direction.z * safe.radius,
      };
      assert.equal(pointInsideBounds(unitBounds, position), false);
    }
  }
}

const invalidGeometryMinimum = surfaceRadius({
  bounds: createBounds({ x: NaN, y: 0, z: 0 }, { x: NaN, y: 0, z: 0 }),
  target: { x: NaN, y: 0, z: 0 },
  theta: 0,
  phi: 90,
});
assert.ok(Number.isFinite(invalidGeometryMinimum) && invalidGeometryMinimum > 0);

let camera = { radius: 10, fov: 45 };
const invariant = framingInvariant(camera.radius, camera.fov);
for (let cycle = 0; cycle < 100; cycle += 1) {
  camera = resolveFovChange({ ...camera, requestedFov: 90, minimumRadius: 0.001 });
  camera = resolveFovChange({ ...camera, requestedFov: 10, minimumRadius: 0.001 });
}
camera = resolveFovChange({ ...camera, requestedFov: 45, minimumRadius: 0.001 });
assert.ok(Math.abs(framingInvariant(camera.radius, camera.fov) - invariant) < 1e-12);
assert.ok(Math.abs(camera.radius - 10) < 1e-12);

const limited = resolveFovChange({
  radius: 2,
  fov: 45,
  requestedFov: 90,
  minimumRadius: 2,
});
assert.equal(limited.limited, true);
assert.equal(limited.radius, 2);
assert.ok(Math.abs(limited.fov - 45) < 1e-12);
assert.ok(Math.abs(framingInvariant(limited.radius, limited.fov) - framingInvariant(2, 45)) < 1e-12);

for (const invalid of [NaN, Infinity, -Infinity, 0, -1]) {
  const result = resolveFovChange({
    radius: invalid,
    fov: 45,
    requestedFov: 90,
    minimumRadius: 1,
  });
  assert.equal(result.radius, invalid);
}

assert.equal(normalizeWheelDelta(10, 0), 10);
assert.equal(normalizeWheelDelta(10, 1), 180);
assert.equal(normalizeWheelDelta(10, 2), 240);
assert.equal(normalizeWheelDelta(Infinity, 0), 0);
assert.ok(zoomRadiusByWheel(1, 100) > 1);
assert.ok(zoomRadiusByWheel(1, -100) < 1);
assert.ok(Math.abs(zoomRadiusByPinch(2, 100, 200) - 1) < 1e-12);
assert.ok(Math.abs(pointerDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 }) - 5) < 1e-12);

let zoomRadius = 123.456;
const initialZoomRadius = zoomRadius;
for (let cycle = 0; cycle < 1000; cycle += 1) {
  zoomRadius = zoomRadiusByWheel(zoomRadius, 0.25);
  zoomRadius = zoomRadiusByWheel(zoomRadius, -0.25);
}
assert.ok(Number.isFinite(zoomRadius) && zoomRadius > 0);
assert.ok(Math.abs(zoomRadius - initialZoomRadius) < 1e-9);

let farRadius = 1;
for (let step = 0; step < 1000; step += 1) {
  farRadius = zoomRadiusByWheel(farRadius, 100);
}
assert.ok(Number.isFinite(farRadius) && farRadius > 1e60);

for (const invalid of [NaN, Infinity, -Infinity, 0, -1]) {
  assert.equal(zoomRadiusByWheel(invalid, 100), invalid);
  assert.equal(zoomRadiusByPinch(invalid, 100, 200), invalid);
}

console.log('相机约束盲测通过：射线包围盒碰撞、极端边界、FOV 往返及 1000 次缩放均符合预期。');
