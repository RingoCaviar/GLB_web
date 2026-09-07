import { sanitizeSharedCameraFraming } from './shared-camera-framing.js';

const DEFAULT_THUMBNAIL_CAMERA_FRAMING = Object.freeze({
  theta: 0,
  phi: 75,
  fov: 45,
  verticalShift: 0,
});

export function resolveThumbnailCameraFraming(sharedCameraFraming) {
  const framing = sanitizeSharedCameraFraming(sharedCameraFraming)
    ?? DEFAULT_THUMBNAIL_CAMERA_FRAMING;
  return { ...framing, radius: 'auto' };
}

export function renderThumbnailWithFraming(viewer, cameraFraming, renderImage) {
  return renderImage(viewer, {
    width: 640,
    height: 480,
    background: '#e8eaed',
    hideEnvironment: true,
    transparent: false,
    preserveShadow: true,
    textureDetailMode: 'adaptive',
    cameraFraming,
  });
}

export async function withTemporaryThumbnailViewer(viewer, task, reset) {
  try {
    return await task();
  } finally {
    reset();
    viewer.remove();
  }
}
