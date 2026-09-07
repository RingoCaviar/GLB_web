import environmentPresetList from './environment-presets.generated.js';
import { loadDefaultLighting } from './lighting-defaults.js';

export const STUDIO_STATE_VERSION = 1;
export const STUDIO_STORAGE_PREFIX = 'glb-viewer:studio:v1:';
export const DEFAULT_LIGHTING = Object.freeze({
  preset: 'neutral', exposure: 1, shadowIntensity: 0.75, shadowSoftness: 0.9,
  toneMapping: 'neutral', desaturate: true, showEnvironment: true,
  environmentRotationX: 0, environmentRotationY: 0, environmentRotationZ: 0, normalStrength: 1,
});

const validPresets = new Set(environmentPresetList.map(({ key }) => key));
const toneMappings = new Set(['neutral', 'aces', 'agx', 'commerce']);
const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

export function sanitizeLighting(value = {}) {
  return {
    preset: validPresets.has(value.preset) ? value.preset : DEFAULT_LIGHTING.preset,
    exposure: clamp(value.exposure, 0.1, 3, DEFAULT_LIGHTING.exposure),
    shadowIntensity: clamp(value.shadowIntensity, 0, 2, DEFAULT_LIGHTING.shadowIntensity),
    shadowSoftness: clamp(value.shadowSoftness, 0, 1, DEFAULT_LIGHTING.shadowSoftness),
    toneMapping: toneMappings.has(value.toneMapping) ? value.toneMapping : DEFAULT_LIGHTING.toneMapping,
    desaturate: typeof value.desaturate === 'boolean' ? value.desaturate : DEFAULT_LIGHTING.desaturate,
    showEnvironment: typeof value.showEnvironment === 'boolean' ? value.showEnvironment : DEFAULT_LIGHTING.showEnvironment,
    environmentRotationX: clamp(value.environmentRotationX, -180, 180, DEFAULT_LIGHTING.environmentRotationX),
    environmentRotationY: clamp(value.environmentRotationY ?? value.environmentRotation, 0, 360, DEFAULT_LIGHTING.environmentRotationY),
    environmentRotationZ: clamp(value.environmentRotationZ, -180, 180, DEFAULT_LIGHTING.environmentRotationZ),
    normalStrength: clamp(value.normalStrength, 0, 2, DEFAULT_LIGHTING.normalStrength),
  };
}

function isUsableSavedLighting(value) {
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, 'preset') && !validPresets.has(value.preset)) return false;
  if (Object.hasOwn(value, 'toneMapping') && !toneMappings.has(value.toneMapping)) return false;
  for (const key of ['exposure', 'shadowIntensity', 'shadowSoftness', 'environmentRotationX', 'environmentRotationY', 'environmentRotationZ', 'environmentRotation', 'normalStrength']) {
    if (Object.hasOwn(value, key) && !Number.isFinite(Number(value[key]))) return false;
  }
  return !((Object.hasOwn(value, 'desaturate') && typeof value.desaturate !== 'boolean')
    || (Object.hasOwn(value, 'showEnvironment') && typeof value.showEnvironment !== 'boolean'));
}

export function sanitizeStudioState(value) {
  if (!value || value.version !== STUDIO_STATE_VERSION) return null;
  const materialsByIndex = {};
  if (value.materialsByIndex && typeof value.materialsByIndex === 'object') {
    for (const [index, material] of Object.entries(value.materialsByIndex)) {
      if (/^\d+$/.test(index) && material && typeof material === 'object') materialsByIndex[index] = material;
    }
  }
  return { version: STUDIO_STATE_VERSION, lighting: isUsableSavedLighting(value.lighting) ? sanitizeLighting(value.lighting) : null, materialsByIndex };
}

export function loadStudioState(modelId, storage = globalThis.localStorage) {
  try { return sanitizeStudioState(JSON.parse(storage.getItem(`${STUDIO_STORAGE_PREFIX}${modelId}`))); } catch { return null; }
}

export function saveStudioState(modelId, state, storage = globalThis.localStorage) {
  try { storage.setItem(`${STUDIO_STORAGE_PREFIX}${modelId}`, JSON.stringify(sanitizeStudioState({ ...state, version: STUDIO_STATE_VERSION }))); return true; } catch { return false; }
}

export function clearStudioState(modelId, storage = globalThis.localStorage) {
  try { storage.removeItem(`${STUDIO_STORAGE_PREFIX}${modelId}`); return true; } catch { return false; }
}

export async function resolveModelAppearance(modelId, {
  storage,
  readDefaultLighting = loadDefaultLighting,
} = {}) {
  const saved = loadStudioState(modelId, storage);
  try {
    const result = await readDefaultLighting();
    const projectDefault = sanitizeLighting(result.lighting);
    return {
      lighting: saved?.lighting ?? projectDefault,
      materialsByIndex: saved?.materialsByIndex ?? {},
      projectDefault,
      writable: Boolean(result.writable),
      usedBuiltinDefault: false,
    };
  } catch {
    return {
      lighting: saved?.lighting ?? { ...DEFAULT_LIGHTING },
      materialsByIndex: saved?.materialsByIndex ?? {},
      projectDefault: { ...DEFAULT_LIGHTING },
      writable: false,
      usedBuiltinDefault: !saved?.lighting,
    };
  }
}
