import { saveDefaultLighting } from './lighting-defaults.js';
import environmentPresetList from './environment-presets.generated.js';
import {
  clearStudioState, DEFAULT_LIGHTING, loadStudioState, resolveModelAppearance,
  sanitizeLighting, saveStudioState, STUDIO_STATE_VERSION, STUDIO_STORAGE_PREFIX,
} from './model-appearance.js';
import {
  clampStudioParameter, countChangedStudioParameters, formatStudioParameter,
  resetStudioParameter, studioNumericParameters, studioParameters, visibleStudioParameters,
} from './render-studio-parameters.js';
import { createCoalescedWriter } from './coalesced-writer.js';

export { clearStudioState, DEFAULT_LIGHTING, loadStudioState, sanitizeLighting, saveStudioState, STUDIO_STATE_VERSION, STUDIO_STORAGE_PREFIX };

export const ENVIRONMENT_PRESETS = Object.freeze(Object.fromEntries(environmentPresetList.map(({ key, ...preset }) => [key, Object.freeze(preset)])));

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};


function getCorrelatedMaterials(material) {
  const symbol = Object.getOwnPropertySymbols(material ?? {}).find((item) => item.description === 'correlatedObjects');
  const correlated = symbol ? material[symbol] : null;
  return correlated instanceof Set ? correlated : [];
}

export function applyNormalStrength(materials = [], strength = 1, originalScales = new WeakMap(), viewer = null) {
  const safeStrength = clamp(strength, 0, 2, DEFAULT_LIGHTING.normalStrength);
  for (const material of materials) {
    const textureInfo = material?.normalTexture;
    if (!textureInfo?.texture) continue;
    for (const threeMaterial of getCorrelatedMaterials(material)) {
      if (!threeMaterial?.normalScale?.set) continue;
      if (!originalScales.has(threeMaterial)) originalScales.set(threeMaterial, { x: threeMaterial.normalScale.x, y: threeMaterial.normalScale.y });
      const original = originalScales.get(threeMaterial);
      threeMaterial.normalScale.set(original.x * safeStrength, original.y * safeStrength);
      threeMaterial.needsUpdate = true;
    }
  }
  const sceneSymbol = viewer && Object.getOwnPropertySymbols(viewer).find((symbol) => symbol.description === 'scene');
  viewer?.[sceneSymbol]?.queueRender?.();
  return safeStrength;
}


const copy = (value) => Array.from(value ?? []);

const CORE_TEXTURE_CHANNELS = Object.freeze([
  { key: 'baseColor', label: '基础色', description: 'RGB＝颜色，A＝透明度', getInfo: (material) => material.pbrMetallicRoughness?.baseColorTexture },
  { key: 'metallicRoughness', label: '金属 / 粗糙', description: 'G＝粗糙度，B＝金属度', getInfo: (material) => material.pbrMetallicRoughness?.metallicRoughnessTexture },
  { key: 'normal', label: '法线', description: 'RGB＝切线空间法线方向', getInfo: (material) => material.normalTexture },
  { key: 'occlusion', label: '环境遮蔽', description: 'R＝环境遮蔽强度', getInfo: (material) => material.occlusionTexture },
  { key: 'emissive', label: '发光', description: 'RGB＝自发光颜色', getInfo: (material) => material.emissiveTexture },
]);

const ADVANCED_TEXTURE_CHANNELS = Object.freeze([
  { key: 'clearcoat', label: '清漆', description: 'R＝清漆强度', getInfo: (material) => material.clearcoatTexture },
  { key: 'clearcoatRoughness', label: '清漆粗糙度', description: 'G＝清漆粗糙度', getInfo: (material) => material.clearcoatRoughnessTexture },
  { key: 'clearcoatNormal', label: '清漆法线', description: 'RGB＝清漆层法线方向', getInfo: (material) => material.clearcoatNormalTexture },
  { key: 'transmission', label: '透射', description: 'R＝透射强度', getInfo: (material) => material.transmissionTexture },
  { key: 'thickness', label: '厚度', description: 'G＝体积厚度', getInfo: (material) => material.thicknessTexture },
  { key: 'specular', label: '镜面强度', description: 'A＝镜面强度', getInfo: (material) => material.specularTexture },
  { key: 'specularColor', label: '镜面颜色', description: 'RGB＝镜面反射颜色', getInfo: (material) => material.specularColorTexture },
  { key: 'iridescence', label: '虹彩', description: 'R＝虹彩强度', getInfo: (material) => material.iridescenceTexture },
  { key: 'iridescenceThickness', label: '虹彩厚度', description: 'G＝虹彩层厚度', getInfo: (material) => material.iridescenceThicknessTexture },
  { key: 'anisotropy', label: '各向异性', description: 'RG＝方向，B＝强度', getInfo: (material) => material.anisotropyTexture },
]);

