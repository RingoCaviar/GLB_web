import {
  ExportQualityMode,
  loadExportQuality,
  saveExportQuality,
  sanitizeExportQuality,
} from './export-quality.js';

export const DEFAULT_EXPORT_OPTIONS = Object.freeze({
  width: 4096,
  height: 4096,
  transparent: false,
  preserveShadow: false,
  exportQuality: ExportQualityMode.STANDARD,
  textureDetailMode: 'adaptive',
});

export const TEXTURE_DETAIL_STORAGE_KEY = 'glb-viewer:texture-detail:v1';

function clampDimension(value, maximumDimension) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(DEFAULT_EXPORT_OPTIONS.width, maximumDimension);
  return Math.round(Math.min(Math.max(numeric, 64), maximumDimension));
}

function loadTextureDetail(storage) {
  try {
    return storage?.getItem(TEXTURE_DETAIL_STORAGE_KEY) === 'base-level' ? 'base-level' : 'adaptive';
  } catch {
    return 'adaptive';
  }
}

function saveTextureDetail(mode, storage) {
  try { storage?.setItem(TEXTURE_DETAIL_STORAGE_KEY, mode); } catch { /* optional persistence */ }
  return mode;
}

export class ExportOptions {
  constructor({ maximumDimension = 8192, storage = globalThis.localStorage } = {}) {
    this.maximumDimension = Math.max(64, Number(maximumDimension) || 8192);
    this.storage = storage;
    const quality = loadExportQuality(storage);
    const textureDetailMode = loadTextureDetail(storage);
    this.options = {
      ...DEFAULT_EXPORT_OPTIONS,
      width: DEFAULT_EXPORT_OPTIONS.width,
      height: DEFAULT_EXPORT_OPTIONS.height,
      exportQuality: quality,
      textureDetailMode,
    };
  }

  getSnapshot() {
    return Object.freeze({ ...this.options, maximumDimension: this.maximumDimension });
  }

  setMaximumDimension(value) {
    this.maximumDimension = Math.max(64, Number(value) || 8192);
    this.options.width = clampDimension(this.options.width, this.maximumDimension);
    this.options.height = clampDimension(this.options.height, this.maximumDimension);
    return this.getSnapshot();
  }

  setOption(name, value) {
    if (name === 'width' || name === 'height') this.options[name] = clampDimension(value, this.maximumDimension);
    else if (name === 'exportQuality') {
      this.options.exportQuality = saveExportQuality(sanitizeExportQuality(value), this.storage);
      this.options.textureDetailMode = this.options.exportQuality === ExportQualityMode.HIGH ? 'base-level' : 'adaptive';
    } else if (name === 'textureDetailMode') {
      this.options.textureDetailMode = saveTextureDetail(value === 'base-level' ? 'base-level' : 'adaptive', this.storage);
    } else if (name === 'transparent') {
      this.options.transparent = Boolean(value);
      if (!this.options.transparent) this.options.preserveShadow = false;
    } else if (name === 'preserveShadow') {
      this.options.preserveShadow = this.options.transparent && Boolean(value);
    }
    return this.getSnapshot();
  }

  resetOption(name) {
    if (name === 'width' || name === 'height') return this.setOption(name, DEFAULT_EXPORT_OPTIONS[name]);
    if (name === 'exportQuality' || name === 'textureDetailMode') return this.setOption(name, DEFAULT_EXPORT_OPTIONS[name]);
    return this.setOption(name, DEFAULT_EXPORT_OPTIONS[name]);
  }

  getExportPlan() {
    const snapshot = this.getSnapshot();
    return Object.freeze({
      ...snapshot,
      background: snapshot.transparent ? 'transparent' : undefined,
      antiAlias: snapshot.exportQuality === ExportQualityMode.HIGH ? 'fxaa' : 'none',
    });
  }
}
