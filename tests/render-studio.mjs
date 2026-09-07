import assert from 'node:assert/strict';
import {
  applyEnvironmentRotation,
  applyLighting,
  applyNormalStrength,
  applyMaterial,
  clearStudioState,
  DEFAULT_LIGHTING,
  getMaterialTextureChannels,
  loadStudioState,
  sanitizeLighting,
  saveStudioState,
  shouldWaitForEnvironmentChange,
  studioPanelTemplate,
  STUDIO_STATE_VERSION,
  RenderStudio,
} from '../src/render-studio.js';

const storage = new Map();
const localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};

assert.deepEqual(sanitizeLighting({ exposure: 99, shadowIntensity: -2, shadowSoftness: 'bad', toneMapping: 'invalid' }), {
  ...DEFAULT_LIGHTING,
  exposure: 3,
  shadowIntensity: 0,
});
assert.equal(sanitizeLighting({ environmentRotation: 999 }).environmentRotationY, 360);
assert.equal(sanitizeLighting({ environmentRotationX: -999 }).environmentRotationX, -180);
assert.equal(sanitizeLighting({ environmentRotationZ: 999 }).environmentRotationZ, 180);
assert.equal(sanitizeLighting({ normalStrength: -1 }).normalStrength, 0);
assert.equal(sanitizeLighting({ normalStrength: 99 }).normalStrength, 2);
assert.equal(sanitizeLighting({ normalStrength: 'bad' }).normalStrength, 1);

assert.equal(saveStudioState('model.glb', {
  version: STUDIO_STATE_VERSION,
  lighting: { preset: 'outdoor', exposure: 1.4, toneMapping: 'agx' },
  materialsByIndex: { 0: { metallic: 0.8 }, invalid: { roughness: 1 } },
}, localStorage), true);
const restored = loadStudioState('model.glb', localStorage);
assert.equal(restored.lighting.preset, 'outdoor');
assert.equal(restored.lighting.exposure, 1.4);
assert.equal(restored.lighting.toneMapping, 'agx');
assert.deepEqual(restored.materialsByIndex, { 0: { metallic: 0.8 } });
clearStudioState('model.glb', localStorage);
assert.equal(loadStudioState('model.glb', localStorage), null);

storage.set('glb-viewer:studio:v1:broken', '{broken');
assert.equal(loadStudioState('broken', localStorage), null);
storage.set('glb-viewer:studio:v1:old', JSON.stringify({ version: 0 }));
assert.equal(loadStudioState('old', localStorage), null);

const calls = {};
const pbr = {
  metallicFactor: 0,
  roughnessFactor: 1,
  setBaseColorFactor: (value) => { calls.baseColor = value; },
  setMetallicFactor: (value) => { calls.metallic = value; },
  setRoughnessFactor: (value) => { calls.roughness = value; },
};
const material = {
  pbrMetallicRoughness: pbr,
  setEmissiveFactor: (value) => { calls.emissive = value; },
  setEmissiveStrength: (value) => { calls.emissiveStrength = value; },
  setDoubleSided: (value) => { calls.doubleSided = value; },
  setAlphaMode: (value) => { calls.alphaMode = value; },
};
applyMaterial(material, {
  baseColor: [1, 0.5, 0, 1], metallic: 2, roughness: -1, emissive: [0.1, 0.2, 0.3],
  emissiveStrength: 4, doubleSided: true, alphaMode: 'BLEND',
});
assert.deepEqual(calls, {
  baseColor: [1, 0.5, 0, 1], metallic: 1, roughness: 0, emissive: [0.1, 0.2, 0.3],
  emissiveStrength: 4, doubleSided: true, alphaMode: 'BLEND',
});

const baseTexture = { name: 'base-map' };
const normalTexture = { name: 'normal-map' };
const clearcoatTexture = { name: 'coat-map' };
const textureChannels = getMaterialTextureChannels({
  pbrMetallicRoughness: {
    baseColorTexture: { texture: baseTexture },
    metallicRoughnessTexture: { texture: null },
  },
  normalTexture: { texture: normalTexture },
  occlusionTexture: { texture: null },
  emissiveTexture: { texture: null },
  clearcoatTexture: { texture: clearcoatTexture },
});
assert.deepEqual(textureChannels.map(({ key, texture }) => [key, texture?.name ?? null]), [
  ['baseColor', 'base-map'],
  ['metallicRoughness', null],
  ['normal', 'normal-map'],
  ['occlusion', null],
  ['emissive', null],
  ['clearcoat', 'coat-map'],
]);
assert.equal(textureChannels.find(({ key }) => key === 'metallicRoughness').description, 'G＝粗糙度，B＝金属度');