export function getMaterialTextureChannels(material) {
  const readChannel = (channel) => {
    let info = null;
    try { info = channel.getInfo(material) ?? null; } catch { /* unsupported extension */ }
    return { key: channel.key, label: channel.label, description: channel.description, info, texture: info?.texture ?? null };
  };
  const core = CORE_TEXTURE_CHANNELS.map(readChannel);
  const advanced = ADVANCED_TEXTURE_CHANNELS.map(readChannel).filter((channel) => channel.texture);
  return [...core, ...advanced];
}

export function readMaterial(material) {
  const pbr = material.pbrMetallicRoughness;
  return {
    baseColor: copy(pbr.baseColorFactor), metallic: pbr.metallicFactor, roughness: pbr.roughnessFactor,
    emissive: copy(material.emissiveFactor), emissiveStrength: material.emissiveStrength,
    doubleSided: material.getDoubleSided(), alphaMode: material.getAlphaMode(),
    clearcoat: material.clearcoatFactor, clearcoatRoughness: material.clearcoatRoughnessFactor,
    transmission: material.transmissionFactor, ior: material.ior, thickness: material.thicknessFactor,
    specular: material.specularFactor, iridescence: material.iridescenceFactor,
    anisotropy: material.anisotropyStrength,
  };
}

export function applyMaterial(material, value = {}) {
  const pbr = material.pbrMetallicRoughness;
  if (Array.isArray(value.baseColor) && value.baseColor.length === 4) pbr.setBaseColorFactor(value.baseColor);
  if (Number.isFinite(value.metallic)) pbr.setMetallicFactor(clamp(value.metallic, 0, 1, pbr.metallicFactor));
  if (Number.isFinite(value.roughness)) pbr.setRoughnessFactor(clamp(value.roughness, 0, 1, pbr.roughnessFactor));
  if (Array.isArray(value.emissive) && value.emissive.length === 3) material.setEmissiveFactor(value.emissive);
  const setters = {
    emissiveStrength: ['setEmissiveStrength', 0, 10], clearcoat: ['setClearcoatFactor', 0, 1],
    clearcoatRoughness: ['setClearcoatRoughnessFactor', 0, 1], transmission: ['setTransmissionFactor', 0, 1],
    ior: ['setIor', 1, 2.333], thickness: ['setThicknessFactor', 0, 10], specular: ['setSpecularFactor', 0, 1],
    iridescence: ['setIridescenceFactor', 0, 1], anisotropy: ['setAnisotropyStrength', 0, 1],
  };
  for (const [key, [method, min, max]] of Object.entries(setters)) {
    if (Number.isFinite(value[key]) && typeof material[method] === 'function') material[method](clamp(value[key], min, max, material[key]));
  }
  if (typeof value.doubleSided === 'boolean') material.setDoubleSided(value.doubleSided);
  if (['OPAQUE', 'MASK', 'BLEND'].includes(value.alphaMode)) material.setAlphaMode(value.alphaMode);
}

export function applyLighting(viewer, lighting) {
  const safe = sanitizeLighting(lighting);
  const preset = ENVIRONMENT_PRESETS[safe.preset];
  const image = environmentImageForLighting(preset, safe);
  viewer.environmentImage = image;
  viewer.skyboxImage = safe.showEnvironment && image !== 'neutral' ? image : null;
  viewer.exposure = safe.exposure;
  viewer.shadowIntensity = safe.shadowIntensity;
  viewer.shadowSoftness = safe.shadowSoftness;
  viewer.toneMapping = safe.toneMapping;
  applyEnvironmentRotation(viewer, safe);
  return safe;
}

function environmentImageForLighting(preset, lighting) {
  return lighting.desaturate && preset.grayscaleUrl ? preset.grayscaleUrl : preset.url;
}

export function shouldWaitForEnvironmentChange(viewer, preset, lighting = {}) {
  const image = environmentImageForLighting(preset, lighting);
  return image !== 'neutral' && Boolean(viewer?.src) && viewer.environmentImage !== image;
}

export function applyEnvironmentRotation(viewer, rotation = {}) {
  const sceneSymbol = viewer && Object.getOwnPropertySymbols(viewer).find((symbol) => symbol.description === 'scene');
  const scene = sceneSymbol ? viewer[sceneSymbol] : null;
  if (!scene) return false;
  const value = typeof rotation === 'number'
    ? { environmentRotationY: rotation }
    : rotation;
  const x = clamp(value.environmentRotationX, -180, 180, 0) * Math.PI / 180;
  const y = clamp(value.environmentRotationY ?? value.environmentRotation, 0, 360, 0) * Math.PI / 180;
  const z = clamp(value.environmentRotationZ, -180, 180, 0) * Math.PI / 180;
  scene.environmentRotation?.set?.(x, y, z);
  scene.backgroundRotation?.set?.(x, y, z);
  if (scene.environmentRotation && !scene.environmentRotation.set) Object.assign(scene.environmentRotation, { x, y, z });
  if (scene.backgroundRotation && !scene.backgroundRotation.set) Object.assign(scene.backgroundRotation, { x, y, z });
  if (scene.groundedSkybox?.rotation) scene.groundedSkybox.rotation.y = y;
  scene.queueRender?.();
  return true;
}

