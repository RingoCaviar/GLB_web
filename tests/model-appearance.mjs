import assert from 'node:assert/strict';
import { DEFAULT_LIGHTING, RenderStudio, saveStudioState, STUDIO_STATE_VERSION } from '../src/render-studio.js';
import { resolveModelAppearance } from '../src/model-appearance.js';

const storage = new Map();
const localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};
const projectDefault = { lighting: { preset: 'outdoor', exposure: 1.4 }, writable: true };
const readDefaultLighting = async () => projectDefault;
const resolve = (id, extra = {}) => resolveModelAppearance(id, { storage: localStorage, readDefaultLighting, ...extra });

saveStudioState('saved', { version: STUDIO_STATE_VERSION, lighting: { preset: 'neutral', exposure: 2, normalStrength: 1.7 }, materialsByIndex: { 0: { metallic: 0.8 } } }, localStorage);
const saved = await resolve('saved');
assert.equal(saved.lighting.exposure, 2);
assert.equal(saved.lighting.normalStrength, 1.7);
assert.deepEqual(saved.materialsByIndex, { 0: { metallic: 0.8 } });

const missing = await resolve('missing');
assert.equal(missing.lighting.preset, 'outdoor');
assert.equal(missing.usedBuiltinDefault, false);

const unavailable = await resolve('none', { readDefaultLighting: async () => { throw new Error('READ_FAILED'); } });
assert.deepEqual(unavailable.lighting, { ...DEFAULT_LIGHTING });
assert.equal(unavailable.usedBuiltinDefault, true);

storage.set('glb-viewer:studio:v1:partial', JSON.stringify({ version: STUDIO_STATE_VERSION, materialsByIndex: { 1: { roughness: 0.3 } } }));
const partial = await resolve('partial');
assert.equal(partial.lighting.preset, 'outdoor');
assert.deepEqual(partial.materialsByIndex, { 1: { roughness: 0.3 } });

storage.set('glb-viewer:studio:v1:corrupt', JSON.stringify({
  version: STUDIO_STATE_VERSION,
  lighting: { preset: 'not-a-preset' },
  materialsByIndex: { 2: { metallic: 0.25 } },
}));
const corrupt = await resolve('corrupt');
assert.equal(corrupt.lighting.preset, 'outdoor');
assert.deepEqual(corrupt.materialsByIndex, { 2: { metallic: 0.25 } });

localStorage.removeItem('glb-viewer:studio:v1:saved');
const reset = await resolve('saved');
assert.equal(reset.lighting.preset, 'outdoor');

let resetResolutions = 0;
const resetStudio = {
  modelId: 'saved',
  defaultLighting: { ...DEFAULT_LIGHTING },
  lighting: { preset: 'neutral' },
  materials: [],
  originalNormalScales: new WeakMap(),
  viewer: {},
  root: { querySelector: () => ({}) },
  syncLightingUI: () => {},
  resetAllMaterials: () => {},
  onMessage: () => {},
  resolveAppearance: async () => {
    resetResolutions += 1;
    return { lighting: projectDefault.lighting, projectDefault: projectDefault.lighting, writable: false };
  },
};
await RenderStudio.prototype.resetModelAppearance.call(resetStudio);
assert.equal(resetResolutions, 1);
console.log('model appearance tests passed');