const viewer = {};
applyLighting(viewer, { preset: 'neutral', exposure: 2, shadowIntensity: 1.2, shadowSoftness: 0.4, toneMapping: 'aces' });
assert.deepEqual(viewer, { environmentImage: 'neutral', skyboxImage: null, exposure: 2, shadowIntensity: 1.2, shadowSoftness: 0.4, toneMapping: 'aces' });

applyLighting(viewer, { preset: 'outdoor', desaturate: true });
assert.equal(viewer.environmentImage, '/environments/kloppenheim_01_puresky_1k.grayscale.hdr');
assert.equal(viewer.skyboxImage, viewer.environmentImage);
applyLighting(viewer, { preset: 'outdoor', desaturate: false });
assert.equal(viewer.environmentImage, '/environments/kloppenheim_01_puresky_1k.hdr');
applyLighting(viewer, { preset: 'outdoor', showEnvironment: false });
assert.equal(viewer.skyboxImage, null);
applyLighting(viewer, { preset: 'environment-b757715cb78d', desaturate: true });
const grayscaleEnvironment = viewer.environmentImage;
applyLighting(viewer, { preset: 'environment-b757715cb78d', desaturate: false });
assert.notEqual(viewer.environmentImage, grayscaleEnvironment);

assert.equal(shouldWaitForEnvironmentChange({ src: null }, { url: '/environments/example.hdr' }), false);
assert.equal(shouldWaitForEnvironmentChange({ src: '/models/example.glb' }, { url: '/environments/example.hdr' }), true);
assert.equal(shouldWaitForEnvironmentChange({ src: '/models/example.glb', environmentImage: '/environments/example.hdr' }, { url: '/environments/example.hdr' }), false);
assert.doesNotMatch(studioPanelTemplate(), /environment-card-preview[^>]*>\s*<img[^>]*\sheight=/);

let renderQueued = 0;
const sceneSymbol = Symbol('scene');
const rotatedViewer = {
  [sceneSymbol]: {
    environmentRotation: { x: 0, y: 0, z: 0 },
    backgroundRotation: { x: 0, y: 0, z: 0 },
    groundedSkybox: { rotation: { x: 0, y: 0, z: 0 } },
    queueRender: () => { renderQueued += 1; },
  },
};
const correlatedObjects = Symbol('correlatedObjects');
const normalScaleForTest = { x: 0.75, y: 1, set(x, y) { this.x = x; this.y = y; } };
const normalTextureForTest = { texture: {} };
const normalMaterialForTest = { normalTexture: normalTextureForTest, [correlatedObjects]: new Set([{ normalScale: normalScaleForTest }]) };
const normalScalesForTest = new WeakMap();
assert.equal(applyNormalStrength([normalMaterialForTest, {}], 2, normalScalesForTest), 2);
assert.equal(normalScaleForTest.x, 1.5);
assert.equal(applyNormalStrength([normalMaterialForTest], 0, normalScalesForTest), 0);
assert.equal(normalScaleForTest.x, 0);
assert.equal(applyEnvironmentRotation(rotatedViewer, { environmentRotationX: -45, environmentRotationY: 90, environmentRotationZ: 30 }), true);
assert.equal(rotatedViewer[sceneSymbol].environmentRotation.x, -Math.PI / 4);
assert.equal(rotatedViewer[sceneSymbol].environmentRotation.y, Math.PI / 2);
assert.equal(rotatedViewer[sceneSymbol].environmentRotation.z, Math.PI / 6);
assert.equal(rotatedViewer[sceneSymbol].backgroundRotation.x, -Math.PI / 4);
assert.equal(rotatedViewer[sceneSymbol].backgroundRotation.y, Math.PI / 2);
assert.equal(rotatedViewer[sceneSymbol].backgroundRotation.z, Math.PI / 6);
assert.equal(rotatedViewer[sceneSymbol].groundedSkybox.rotation.y, Math.PI / 2);
assert.equal(rotatedViewer[sceneSymbol].groundedSkybox.rotation.x, 0);
assert.equal(rotatedViewer[sceneSymbol].groundedSkybox.rotation.z, 0);
assert.equal(renderQueued, 1);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ lighting: { ...DEFAULT_LIGHTING, exposure: 1.4 } }) });
let savedBaselineRefreshes = 0;
const saveButton = { disabled: false };
await RenderStudio.prototype.saveSharedDefault.call({
  defaultLightingWritable: true,
  root: { querySelector: () => saveButton },
  lighting: { ...DEFAULT_LIGHTING, exposure: 1.4 },
  onMessage: () => {},
  updateResetButtons: () => { savedBaselineRefreshes += 1; },
});
globalThis.fetch = originalFetch;
assert.equal(savedBaselineRefreshes, 1);

console.log('render studio tests passed');