export function studioPanelTemplate() {
  return `<section class="panel-section studio-section" id="renderStudio">
    <div class="section-heading"><span>04</span><h2>渲染工作室</h2></div>
    <div class="environment-picker"><button class="environment-picker-toggle" id="environmentPickerToggle" type="button" aria-haspopup="dialog"><span><strong>环境光</strong><small id="environmentStatus">项目内置 HDR</small></span><span class="environment-current" id="environmentCurrent"></span></button><dialog class="environment-dialog" id="environmentDialog"><div class="environment-dialog-heading"><div><strong>选择 HDRI 环境</strong><small>完整预览环境全景 · 点击立即应用</small></div><button id="environmentDialogClose" type="button" aria-label="关闭 HDRI 选择窗口">×</button></div><div class="environment-grid" id="environmentPresetGrid">${Object.entries(ENVIRONMENT_PRESETS).map(([key, item]) => `<button class="environment-card" type="button" data-environment-preset="${key}" aria-pressed="false"><span class="environment-card-preview"><img src="${item.thumbnailUrl}" alt="${key === 'neutral' ? '无 HDRI' : `${item.label} HDRI 全景预览`}" width="320">${key === 'neutral' ? '<i>无 HDRI</i>' : ''}</span><span>${item.label}</span><small>点击应用</small></button>`).join('')}</div></dialog></div>
    <label class="switch-row compact-switch"><span><strong>HDRI 去色</strong><small>保留明暗，移除环境色偏</small></span><input id="environmentDesaturate" type="checkbox" checked><i></i></label>
    <label class="switch-row compact-switch"><span><strong>预览 HDRI 背景</strong><small>仅用于取景预览，不改变 PNG 背景</small></span><input id="environmentPreview" type="checkbox" checked><i></i></label>
    <section class="parameter-group"><div class="parameter-group-heading"><strong>基础光照</strong><small data-adjusted-count="lighting">已调整 0 项</small></div><div id="lightingControls"></div></section>
    <details class="parameter-group collapsible-parameter-group"><summary>三轴环境旋转 <small data-adjusted-count="rotation">已调整 0 项</small></summary><div id="environmentRotationControl"></div></details>
    <label class="select-row"><span><strong>色调映射</strong></span><select id="toneMapping"><option value="neutral">Neutral</option><option value="aces">ACES</option><option value="agx">AgX</option><option value="commerce">Commerce</option></select></label>
    <div class="studio-actions lighting-actions"><button class="secondary-button" id="resetLighting" type="button">重置光照</button><button class="secondary-button" id="saveDefaultLighting" type="button" disabled>保存为默认</button></div>
    <div class="studio-divider"></div>
    <label class="select-row"><span><strong>材质</strong><small id="materialCount">请先加载模型</small></span><select id="materialSelect" disabled></select></label>
    <div id="materialControls" class="material-controls"></div>
    <div class="studio-actions"><button class="secondary-button" id="resetMaterial" type="button" disabled>重置当前材质</button><button class="secondary-button" id="resetAllMaterials" type="button" disabled>重置全部材质</button></div>
    <button class="secondary-button danger-button" id="resetModelAppearance" type="button" disabled>恢复模型默认效果</button>
  </section>`;
}

