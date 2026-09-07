export const VERTICAL_LENS_SHIFT_LIMIT = 0.5;

export function sanitizeVerticalLensShift(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return Math.min(VERTICAL_LENS_SHIFT_LIMIT, Math.max(-VERTICAL_LENS_SHIFT_LIMIT, numericValue));
}

export function createVerticalLensShiftAdapter({ getScene, requestRender, canRequestRender = () => true }) {
  function verticalLensShiftCapability(viewer) {
    const scene = getScene(viewer);
    if (!scene) return { available: false, reason: 'SCENE_UNAVAILABLE' };
    const camera = scene.camera;
    if (!camera?.isPerspectiveCamera) {
      return { available: false, reason: 'PERSPECTIVE_CAMERA_UNAVAILABLE' };
    }
    if (typeof camera.setViewOffset !== 'function' ||
        typeof camera.clearViewOffset !== 'function' ||
        typeof camera.updateProjectionMatrix !== 'function') {
      return { available: false, reason: 'VIEW_OFFSET_UNAVAILABLE' };
    }
    if (!canRequestRender(viewer)) {
      return { available: false, reason: 'RENDER_REQUEST_UNAVAILABLE' };
    }
    return { available: true, reason: null };
  }

  function applyVerticalLensShift(viewer, value, dimensions = {}) {
    const capability = verticalLensShiftCapability(viewer);
    if (!capability.available) return { applied: false, reason: capability.reason };

    const scene = getScene(viewer);
    const camera = scene.camera;
    const width = Number(dimensions.width ?? scene.width);
    const height = Number(dimensions.height ?? scene.height);
    const shift = sanitizeVerticalLensShift(value);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0 || shift === null) {
      return { applied: false, reason: 'INVALID_VIEW_OFFSET' };
    }

    if (shift === 0) camera.clearViewOffset();
    else camera.setViewOffset(width, height, 0, -shift * height, width, height);
    camera.updateProjectionMatrix();
    requestRender(viewer);
    return { applied: true, reason: null };
  }

  return { applyVerticalLensShift, verticalLensShiftCapability };
}
