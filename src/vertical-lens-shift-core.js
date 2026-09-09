export const VERTICAL_LENS_SHIFT_LIMIT = 0.5;

export function sanitizeVerticalLensShift(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return Math.min(VERTICAL_LENS_SHIFT_LIMIT, Math.max(-VERTICAL_LENS_SHIFT_LIMIT, numericValue));
}

// Rectify the world-up vanishing point without changing the camera pose.
// W' = W - Y / vanishingPointY sends that vanishing point to infinity.
export function applyVerticalPerspectiveCorrection(camera, enabled) {
  if (!enabled) return { applied: false, reason: null };
  const projection = camera?.projectionMatrix;
  const inverseView = camera?.matrixWorldInverse;
  const inverseProjection = camera?.projectionMatrixInverse;
  if (!projection?.elements || !inverseView?.elements || !inverseProjection?.copy) {
    return { applied: false, reason: 'PERSPECTIVE_CORRECTION_UNAVAILABLE' };
  }

  const view = inverseView.elements;
  const matrix = projection.elements;
  const x = view[4];
  const y = view[5];
  const z = view[6];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z;
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z;
  if (!Number.isFinite(clipY) || !Number.isFinite(clipW) || Math.abs(clipW) < 1e-9) {
    return { applied: false, reason: null };
  }
  const vanishingPointY = clipY / clipW;
  if (!Number.isFinite(vanishingPointY) || Math.abs(vanishingPointY) < 1e-9) {
    return { applied: false, reason: 'INVALID_VERTICAL_VANISHING_POINT' };
  }

  const near = Number(camera.near);
  const far = Number(camera.far);
  if (!Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near) {
    return { applied: false, reason: 'INVALID_CLIPPING_PLANES' };
  }

  // Matrix4 is column-major: replace row 4 with row 4 - row 2 / vy.
  for (const index of [3, 7, 11, 15]) matrix[index] -= matrix[index - 2] / vanishingPointY;

  // The projective transform changes clip-space W, so the old Z row can no
  // longer be compared against it. Rebuild depth from the corrected W;
  // otherwise ordinary visible geometry crosses Z > W and is cut by a new,
  // screen-horizontal far plane.
  const depthScale = (far + near) / (far - near);
  const depthOffset = -2 * far * near / (far - near);
  matrix[2] = depthScale * matrix[3];
  matrix[6] = depthScale * matrix[7];
  matrix[10] = depthScale * matrix[11];
  matrix[14] = depthScale * matrix[15] + depthOffset;
  inverseProjection.copy(projection).invert();
  return { applied: true, reason: null };
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

  function applyVerticalLensShift(viewer, value, dimensions = {}, buildingCorrection = false) {
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
    const correction = applyVerticalPerspectiveCorrection(camera, buildingCorrection);
    if (correction.reason) return { applied: false, reason: correction.reason };
    requestRender(viewer);
    return { applied: true, reason: null };
  }

  return { applyVerticalLensShift, verticalLensShiftCapability };
}
