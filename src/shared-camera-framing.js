export const SHARED_CAMERA_FRAMING_STORAGE_KEY = 'glb-viewer:shared-camera-framing:v1';

const DEFAULT_SHARED_CAMERA_FRAMING = Object.freeze({ theta: 0, phi: 75, fov: 45, verticalShift: 0, buildingCorrection: false });
const LIMITS = Object.freeze({
  theta: [-180, 180],
  phi: [1, 179],
  fov: [10, 90],
  verticalShift: [-0.5, 0.5],
});

function clamp(value, [minimum, maximum]) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function sanitizeSharedCameraFraming(value) {
  if (!value || typeof value !== 'object') return null;
  const framing = {};
  for (const [key, limits] of Object.entries(LIMITS)) {
    const numericValue = key === 'verticalShift' && value[key] === undefined
      ? 0
      : Number(value[key]);
    if (!Number.isFinite(numericValue)) return null;
    framing[key] = clamp(numericValue, limits);
  }
  return { ...framing, buildingCorrection: Boolean(value.buildingCorrection) };
}

export function loadSharedCameraFraming(storage = globalThis.localStorage) {
  try {
    return sanitizeSharedCameraFraming(JSON.parse(storage.getItem(SHARED_CAMERA_FRAMING_STORAGE_KEY)))
      ?? { ...DEFAULT_SHARED_CAMERA_FRAMING };
  } catch {
    return { ...DEFAULT_SHARED_CAMERA_FRAMING };
  }
}

export function saveSharedCameraFraming(framing, storage = globalThis.localStorage) {
  const sanitized = sanitizeSharedCameraFraming(framing);
  if (!sanitized) return false;
  try {
    storage.setItem(SHARED_CAMERA_FRAMING_STORAGE_KEY, JSON.stringify(sanitized));
    return true;
  } catch {
    return false;
  }
}
