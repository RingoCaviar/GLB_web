const activeRenders = new WeakSet();
const STYLE_FIELDS = [
  'width', 'height', 'position', 'inset', 'zIndex',
  'backgroundColor', 'opacity', 'pointerEvents',
];
const DEFAULT_TIMEOUT_MS = 30000;
const STABLE_FRAME_COUNT = 8;
const BUFFER_CALIBRATION_ATTEMPTS = 3;
const OUTPUT_CALIBRATION_ATTEMPTS = 3;

export class FixedSizeRenderError extends Error {
  constructor(code, { cause, restorationErrors = [], details = null } = {}) {
    super(code, { cause });
    this.name = 'FixedSizeRenderError';
    this.code = code;
    this.restorationErrors = restorationErrors;
    this.details = details;
  }
}

export function hasRenderRestorationFailure(error) {
  return error?.code === 'RENDER_RESTORE_FAILED' || (error?.restorationErrors?.length ?? 0) > 0;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new FixedSizeRenderError('RENDER_ABORTED', { cause: signal.reason });
}

async function withDeadline(task, { signal, timeoutMs, setTimer, clearTimer }) {
  let timer;
  let onAbort;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => reject(new FixedSizeRenderError('RENDER_TIMEOUT')), timeoutMs);
  });
  const aborted = new Promise((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(new FixedSizeRenderError('RENDER_ABORTED', { cause: signal.reason }));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([task, timeout, aborted]);
  } finally {
    clearTimer(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function waitForFrames(count, requestFrame) {
  return new Promise((resolve) => {
    const frame = () => count-- > 0 ? requestFrame(frame) : resolve();
    requestFrame(frame);
  });
}

async function imageDimensions(blob, createBitmap) {
  const bitmap = await createBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close?.();
  }
}

async function restoreInReverse(restorers) {
  const errors = [];
  for (const restore of restorers.reverse()) {
    try {
      await restore();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function calibrateDrawingBuffer(viewer, { width, height, readDrawingBuffer, waitUntilStable }) {
  if (!readDrawingBuffer) return null;
  let drawingBuffer = readDrawingBuffer(viewer);
  for (let attempt = 0; attempt < BUFFER_CALIBRATION_ATTEMPTS; attempt++) {
    if (!drawingBuffer || (drawingBuffer.width === width && drawingBuffer.height === height)) {
      return drawingBuffer;
    }
    if (drawingBuffer.width <= 0 || drawingBuffer.height <= 0) break;
    const cssWidth = Number.parseFloat(viewer.style.width);
    const cssHeight = Number.parseFloat(viewer.style.height);
    viewer.style.width = `${cssWidth * width / drawingBuffer.width}px`;
    viewer.style.height = `${cssHeight * height / drawingBuffer.height}px`;
    await waitUntilStable();
    drawingBuffer = readDrawingBuffer(viewer);
  }
  return drawingBuffer;
}

async function captureExactSize(viewer, {
  width,
  height,
  pixelRatio,
  createBitmap,
  capture,
  waitUntilStable,
}) {
  let dimensions = null;
  for (let attempt = 0; attempt < OUTPUT_CALIBRATION_ATTEMPTS; attempt++) {
    const blob = await capture();
    if (!blob || blob.size === 0) throw new FixedSizeRenderError('EMPTY_RENDER');
    dimensions = await imageDimensions(blob, createBitmap);
    if (dimensions.width === width && dimensions.height === height) {
      return { blob, dimensions };
    }
    const widthDifference = width - dimensions.width;
    const heightDifference = height - dimensions.height;
    const centeredWidthCorrection = widthDifference === 0
      ? 0
      : widthDifference - Math.sign(widthDifference) * 0.5;
    const centeredHeightCorrection = heightDifference === 0
      ? 0
      : heightDifference - Math.sign(heightDifference) * 0.5;
    viewer.style.width = `${Number.parseFloat(viewer.style.width) + centeredWidthCorrection / pixelRatio}px`;
    viewer.style.height = `${Number.parseFloat(viewer.style.height) + centeredHeightCorrection / pixelRatio}px`;
    await waitUntilStable();
  }
  throw new FixedSizeRenderError('RENDER_SIZE_MISMATCH', {
    details: { requestedWidth: width, requestedHeight: height, ...dimensions },
  });
}

export async function renderFixedSizeImage(viewer, {
  width,
  height,
  background = 'transparent',
  hideEnvironment = true,
  transparent = false,
  preserveShadow = false,
  textureDetailMode = 'adaptive',
  cameraFraming = null,
  signal,
} = {}, runtime = {}) {
  if (!viewer || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new FixedSizeRenderError('INVALID_RENDER_REQUEST');
  }
  if (activeRenders.has(viewer)) throw new FixedSizeRenderError('RENDER_BUSY');

  const requestFrame = runtime.requestFrame ?? globalThis.requestAnimationFrame;
  const createBitmap = runtime.createBitmap ?? globalThis.createImageBitmap;
  if (!requestFrame || !createBitmap || !runtime.beginTextureDetail ||
      (cameraFraming && !runtime.createCameraFramingSession)) {
    throw new FixedSizeRenderError('RENDER_RUNTIME_UNAVAILABLE');
  }

  const restorers = [];
  const beginTextureDetail = runtime.beginTextureDetail;
  const pixelRatio = runtime.pixelRatio ?? globalThis.devicePixelRatio ?? 1;
  const timeoutMs = runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setTimer = runtime.setTimer ?? globalThis.setTimeout;
  const clearTimer = runtime.clearTimer ?? globalThis.clearTimeout;
  let failure = null;
  let cameraFramingSession = null;
  activeRenders.add(viewer);

  try {
    throwIfAborted(signal);
    if (cameraFraming) {
      cameraFramingSession = runtime.createCameraFramingSession(viewer, cameraFraming);
      if (!cameraFramingSession?.apply || !cameraFramingSession?.restore) {
        throw new FixedSizeRenderError('CAMERA_FRAMING_UNAVAILABLE');
      }
    }
    const originalStyle = Object.fromEntries(STYLE_FIELDS.map((field) => [field, viewer.style[field]]));
    restorers.push(() => {
      for (const [field, value] of Object.entries(originalStyle)) viewer.style[field] = value;
    });

    viewer.style.width = `${width / pixelRatio}px`;
    viewer.style.height = `${height / pixelRatio}px`;
    viewer.style.position = 'fixed';
    viewer.style.inset = '0 auto auto 0';
    viewer.style.zIndex = '9999';
    viewer.style.backgroundColor = background;
    viewer.style.opacity = '0';
    viewer.style.pointerEvents = 'none';

    if (hideEnvironment) {
      const originalSkybox = viewer.skyboxImage;
      viewer.skyboxImage = null;
      restorers.push(() => { viewer.skyboxImage = originalSkybox; });
    }

    const originalShadow = viewer.shadowIntensity;
    if (transparent && !preserveShadow) viewer.shadowIntensity = 0;
    restorers.push(() => { viewer.shadowIntensity = originalShadow; });

    const textureDetail = await beginTextureDetail(viewer, textureDetailMode);
    restorers.push(() => textureDetail.restore());
    if (textureDetailMode === 'base-level' && !textureDetail.applied) {
      throw new FixedSizeRenderError('TEXTURE_DETAIL_UNAVAILABLE');
    }

    viewer.jumpCameraToGoal();
    await withDeadline(Promise.resolve(viewer.updateComplete), { signal, timeoutMs, setTimer, clearTimer });
    if (cameraFraming) {
      await withDeadline(
        Promise.resolve(cameraFramingSession.apply({ width, height })),
        { signal, timeoutMs, setTimer, clearTimer },
      );
      await withDeadline(Promise.resolve(viewer.updateComplete), { signal, timeoutMs, setTimer, clearTimer });
    }
    await withDeadline(waitForFrames(STABLE_FRAME_COUNT, requestFrame), { signal, timeoutMs, setTimer, clearTimer });
    throwIfAborted(signal);
    const waitUntilStable = async () => {
      await withDeadline(Promise.resolve(viewer.updateComplete), { signal, timeoutMs, setTimer, clearTimer });
      if (cameraFraming) {
        await withDeadline(
          Promise.resolve(cameraFramingSession.apply({ width, height })),
          { signal, timeoutMs, setTimer, clearTimer },
        );
      }
      await withDeadline(waitForFrames(STABLE_FRAME_COUNT, requestFrame), { signal, timeoutMs, setTimer, clearTimer });
    };
    const drawingBuffer = await calibrateDrawingBuffer(viewer, {
      width,
      height,
      readDrawingBuffer: runtime.readDrawingBuffer,
      waitUntilStable,
    });
    if (drawingBuffer && (drawingBuffer.width < width - 1 || drawingBuffer.height < height - 1)) {
      throw new FixedSizeRenderError('RENDER_BUFFER_TOO_SMALL', {
        details: { requestedWidth: width, requestedHeight: height, ...drawingBuffer },
      });
    }

    const { blob, dimensions } = await captureExactSize(viewer, {
      width,
      height,
      pixelRatio,
      createBitmap,
      waitUntilStable,
      capture: () => withDeadline(
        Promise.resolve(viewer.toBlob({ idealAspect: false, mimeType: 'image/png' })),
        { signal, timeoutMs, setTimer, clearTimer },
      ),
    });
    return {
      blob,
      width: dimensions.width,
      height: dimensions.height,
      textureDetail: {
        applied: textureDetail.applied,
        mode: textureDetail.mode,
        textureCount: textureDetail.textureCount,
      },
    };
  } catch (error) {
    failure = error instanceof FixedSizeRenderError
      ? error
      : new FixedSizeRenderError('RENDER_FAILED', { cause: error });
    throw failure;
  } finally {
    const restorationErrors = await restoreInReverse(restorers);
    if (cameraFramingSession?.restore) {
      try {
        await withDeadline(
          Promise.resolve(cameraFramingSession.restore()),
          { timeoutMs, setTimer, clearTimer },
        );
      } catch (error) {
        restorationErrors.push(error);
      }
    }
    activeRenders.delete(viewer);
    if (restorationErrors.length) {
      if (failure) failure.restorationErrors.push(...restorationErrors);
      else throw new FixedSizeRenderError('RENDER_RESTORE_FAILED', { restorationErrors });
    }
  }
}
