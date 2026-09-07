const LINE_HEIGHT_PX = 18;
const PAGE_HEIGHT_PX = 800;
const MAX_WHEEL_DELTA_PX = 240;
const WHEEL_ZOOM_RATE = 0.0015;

export function normalizeWheelDelta(deltaY, deltaMode = 0) {
  if (!Number.isFinite(deltaY)) return 0;
  const multiplier = deltaMode === 1
    ? LINE_HEIGHT_PX
    : deltaMode === 2 ? PAGE_HEIGHT_PX : 1;
  return Math.max(-MAX_WHEEL_DELTA_PX, Math.min(MAX_WHEEL_DELTA_PX, deltaY * multiplier));
}

export function zoomRadiusByWheel(radius, deltaY, deltaMode = 0) {
  if (!Number.isFinite(radius) || radius <= 0) return radius;
  const delta = normalizeWheelDelta(deltaY, deltaMode);
  return radius * Math.exp(delta * WHEEL_ZOOM_RATE);
}

export function zoomRadiusByPinch(radius, startDistance, currentDistance) {
  if (![radius, startDistance, currentDistance].every(Number.isFinite) ||
      radius <= 0 || startDistance <= 0 || currentDistance <= 0) {
    return radius;
  }
  return radius * startDistance / currentDistance;
}

export function pointerDistance(first, second) {
  if (!first || !second) return 0;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}
