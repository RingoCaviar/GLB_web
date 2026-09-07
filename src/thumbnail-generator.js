import { applyMaximumTextureQuality, resetTextureQuality } from './render-quality.js';
import { applyLighting, applyMaterial, DEFAULT_LIGHTING } from './render-studio.js';
import { renderFixedSizeImage } from './fixed-size-render.js';
import {
  renderThumbnailWithFraming,
  resolveThumbnailCameraFraming,
  withTemporaryThumbnailViewer,
} from './thumbnail-camera-framing.js';

const WIDTH = 640;
const HEIGHT = 480;

function waitForModel(viewer, expectedUrl) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('MODEL_TIMEOUT')), 30000);
    const finish = (error) => {
      clearTimeout(timeout);
      viewer.removeEventListener('load', onLoad);
      viewer.removeEventListener('error', onError);
      error ? reject(error) : resolve();
    };
    const onLoad = (event) => {
      const loaded = new URL(event.detail?.url || '', window.location.href).href;
      const expected = new URL(expectedUrl, window.location.href).href;
      if (loaded === expected) finish();
    };
    const onError = () => finish(new Error('MODEL_LOAD_FAILED'));
    viewer.addEventListener('load', onLoad);
    viewer.addEventListener('error', onError);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('IMAGE_ENCODE_FAILED'));
    reader.readAsDataURL(blob);
  });
}

function canvasToWebp(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.type !== 'image/webp') reject(new Error('IMAGE_ENCODE_FAILED'));
      else resolve(blob);
    }, 'image/webp', 0.9);
  });
}

export async function createModelThumbnail(modelUrl, appearance = null, sharedCameraFraming = null) {
  const ratio = window.devicePixelRatio || 1;
  const cameraFraming = resolveThumbnailCameraFraming(sharedCameraFraming);
  const viewer = document.createElement('model-viewer');
  Object.assign(viewer.style, {
    position: 'fixed',
    inset: '0 auto auto 0',
    width: `${WIDTH / ratio}px`,
    height: `${HEIGHT / ratio}px`,
    opacity: '0',
    pointerEvents: 'none',
    zIndex: '-1',
    backgroundColor: '#e8eaed',
  });
  viewer.setAttribute('camera-orbit', `${cameraFraming.theta}deg ${cameraFraming.phi}deg auto`);
  viewer.setAttribute('field-of-view', `${cameraFraming.fov}deg`);
  applyLighting(viewer, appearance?.lighting ?? DEFAULT_LIGHTING);
  viewer.skyboxImage = null;
  viewer.setAttribute('interaction-prompt', 'none');

  return withTemporaryThumbnailViewer(viewer, async () => {
    const loaded = waitForModel(viewer, modelUrl);
    document.body.append(viewer);
    viewer.src = modelUrl;
    await loaded;
    for (const [index, materialState] of Object.entries(appearance?.materialsByIndex ?? {})) {
      const material = viewer.model?.materials?.[Number(index)];
      if (material) applyMaterial(material, materialState);
    }
    await viewer.updateFraming();
    viewer.jumpCameraToGoal();
    await viewer.updateComplete;
    applyMaximumTextureQuality(viewer);
    const rendered = await renderThumbnailWithFraming(viewer, cameraFraming, renderFixedSizeImage);
    const bitmap = await createImageBitmap(rendered.blob);
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext('2d');
    context.fillStyle = '#e8eaed';
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvasToWebp(canvas);
    return await blobToDataUrl(blob);
  }, () => resetTextureQuality(viewer));
}

export async function saveModelThumbnail(modelId, dataUrl) {
  const response = await fetch('/__thumbnail/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId, dataUrl }),
  });
  const result = await response.json().catch(() => ({ error: 'INVALID_RESPONSE' }));
  if (!response.ok) {
    const error = new Error(result.error || 'WRITE_FAILED');
    error.status = response.status;
    throw error;
  }
  return result;
}

export async function loadSavedModelThumbnail(modelId) {
  const url = `/__thumbnail/file?modelId=${encodeURIComponent(modelId)}&v=${Date.now()}`;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    return response.ok ? url : null;
  } catch {
    return null;
  }
}

export async function thumbnailCapability() {
  try {
    const response = await fetch('/__thumbnail/capability', { cache: 'no-store' });
    return response.ok && Boolean((await response.json()).writable);
  } catch {
    return false;
  }
}
