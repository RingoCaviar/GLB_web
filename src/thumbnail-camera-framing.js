import { DEFAULT_SHARED_CAMERA_FRAMING, sanitizeSharedCameraFraming } from './shared-camera-framing.js';

export function resolveThumbnailCameraFraming(sharedCameraFraming) {
  const framing = sanitizeSharedCameraFraming(sharedCameraFraming)
    ?? DEFAULT_SHARED_CAMERA_FRAMING;
  // Keep the live preview distance when available so the generated cover has
  // the same subject scale as the preview. Older callers may omit radius;
  // those continue to use model-viewer's automatic framing.
  const radius = Number(sharedCameraFraming?.radius);
  return { ...framing, radius: Number.isFinite(radius) && radius > 0 ? radius : 'auto' };
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