const toHex = (rgb) => `#${rgb.slice(0, 3).map((value) => Math.round(clamp(value, 0, 1, 0) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
const resetIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.4 7.2A6 6 0 1 1 4 12.9M4.4 7.2V3.8m0 3.4h3.4"/></svg>';
const resetButtonMarkup = (key, label) => `<button class="parameter-reset" type="button" data-reset="${key}" aria-label="重置${label}" title="重置${label}">${resetIcon}</button>`;
const rangeMarkup = (parameter) => `<div class="studio-range"><div class="studio-range-heading"><label for="${parameter.id}">${parameter.label}</label><span><input data-number="${parameter.id}" type="number" min="${parameter.min}" max="${parameter.max}" step="${parameter.step}"><em>${parameter.unit ?? ''}</em>${resetButtonMarkup(parameter.id, parameter.label)}</span></div><input id="${parameter.id}" type="range" min="${parameter.min}" max="${parameter.max}" step="${parameter.step}"></div>`;

export class RenderStudio {
  constructor(viewer, root, { onMessage = () => {}, resolveAppearance = resolveModelAppearance } = {}) {
    this.viewer = viewer;
    this.root = root;
    this.onMessage = onMessage;
    this.resolveAppearance = resolveAppearance;
    this.modelId = null;
    this.lighting = { ...DEFAULT_LIGHTING };
    this.materials = [];
    this.originalMaterials = [];
    this.materialsByIndex = {};
    this.textureThumbnailCache = new WeakMap();
    this.materialRenderToken = 0;
    this.doubleSidedUpdating = false;
    this.defaultLighting = { ...DEFAULT_LIGHTING };
    this.defaultLightingWritable = false;
    this.originalNormalScales = new WeakMap();
    this.persistWriter = createCoalescedWriter(
      ({ modelId, snapshot }) => saveStudioState(modelId, snapshot),
      200,
    );
    root.querySelector('#lightingControls').innerHTML = studioNumericParameters('lighting').map(rangeMarkup).join('');
    root.querySelector('#environmentRotationControl').innerHTML = studioNumericParameters('rotation').map(rangeMarkup).join('');
    this.bindLighting();
    root.querySelector('#materialSelect').addEventListener('change', () => this.renderMaterialControls());
    root.querySelector('#resetMaterial').addEventListener('click', () => this.resetCurrentMaterial());
    root.querySelector('#resetAllMaterials').addEventListener('click', () => this.resetAllMaterials());
    root.querySelector('#resetModelAppearance').addEventListener('click', () => this.resetModelAppearance());
    this.syncLightingUI();
    this.defaultLightingReady = this.loadSharedDefault();
  }

  bindLighting() {
    for (const parameter of [...studioNumericParameters('lighting'), ...studioNumericParameters('rotation')]) this.bindLightingParameter(parameter);
    this.root.querySelector('#toneMapping').addEventListener('change', (event) => {
      this.lighting.toneMapping = event.target.value;
      this.viewer.toneMapping = event.target.value;
      this.persist();
      this.updateResetButtons();
    });
    const pickerToggle = this.root.querySelector('#environmentPickerToggle');
    const pickerDialog = this.root.querySelector('#environmentDialog');
    pickerToggle.addEventListener('click', () => pickerDialog.showModal());
    this.root.querySelector('#environmentDialogClose').addEventListener('click', () => pickerDialog.close());
    pickerDialog.addEventListener('click', (event) => { if (event.target === pickerDialog) pickerDialog.close(); });
    for (const button of this.root.querySelectorAll('[data-environment-preset]')) {
      button.addEventListener('click', () => this.selectPreset(button.dataset.environmentPreset));
      button.addEventListener('keydown', (event) => {
        const cards = [...this.root.querySelectorAll('[data-environment-preset]')];
        const index = cards.indexOf(button);
        const columns = matchMedia('(max-width: 480px)').matches ? 1 : 2;
        const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
        if (!(event.key in offsets)) return;
        event.preventDefault();
        cards[(index + offsets[event.key] + cards.length) % cards.length].focus();
      });
    }
    this.root.querySelector('#environmentDesaturate').addEventListener('change', (event) => {
      this.lighting.desaturate = event.target.checked;
      applyLighting(this.viewer, this.lighting);
      this.persist();
      this.updateResetButtons();
    });
    this.root.querySelector('#environmentPreview').addEventListener('change', (event) => {
      this.lighting.showEnvironment = event.target.checked;
      applyLighting(this.viewer, this.lighting);
      this.persist();
      this.updateResetButtons();
    });
    this.root.querySelector('#resetLighting').addEventListener('click', () => {
      this.lighting = { ...this.defaultLighting };
      applyLighting(this.viewer, this.lighting);
      applyNormalStrength(this.materials, this.lighting.normalStrength, this.originalNormalScales, this.viewer);
      this.syncLightingUI();
      this.persist();
    });
    this.root.querySelector('#saveDefaultLighting').addEventListener('click', () => this.saveSharedDefault());
  }

  bindLightingParameter(parameter) {
    const range = this.root.querySelector(`#${parameter.id}`);
    const number = this.root.querySelector(`[data-number="${parameter.id}"]`);
    const update = (raw) => {
      const value = clampStudioParameter(parameter, raw, this.lighting[parameter.key]);
      this.lighting[parameter.key] = value;
      range.value = value;
      number.value = formatStudioParameter(parameter, value);
      if (parameter.key === 'normalStrength') applyNormalStrength(this.materials, value, this.originalNormalScales, this.viewer);
      else if (parameter.group === 'rotation') applyEnvironmentRotation(this.viewer, this.lighting);
      else this.viewer[parameter.key] = value;
      this.persist();
      this.updateResetButtons();
    };
    range.addEventListener('input', (event) => update(event.target.value));
    number.addEventListener('change', (event) => update(event.target.value));
    number.addEventListener('blur', (event) => update(event.target.value));
    this.root.querySelector(`[data-reset="${parameter.id}"]`).addEventListener('click', () => this.resetLightingParameter(parameter.key));
  }

  resetLightingParameter(key) {
    const parameter = [...studioParameters('lighting'), ...studioParameters('rotation')].find((item) => item.key === key);
    this.lighting = resetStudioParameter(this.lighting, this.defaultLighting, parameter);
    if (key === 'normalStrength') applyNormalStrength(this.materials, this.lighting[key], this.originalNormalScales, this.viewer);
    else applyLighting(this.viewer, this.lighting);
    this.syncLightingUI();
    this.persist();
  }

  async loadSharedDefault() {
    const appearance = await this.resolveAppearance(null);
    this.defaultLighting = appearance.projectDefault;
    this.defaultLightingWritable = appearance.writable;
    const button = this.root.querySelector('#saveDefaultLighting');
    button.disabled = !appearance.writable;
    button.title = appearance.writable ? '保存后所有访问者首次预览都使用这套光照' : '只能在运行服务的电脑上保存';
    if (!this.modelId) {
      this.lighting = { ...appearance.projectDefault };
      applyLighting(this.viewer, this.lighting);
      this.syncLightingUI();
    }
  }

  async saveSharedDefault() {
    if (!this.defaultLightingWritable) return;
    const button = this.root.querySelector('#saveDefaultLighting');
    button.disabled = true;
    try {
      this.defaultLighting = sanitizeLighting(await saveDefaultLighting(this.lighting));
      this.updateResetButtons();
      this.onMessage('当前光照已保存为所有人的默认设置。', 'success');
    } catch {
      this.onMessage('默认光照保存失败，请在运行服务的电脑上重试。', 'error');
    } finally {
      button.disabled = false;
    }
  }

  async selectPreset(key, reset = false) {
    const preset = ENVIRONMENT_PRESETS[key] ?? ENVIRONMENT_PRESETS.neutral;
    const previousLighting = { ...this.lighting };
    this.lighting = sanitizeLighting({
      ...(reset ? DEFAULT_LIGHTING : this.lighting), preset: Object.hasOwn(ENVIRONMENT_PRESETS, key) ? key : 'neutral',
      exposure: preset.exposure, shadowIntensity: preset.shadowIntensity, shadowSoftness: preset.shadowSoftness,
    });
    this.syncLightingUI();
    const status = this.root.querySelector('#environmentStatus');
    status.textContent = '环境加载中…';
    const selectedCard = this.root.querySelector(`[data-environment-preset="${this.lighting.preset}"]`);
    selectedCard?.classList.remove('error');
    selectedCard?.classList.add('loading');
    const environmentChanged = shouldWaitForEnvironmentChange(this.viewer, preset, this.lighting)
      ? new Promise((resolve) => this.viewer.addEventListener('environment-change', resolve, { once: true }))
      : Promise.resolve();
    applyLighting(this.viewer, this.lighting);
    try {
      await Promise.race([environmentChanged, new Promise((_, reject) => setTimeout(() => reject(new Error('ENVIRONMENT_TIMEOUT')), 15000))]);
      status.textContent = `${preset.label} · 已就绪`;
      this.root.querySelector('#environmentDialog').close();
    } catch {
      this.root.querySelector(`[data-environment-preset="${this.lighting.preset}"]`)?.classList.add('error');
      this.lighting = previousLighting;
      applyLighting(this.viewer, this.lighting);
      applyNormalStrength(this.materials, this.lighting.normalStrength, this.originalNormalScales, this.viewer);
      this.syncLightingUI();
      status.textContent = '环境加载失败，已保留上一个环境';
      this.onMessage('环境贴图加载失败，已保留上一个可用环境。', 'error');
    }
    for (const card of this.root.querySelectorAll('.environment-card')) card.classList.remove('loading');
    this.persist();
  }

  syncLightingUI() {
    const preset = ENVIRONMENT_PRESETS[this.lighting.preset];
    this.root.querySelector('#environmentCurrent').innerHTML = `<img src="${preset.thumbnailUrl}" alt="" width="72" height="40"><strong>${preset.label}</strong><i aria-hidden="true">⌄</i>`;
    for (const card of this.root.querySelectorAll('[data-environment-preset]')) {
      const selected = card.dataset.environmentPreset === this.lighting.preset;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
    }
    this.root.querySelector('#toneMapping').value = this.lighting.toneMapping;
    this.root.querySelector('#environmentDesaturate').checked = this.lighting.desaturate;
    this.root.querySelector('#environmentPreview').checked = this.lighting.showEnvironment;
    for (const parameter of [...studioNumericParameters('lighting'), ...studioNumericParameters('rotation')]) {
      const value = this.lighting[parameter.key];
      this.root.querySelector(`#${parameter.id}`).value = value;
      this.root.querySelector(`[data-number="${parameter.id}"]`).value = formatStudioParameter(parameter, value);
    }
    this.updateResetButtons();
  }

  updateResetButtons() {
    for (const parameter of [...studioParameters('lighting'), ...studioParameters('rotation')]) {
      const button = this.root.querySelector(`[data-reset="${parameter.id}"]`);
      if (button) button.disabled = this.lighting[parameter.key] === this.defaultLighting[parameter.key];
    }
    this.updateGroupAdjustmentCounts();
  }

  updateGroupAdjustmentCounts() {
    for (const group of ['lighting', 'rotation']) {
      const target = this.root.querySelector(`[data-adjusted-count="${group}"]`);
      if (target) target.textContent = `已调整 ${countChangedStudioParameters(this.lighting, this.defaultLighting, group)} 项`;
    }
  }

  async loadModel(modelId) {
    this.flushPersist();
    await this.defaultLightingReady;
    const appearance = await this.resolveAppearance(modelId);
    this.defaultLighting = appearance.projectDefault;
    this.defaultLightingWritable = appearance.writable;
    const saveButton = this.root.querySelector('#saveDefaultLighting');
    saveButton.disabled = !appearance.writable;
    saveButton.title = appearance.writable ? '保存后所有访问者首次预览都使用这套光照' : '只能在运行服务的电脑上保存';
    this.modelId = modelId;
    this.materials = [...(this.viewer.model?.materials ?? [])];
    this.originalNormalScales = new WeakMap();
    applyNormalStrength(this.materials, 1, this.originalNormalScales, this.viewer);
    this.originalMaterials = this.materials.map(readMaterial);
    this.lighting = sanitizeLighting(appearance.lighting);
    this.materialsByIndex = appearance.materialsByIndex;
    applyLighting(this.viewer, this.lighting);
    applyNormalStrength(this.materials, this.lighting.normalStrength, this.originalNormalScales, this.viewer);
    this.syncLightingUI();
    this.materials.forEach((material, index) => {
      if (this.materialsByIndex[index]) applyMaterial(material, this.materialsByIndex[index]);
    });
    const select = this.root.querySelector('#materialSelect');
    select.innerHTML = this.materials.map((material, index) => `<option value="${index}">${index + 1}. ${material.name || `未命名材质 ${index + 1}`}</option>`).join('');
    select.disabled = this.materials.length === 0;
    this.root.querySelector('#materialCount').textContent = `${this.materials.length} 个材质`;
    for (const id of ['resetMaterial', 'resetAllMaterials', 'resetModelAppearance']) this.root.querySelector(`#${id}`).disabled = this.materials.length === 0;
    this.renderMaterialControls();
  }

  unloadModel() {
    this.flushPersist();
    this.materialRenderToken += 1;
    this.modelId = null;
    this.materials = [];
    this.originalMaterials = [];
    this.materialsByIndex = {};
    this.originalNormalScales = new WeakMap();
    this.root.querySelector('#materialSelect').innerHTML = '';
    this.root.querySelector('#materialSelect').disabled = true;
    this.root.querySelector('#materialCount').textContent = '请先加载模型';
    this.root.querySelector('#materialControls').innerHTML = '';
    for (const id of ['resetMaterial', 'resetAllMaterials', 'resetModelAppearance']) this.root.querySelector(`#${id}`).disabled = true;
  }

  renderMaterialControls() {
    const renderToken = ++this.materialRenderToken;
    const index = Number(this.root.querySelector('#materialSelect').value || 0);
    const material = this.materials[index];
    const container = this.root.querySelector('#materialControls');
    if (!material) { container.innerHTML = ''; return; }
    const value = readMaterial(material);
    const basicParameters = studioNumericParameters('material-basic');
    const advanced = visibleStudioParameters('material-advanced', material).filter((parameter) => parameter.kind === 'number');
    const originalDoubleSided = this.originalMaterials[index]?.doubleSided ? '双面' : '单面';
    container.innerHTML = `<section class="texture-channels" aria-label="纹理通道"><div class="texture-heading"><strong>纹理通道</strong><small>仅查看 · 来自当前 GLB</small></div><div class="texture-grid" id="materialTextureGrid"></div></section>
      <div class="material-colors"><label><span>基础颜色</span><span><input id="materialBaseColor" type="color" value="${toHex(value.baseColor)}">${resetButtonMarkup('materialBaseColor', '基础颜色')}</span></label><label><span>发光颜色</span><span><input id="materialEmissive" type="color" value="${toHex(value.emissive)}">${resetButtonMarkup('materialEmissive', '发光颜色')}</span></label></div>
      <div class="parameter-group-heading"><strong>材质参数</strong><small data-adjusted-count="material-basic">已调整 0 项</small></div>${basicParameters.map(rangeMarkup).join('')}
      <label class="select-row material-side-row"><span><strong>网格表面</strong><small>模型原始设置：${originalDoubleSided}</small></span><select id="materialDoubleSided"><option value="false">单面</option><option value="true">双面</option></select></label>
      <p class="material-side-help">双面会显示网格背面；存在重叠面或内部结构时，可能出现穿插、重影或闪烁，并不代表更高画质。</p>
      <label class="select-row"><span><strong>透明模式</strong></span><select id="materialAlphaMode"><option value="OPAQUE">不透明</option><option value="MASK">遮罩</option><option value="BLEND">混合</option></select></label>
      ${advanced.length ? `<details class="advanced-material"><summary>高级物理参数 <small data-adjusted-count="material-advanced">已调整 0 项</small></summary>${advanced.map(rangeMarkup).join('')}</details>` : ''}`;
    for (const parameter of [...basicParameters, ...advanced]) this.bindMaterialRange(parameter, value[parameter.key]);
    container.querySelector('#materialBaseColor').addEventListener('input', (event) => this.updateMaterial({ baseColor: [...fromHex(event.target.value), value.baseColor[3] ?? 1] }));
    container.querySelector('#materialEmissive').addEventListener('input', (event) => this.updateMaterial({ emissive: fromHex(event.target.value) }));
    container.querySelector('[data-reset="materialBaseColor"]').addEventListener('click', () => this.resetMaterialParameter('baseColor'));
    container.querySelector('[data-reset="materialEmissive"]').addEventListener('click', () => this.resetMaterialParameter('emissive'));
    const doubleSided = container.querySelector('#materialDoubleSided'); doubleSided.value = String(value.doubleSided); doubleSided.addEventListener('change', (event) => this.updateDoubleSided(event));
    const alphaMode = container.querySelector('#materialAlphaMode'); alphaMode.value = value.alphaMode; alphaMode.addEventListener('change', (event) => this.updateMaterial({ alphaMode: event.target.value }));
    this.renderTextureChannels(material, container.querySelector('#materialTextureGrid'), renderToken);
  }

  async renderTextureChannels(material, grid, renderToken) {
    const channels = getMaterialTextureChannels(material);
    grid.innerHTML = channels.map((channel) => `<article class="texture-card" data-texture-channel="${channel.key}"><div class="texture-preview"><span>${channel.texture ? '生成预览中' : '未使用贴图'}</span></div><div class="texture-meta"><strong></strong><small class="texture-name"></small><small class="texture-description"></small></div></article>`).join('');
    const cards = [...grid.querySelectorAll('.texture-card')];
    channels.forEach((channel, channelIndex) => {
      const card = cards[channelIndex];
      card.querySelector('.texture-meta > strong').textContent = channel.label;
      card.querySelector('.texture-description').textContent = channel.description;
      if (!channel.texture) {
        card.classList.add('empty');
        card.querySelector('.texture-name').textContent = '未使用贴图';
        return;
      }
      const source = channel.texture.source;
      card.querySelector('.texture-name').textContent = source?.name || channel.texture.name || (source?.type === 'external' ? '外部纹理' : '嵌入纹理');
      this.getTextureThumbnail(channel.texture).then((thumbnail) => {
        if (!thumbnail || renderToken !== this.materialRenderToken || !card.isConnected) return;
        const image = new Image();
        image.src = thumbnail;
        image.alt = `${channel.label}贴图预览`;
        card.querySelector('.texture-preview').replaceChildren(image);
      }).catch(() => {
        if (renderToken !== this.materialRenderToken || !card.isConnected) return;
        card.classList.add('thumbnail-error');
        card.querySelector('.texture-preview span').textContent = '预览不可用';
      });
    });
  }

  getTextureThumbnail(texture) {
    if (!texture?.source || typeof texture.source.createThumbnail !== 'function') return Promise.resolve(null);
    if (!this.textureThumbnailCache.has(texture)) this.textureThumbnailCache.set(texture, texture.source.createThumbnail(160, 112));
    return this.textureThumbnailCache.get(texture);
  }

  updateDoubleSided(event) {
    if (this.doubleSidedUpdating) return;
    const select = event.currentTarget;
    const index = Number(this.root.querySelector('#materialSelect').value || 0);
    const material = this.materials[index];
    if (!material) return;
    const previous = material.getDoubleSided();
    const requested = select.value === 'true';
    this.doubleSidedUpdating = true;
    select.disabled = true;
    try {
      material.setDoubleSided(requested);
      if (material.getDoubleSided() !== requested) throw new Error('DOUBLE_SIDED_MISMATCH');
      this.materialsByIndex[index] = readMaterial(material);
      this.persist();
      this.updateMaterialResetButtons(index);
    } catch {
      try { material.setDoubleSided(previous); } catch { /* keep editor usable */ }
      select.value = String(previous);
      this.onMessage('无法更新网格表面设置，已恢复之前的状态。', 'error');
    } finally {
      select.disabled = false;
      this.doubleSidedUpdating = false;
    }
  }

  bindMaterialRange(parameter, value) {
    const input = this.root.querySelector(`#${CSS.escape(parameter.id)}`);
    if (!input) return;
    input.value = value;
    const number = this.root.querySelector(`[data-number="${parameter.id}"]`);
    number.value = formatStudioParameter(parameter, value);
    const update = (raw) => {
      const next = clampStudioParameter(parameter, raw, value);
      input.value = next;
      number.value = formatStudioParameter(parameter, next);
      this.updateMaterial({ [parameter.key]: next });
    };
    input.addEventListener('input', (event) => update(event.target.value));
    number.addEventListener('change', (event) => update(event.target.value));
    number.addEventListener('blur', (event) => update(event.target.value));
    this.root.querySelector(`[data-reset="${CSS.escape(parameter.id)}"]`)?.addEventListener('click', () => this.resetMaterialParameter(parameter.key));
    const index = Number(this.root.querySelector('#materialSelect').value || 0);
    const reset = this.root.querySelector(`[data-reset="${CSS.escape(parameter.id)}"]`);
    if (reset) reset.disabled = Number(value) === Number(this.originalMaterials[index]?.[parameter.key]);
  }

  updateMaterial(change) {
    const index = Number(this.root.querySelector('#materialSelect').value || 0);
    const material = this.materials[index];
    if (!material) return;
    applyMaterial(material, change);
    this.materialsByIndex[index] = readMaterial(material);
    this.persist();
    this.updateMaterialResetButtons(index);
  }

  updateMaterialResetButtons(index = Number(this.root.querySelector('#materialSelect').value || 0)) {
    const current = this.materials[index] ? readMaterial(this.materials[index]) : null;
    const original = this.originalMaterials[index];
    if (!current || !original) return;
    for (const parameter of [...studioParameters('material-basic'), ...studioParameters('material-advanced')]) {
      const button = this.root.querySelector(`[data-reset="${CSS.escape(parameter.id)}"]`);
      if (button) button.disabled = JSON.stringify(current[parameter.key]) === JSON.stringify(original[parameter.key]);
    }
    for (const group of ['material-basic', 'material-advanced']) {
      const target = this.root.querySelector(`[data-adjusted-count="${group}"]`);
      if (target) target.textContent = `已调整 ${countChangedStudioParameters(current, original, group)} 项`;
    }
  }

  resetMaterialParameter(key) {
    const index = Number(this.root.querySelector('#materialSelect').value || 0);
    const original = this.originalMaterials[index];
    if (!original || !(key in original)) return;
    const parameter = [...studioParameters('material-basic'), ...studioParameters('material-advanced')].find((item) => item.key === key);
    this.updateMaterial(resetStudioParameter({}, original, parameter));
  }

  resetCurrentMaterial() {
    const index = Number(this.root.querySelector('#materialSelect').value || 0);
    if (!this.materials[index] || !this.originalMaterials[index]) return;
    applyMaterial(this.materials[index], this.originalMaterials[index]);
    delete this.materialsByIndex[index];
    this.persist();
    this.renderMaterialControls();
  }

  resetAllMaterials() {
    this.materials.forEach((material, index) => applyMaterial(material, this.originalMaterials[index]));
    this.materialsByIndex = {};
    this.persist();
    this.renderMaterialControls();
  }

  async resetModelAppearance() {
    if (!this.modelId) return;
    this.cancelPersist?.();
    clearStudioState(this.modelId);
    const appearance = await this.resolveAppearance(this.modelId);
    this.defaultLighting = appearance.projectDefault;
    this.defaultLightingWritable = appearance.writable;
    const saveButton = this.root.querySelector('#saveDefaultLighting');
    saveButton.disabled = !appearance.writable;
    saveButton.title = appearance.writable ? '保存后所有访问者首次预览都使用这套光照' : '只能在运行服务的电脑上保存';
    this.lighting = sanitizeLighting(appearance.lighting);
    applyLighting(this.viewer, this.lighting);
    applyNormalStrength(this.materials, this.lighting.normalStrength, this.originalNormalScales, this.viewer);
    this.syncLightingUI();
    this.resetAllMaterials();
    this.cancelPersist?.();
    clearStudioState(this.modelId);
    this.onMessage('已恢复模型的默认光照和材质。', 'success');
  }

  persist() {
    if (!this.modelId) return;
    this.persistWriter.queue({
      modelId: this.modelId,
      snapshot: { version: STUDIO_STATE_VERSION, lighting: { ...this.lighting }, materialsByIndex: structuredClone(this.materialsByIndex) },
    });
  }

  flushPersist() {
    this.persistWriter?.flush();
  }

  cancelPersist() {
    this.persistWriter?.cancel();
  }

  getSnapshot() {
    return { version: STUDIO_STATE_VERSION, lighting: { ...this.lighting }, materialsByIndex: structuredClone(this.materialsByIndex) };
  }
}
