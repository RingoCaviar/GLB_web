export const EXPORT_QUALITY_STORAGE_KEY = 'glb-viewer:export-quality:v1';
export const ExportQualityMode = Object.freeze({
  STANDARD: 'standard',
  HIGH: 'high',
});

export function sanitizeExportQuality(value) {
  return value === ExportQualityMode.HIGH ? ExportQualityMode.HIGH : ExportQualityMode.STANDARD;
}

export function loadExportQuality(storage = globalThis.localStorage) {
  try {
    return sanitizeExportQuality(storage?.getItem(EXPORT_QUALITY_STORAGE_KEY));
  } catch {
    return ExportQualityMode.STANDARD;
  }
}

export function saveExportQuality(mode, storage = globalThis.localStorage) {
  const normalized = sanitizeExportQuality(mode);
  try {
    storage?.setItem(EXPORT_QUALITY_STORAGE_KEY, normalized);
  } catch {
    // Export remains usable when browser storage is unavailable.
  }
  return normalized;
}

export function resolveExportScale({ width, height, mode, maximumDimension = Infinity } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('INVALID_EXPORT_DIMENSIONS');
  }
  const requestedScale = sanitizeExportQuality(mode) === ExportQualityMode.HIGH ? 2 : 1;
  const supportedScale = Math.max(1, Number(maximumDimension) / Math.max(width, height) || 1);
  const scale = Math.min(requestedScale, supportedScale);
  return {
    scale,
    requestedScale,
    downgraded: scale < requestedScale,
    renderWidth: Math.floor(width * scale),
    renderHeight: Math.floor(height * scale),
  };
}
