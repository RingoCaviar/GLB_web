import { saveDefaultLighting } from './lighting-defaults.js';
import environmentPresetList from './environment-presets.generated.js';
import {
  applyRealtimePostprocessing, applyRealtimeToneMapping,
  loadRealtimePostprocessing, saveRealtimePostprocessing,
} from './realtime-postprocessing.js';
import {
  clearStudioState, DEFAULT_LIGHTING, loadStudioState, resolveModelAppearance,
  sanitizeLighting, saveStudioState, STUDIO_STATE_VERSION, STUDIO_STORAGE_PREFIX,
} from './model-appearance.js';
import {
  clampStudioParameter, countChangedStudioParameters, formatStudioParameter,
  resetStudioParameter, studioNumericParameters, studioParameters, visibleStudioParameters,
} from './render-studio-parameters.js';
import { createCoalescedWriter } from './coalesced-writer.js';
import { appearanceVariantTemplate } from './appearance-variants.js';

export { clearStudioState, DEFAULT_LIGHTING, loadStudioState, sanitizeLighting, saveStudioState, STUDIO_STATE_VERSION, STUDIO_STORAGE_PREFIX };

export const ENVIRONMENT_PRESETS = Object.freeze(Object.fromEntries(environmentPresetList.map(({ key, ...preset }) => [key, Object.freeze(preset)])));

function environmentThumbnail(preset) {
  return `<img src="${preset.thumbnailUrl}" alt="" width="320">`;
}

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};


function getCorrelatedMaterials(material) {
  const symbol = Object.getOwnPropertySymbols(material ?? {}).find((item) => item.description === 'correlatedObjects');
  const correlated = symbol ? material[symbol] : null;
  return correlated instanceof Set ? correlated : [];
}

export function applyMaterialNormalStrength(material, strength = 1, originalScales = new WeakMap(), viewer = null) {
  const safeStrength = clamp(strength, 0, 2, 1);
  if (!material?.normalTexture?.texture) return null;
  for (const threeMaterial of getCorrelatedMaterials(material)) {
    if (!threeMaterial?.normalScale?.set) continue;
    if (!originalScales.has(threeMaterial)) originalScales.set(threeMaterial, { x: threeMaterial.normalScale.x, y: threeMaterial.normalScale.y });
    const original = originalScales.get(threeMaterial);
    threeMaterial.normalScale.set(original.x * safeStrength, original.y * safeStrength);
    threeMaterial.needsUpdate = true;
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

export function readMaterial(material, normalStrengths = new WeakMap()) {
  const pbr = material.pbrMetallicRoughness;
  return {
    baseColor: copy(pbr.baseColorFactor), metallic: pbr.metallicFactor, roughness: pbr.roughnessFactor,
    emissive: copy(material.emissiveFactor), emissiveStrength: material.emissiveStrength,
    doubleSided: material.getDoubleSided(), alphaMode: material.getAlphaMode(),
    clearcoat: Number.isFinite(material.clearcoatFactor) ? material.clearcoatFactor : 0,
    clearcoatRoughness: Number.isFinite(material.clearcoatRoughnessFactor) ? material.clearcoatRoughnessFactor : 0,
    transmission: Number.isFinite(material.transmissionFactor) ? material.transmissionFactor : 0,
    ior: Number.isFinite(material.ior) ? material.ior : 1,
    thickness: Number.isFinite(material.thicknessFactor) ? material.thicknessFactor : 0,
    specular: Number.isFinite(material.specularFactor) ? material.specularFactor : 0,
    iridescence: Number.isFinite(material.iridescenceFactor) ? material.iridescenceFactor : 0,
    anisotropy: Number.isFinite(material.anisotropyStrength) ? material.anisotropyStrength : 0,
    ...(material.normalTexture?.texture ? { normalStrength: normalStrengths.get(material) ?? 1 } : {}),
  };
}

export function applyMaterial(material, value = {}, { originalNormalScales, normalStrengths, viewer } = {}) {
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
  if (Number.isFinite(value.normalStrength) && originalNormalScales) {
    const applied = applyMaterialNormalStrength(material, value.normalStrength, originalNormalScales, viewer);
    if (applied !== null) normalStrengths?.set(material, applied);
  }
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
  applyRealtimeToneMapping(viewer, safe.toneMapping);
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
  return `<div id="renderStudio">
    <section class="settings-category-panel" id="settings-category-post" data-settings-category-panel="post" aria-labelledby="settings-toggle-post" hidden inert>
      <div class="settings-category-panel-inner">
        <section class="panel-section studio-section post-section" aria-label="后处理参数">
          <section class="studio-area" aria-labelledby="previewEffectsTitle">
            <div class="studio-area-heading">
              <h3 id="previewEffectsTitle">实时预览效果</h3>
              <p class="studio-help" id="previewEffectsScope">SMAA 和 SSAO 仅用于预览。PNG 抗锯齿由导出质量决定。</p>
            </div>
            <label class="switch-row compact-switch studio-switch-row">
              <span><strong>SMAA 抗锯齿</strong><span class="studio-help" id="realtimeSmaaHelp">平滑模型轮廓与斜线</span></span>
              <span class="switch-control"><input id="realtimeSmaa" type="checkbox" role="switch" aria-label="SMAA 抗锯齿" aria-describedby="realtimeSmaaHelp previewEffectsScope" checked><i></i></span>
            </label>
            <label class="switch-row compact-switch studio-switch-row">
              <span><strong>SSAO 环境遮蔽</strong><span class="studio-help" id="realtimeSsaoHelp">增强接缝与接触层次</span></span>
              <span class="switch-control"><input id="realtimeSsao" type="checkbox" role="switch" aria-label="SSAO 环境遮蔽" aria-describedby="realtimeSsaoHelp previewEffectsScope" checked><i></i></span>
            </label>
            <div class="ssao-tuning" hidden>
              <label><span>强度</span><input id="realtimeSsaoStrength" type="range" aria-label="SSAO 强度" min="0" max="4" step="0.1"><output for="realtimeSsaoStrength"></output></label>
              <label><span>半径</span><input id="realtimeSsaoRadius" type="range" aria-label="SSAO 半径" min="0.01" max="0.5" step="0.01"><output for="realtimeSsaoRadius"></output></label>
              <label><span>采样</span><input id="realtimeSsaoSamples" type="range" aria-label="SSAO 采样数" min="8" max="64" step="8"><output for="realtimeSsaoSamples"></output></label>
            </div>
          </section>
          <label class="select-row studio-tone-mapping">
            <span><strong>色调映射</strong><span class="studio-help" id="toneMappingHelp">调整预览和 PNG 的高光与明暗</span></span>
            <select id="toneMapping" aria-label="色调映射" aria-describedby="toneMappingHelp"><option value="neutral">Neutral · 中性</option><option value="aces">ACES · 电影色调</option><option value="agx">AgX · 柔和高光</option><option value="commerce">Commerce · 商品</option></select>
          </label>
        </section>
      </div>
    </section>
    <section class="settings-category-panel" id="settings-category-lighting" data-settings-category-panel="lighting" aria-labelledby="settings-toggle-lighting" hidden inert>
      <div class="settings-category-panel-inner">
        <section class="panel-section studio-section lighting-section" aria-label="灯光参数">
          <div class="studio-area-heading"><h3>环境与光照</h3></div>
          <div class="environment-picker">
            <button class="environment-picker-toggle" id="environmentPickerToggle" type="button" aria-haspopup="dialog">
              <span><strong>HDRI 环境</strong><small id="environmentStatus" role="status">用全景图为模型打光</small></span>
              <span class="environment-current" id="environmentCurrent"></span>
            </button>
            <dialog class="environment-dialog" id="environmentDialog" aria-labelledby="environmentDialogTitle">
              <div class="environment-dialog-heading">
                <div><strong id="environmentDialogTitle">选择 HDRI 环境</strong><small>选择全景光照，立即应用到模型</small></div>
                <button id="environmentDialogClose" type="button" aria-label="关闭 HDRI 选择窗口">×</button>
              </div>
              <div class="environment-grid" id="environmentPresetGrid">${Object.entries(ENVIRONMENT_PRESETS).map(([key, preset]) => `
                <button class="environment-card" type="button" data-environment-preset="${key}" aria-pressed="false">
                  <span class="environment-card-preview">${key === 'neutral' ? '<span class="environment-placeholder">无 HDRI</span>' : environmentThumbnail(preset)}</span>
                  <span>${preset.label}</span>
                </button>`).join('')}</div>
            </dialog>
          </div>
          <label class="switch-row compact-switch studio-switch-row">
            <span><strong>HDRI 去色</strong><span class="studio-help" id="environmentDesaturateHelp">保留明暗，减少环境色偏</span></span>
            <span class="switch-control"><input id="environmentDesaturate" type="checkbox" role="switch" aria-label="HDRI 去色" aria-describedby="environmentDesaturateHelp" checked><i></i></span>
          </label>
          <label class="switch-row compact-switch studio-switch-row">
            <span><strong>预览 HDRI 背景</strong><span class="studio-help" id="environmentPreviewHelp">PNG 使用导出设置中的背景</span></span>
            <span class="switch-control"><input id="environmentPreview" type="checkbox" role="switch" aria-label="预览 HDRI 背景" aria-describedby="environmentPreviewHelp" checked><i></i></span>
          </label>
          <section class="parameter-group"><div class="parameter-group-heading"><strong>照明</strong><small data-adjusted-count="lighting">已调整 0 项</small></div><div id="lightingControls"></div></section>
          <details class="parameter-group collapsible-parameter-group"><summary>环境方向 <small data-adjusted-count="rotation">已调整 0 项</small></summary><div id="environmentRotationControl"></div></details>
          <div class="studio-actions lighting-actions">
            <button class="secondary-button" id="resetLighting" type="button">重置环境与光照</button>
            <button class="secondary-button" id="saveDefaultLighting" type="button" aria-describedby="projectLightingScope" aria-controls="projectLightingConfirmation" aria-expanded="false" disabled>设为项目默认光照</button>
          </div>
          <div class="studio-reset-feedback" data-reset-feedback="lighting">
            <p class="studio-action-status" role="status"></p>
            <button class="secondary-button" id="undoLightingReset" type="button" hidden>撤销重置</button>
          </div>
          <p class="studio-help studio-action-scope" id="projectLightingScope">正在读取项目默认光照…</p>
          <div class="studio-confirmation" id="projectLightingConfirmation" role="group" aria-labelledby="projectLightingConfirmationText" hidden>
            <p class="studio-help" id="projectLightingConfirmationText">将当前光照设为所有访问者的项目默认光照？</p>
            <div class="studio-actions">
              <button class="secondary-button" id="cancelDefaultLighting" type="button">取消</button>
              <button class="secondary-button" id="confirmDefaultLighting" type="button">确认设为项目默认</button>
            </div>
          </div>
          <p class="studio-action-status" id="projectLightingStatus" role="status" tabindex="-1"></p>
        </section>
      </div>
    </section>
    <section class="settings-category-panel" id="settings-category-material" data-settings-category-panel="material" aria-labelledby="settings-toggle-material" hidden inert>
      <div class="settings-category-panel-inner">
        <section class="panel-section studio-section material-section" aria-label="材质参数">
          ${appearanceVariantTemplate()}
          <section class="studio-area material-area" aria-labelledby="materialAreaTitle">
            <div class="studio-area-heading"><h3 id="materialAreaTitle">材质效果</h3></div>
            <label class="select-row material-picker">
              <span><strong>当前材质</strong><span class="studio-help" id="materialCount">请先加载模型</span></span>
              <select id="materialSelect" aria-label="当前材质" aria-describedby="materialCount materialScope" disabled></select>
            </label>
            <p class="studio-help studio-material-scope" id="materialScope">修改仅作用于所选材质。</p>
            <div id="materialControls" class="material-controls"></div>
            <div class="studio-actions material-actions">
              <button class="secondary-button" id="resetMaterial" type="button" disabled>重置当前材质</button>
              <button class="secondary-button" id="resetAllMaterials" type="button" disabled>重置全部材质</button>
            </div>
            <button class="secondary-button danger-button" id="resetModelAppearance" type="button" disabled>恢复默认光照与材质</button>
            <div class="studio-reset-feedback" data-reset-feedback="material">
              <p class="studio-action-status" role="status"></p>
              <button class="secondary-button" id="undoMaterialReset" type="button" hidden>撤销重置</button>
            </div>
            <details class="texture-channels" id="materialTextureChannels" hidden>
              <summary><span>纹理通道</span><span class="studio-help" id="materialTextureCount"></span></summary>
              <p class="studio-help texture-scope">来自当前 GLB，仅供查看。</p>
              <div class="texture-grid" id="materialTextureGrid"></div>
            </details>
          </section>
        </section>
      </div>
    </section>
  </div>`;
}

const toHex = (rgb) => `#${rgb.slice(0, 3).map((value) => Math.round(clamp(value, 0, 1, 0) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
const resetIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.4 7.2A6 6 0 1 1 4 12.9M4.4 7.2V3.8m0 3.4h3.4"/></svg>';
const resetButtonMarkup = (key, label) => `<button class="parameter-reset" type="button" data-reset="${key}" aria-label="重置${label}" title="重置${label}">${resetIcon}</button>`;
function rangeMarkup({ id, label, min, max, step, unit }) {
  const unitLabel = unit ? `（${unit === '°' ? '度' : unit}）` : '';
  return `<div class="studio-range">
    <div class="studio-range-heading">
      <label for="${id}">${label}</label>
      <span>
        <input data-number="${id}" type="number" aria-label="${label}数值${unitLabel}" min="${min}" max="${max}" step="${step}">
        ${unit ? `<em aria-hidden="true">${unit}</em>` : ''}
        ${resetButtonMarkup(id, label)}
      </span>
    </div>
    <input id="${id}" type="range"${unit ? ` aria-label="${label}${unitLabel}"` : ''} min="${min}" max="${max}" step="${step}">
  </div>`;
}

function syncProjectLightingAccess(studio, appearance) {
  studio.defaultLightingWritable = appearance.writable;
  studio.root.querySelector('#saveDefaultLighting').disabled = !appearance.writable || studio.savingDefaultLighting;
  studio.root.querySelector('#projectLightingScope').textContent = appearance.writable
    ? '所有访问者共用。已保存的模型光照优先。'
    : '仅运行服务的电脑可更新项目默认光照。';
}

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
    this.savingDefaultLighting = false;
    this.resetUndo = null;
    this.originalNormalScales = new WeakMap();
    this.materialNormalStrengths = new WeakMap();
    this.realtimePostprocessing = loadRealtimePostprocessing();
    this.persistWriter = createCoalescedWriter(
      ({ modelId, snapshot }) => saveStudioState(modelId, snapshot),
      200,
    );
    root.querySelector('#lightingControls').innerHTML = studioNumericParameters('lighting').map(rangeMarkup).join('');
    root.querySelector('#environmentRotationControl').innerHTML = studioNumericParameters('rotation').map(rangeMarkup).join('');
    this.bindLighting();
    this.bindRealtimePostprocessing();
    root.querySelector('#materialSelect').addEventListener('change', () => this.renderMaterialControls());
    root.querySelector('#resetMaterial').addEventListener('click', () => this.resetCurrentMaterial());
    root.querySelector('#resetAllMaterials').addEventListener('click', () => this.resetAllMaterials());
    root.querySelector('#resetModelAppearance').addEventListener('click', () => this.resetModelAppearance());
    root.querySelector('#undoLightingReset').addEventListener('click', () => this.undoLastReset('lighting'));
    root.querySelector('#undoMaterialReset').addEventListener('click', () => this.undoLastReset('material'));
    this.syncLightingUI();
    this.defaultLightingReady = this.loadSharedDefault();
  }

  bindRealtimePostprocessing() {
    const ssaoTuning = this.root.querySelector('.ssao-tuning');
    ssaoTuning.hidden = !this.realtimePostprocessing.ssao;
    const controls = [
      ['#realtimeSmaa', 'smaa'],
      ['#realtimeSsao', 'ssao'],
    ];
    for (const [selector, key] of controls) {
      const control = this.root.querySelector(selector);
      control.checked = this.realtimePostprocessing[key];
      control.addEventListener('change', () => {
        this.realtimePostprocessing[key] = control.checked;
        if (key === 'ssao') ssaoTuning.hidden = !control.checked;
        applyRealtimePostprocessing(this.viewer, this.realtimePostprocessing);
        saveRealtimePostprocessing(this.realtimePostprocessing);
      });
    }
    applyRealtimePostprocessing(this.viewer, this.realtimePostprocessing);
    for (const [id, key] of [['realtimeSsaoStrength', 'ssaoStrength'], ['realtimeSsaoRadius', 'ssaoRadius'], ['realtimeSsaoSamples', 'ssaoSamples']]) {
      const input = this.root.querySelector(`#${id}`); const output = input.nextElementSibling;
      input.value = this.realtimePostprocessing[key]; output.value = input.value;
      input.addEventListener('input', () => { this.realtimePostprocessing[key] = Number(input.value); output.value = input.value; applyRealtimePostprocessing(this.viewer, this.realtimePostprocessing); saveRealtimePostprocessing(this.realtimePostprocessing); });
    }
    // The effects composer creates its normal buffer when a model is loaded;
    // re-apply once then so SSAO receives that buffer as well.
    this.viewer.addEventListener('load', () => {
      applyRealtimePostprocessing(this.viewer, this.realtimePostprocessing);
      setTimeout(() => applyRealtimePostprocessing(this.viewer, this.realtimePostprocessing), 250);
    });
  }

  bindLighting() {
    for (const parameter of this.globalAppearanceParameters()) this.bindLightingParameter(parameter);
    this.root.querySelector('#toneMapping').addEventListener('change', (event) => {
      if (event.target.value !== this.lighting.toneMapping) this.markLightingEdit();
      this.lighting.toneMapping = event.target.value;
      applyRealtimeToneMapping(this.viewer, event.target.value);
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
        const grid = this.root.querySelector('#environmentPresetGrid');
        const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
        if (!(event.key in offsets)) return;
        event.preventDefault();
        cards[(index + offsets[event.key] + cards.length) % cards.length].focus();
      });
    }
    this.root.querySelector('#environmentDesaturate').addEventListener('change', (event) => {
      if (event.target.checked !== this.lighting.desaturate) this.markLightingEdit();
      this.lighting.desaturate = event.target.checked;
      applyLighting(this.viewer, this.lighting);
      this.persist();
      this.updateResetButtons();
    });
    this.root.querySelector('#environmentPreview').addEventListener('change', (event) => {
      if (event.target.checked !== this.lighting.showEnvironment) this.markLightingEdit();
      this.lighting.showEnvironment = event.target.checked;
      applyLighting(this.viewer, this.lighting);
      this.persist();
      this.updateResetButtons();
    });
    this.root.querySelector('#resetLighting').addEventListener('click', (event) => {
      const previous = { ...this.lighting };
      this.closeProjectLightingConfirmation();
      this.restoreLighting(this.defaultLighting);
      this.persist();
      if (Object.keys(previous).some((key) => previous[key] !== this.lighting[key])) {
        this.showResetFeedback('lighting', '已重置环境与光照。', {
          groups: ['lighting'],
          focusTarget: event.currentTarget,
          restore: () => this.restoreLighting(previous),
        });
      }
    });
    this.bindProjectLightingConfirmation();
  }

  bindProjectLightingConfirmation() {
    const trigger = this.root.querySelector('#saveDefaultLighting');
    const confirmation = this.root.querySelector('#projectLightingConfirmation');
    const cancel = this.root.querySelector('#cancelDefaultLighting');
    trigger.addEventListener('click', () => {
      if (!this.defaultLightingWritable || this.savingDefaultLighting) return;
      if (!confirmation.hidden) {
        this.closeProjectLightingConfirmation();
        return;
      }
      this.root.querySelector('#projectLightingStatus').textContent = '';
      confirmation.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      cancel.focus();
    });
    cancel.addEventListener('click', () => this.closeProjectLightingConfirmation());
    this.root.querySelector('#confirmDefaultLighting').addEventListener('click', () => {
      if (confirmation.hidden) return;
      this.closeProjectLightingConfirmation();
      this.saveSharedDefault();
      this.root.querySelector('#projectLightingStatus').focus({ preventScroll: true });
    });
    confirmation.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.closeProjectLightingConfirmation();
    });
  }

  closeProjectLightingConfirmation() {
    const confirmation = this.root.querySelector('#projectLightingConfirmation');
    if (confirmation.hidden) return;
    const restoreFocus = confirmation.contains(document.activeElement);
    confirmation.hidden = true;
    const trigger = this.root.querySelector('#saveDefaultLighting');
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  markLightingEdit() {
    this.clearResetFeedback('lighting');
    this.closeProjectLightingConfirmation();
  }

  restoreLighting(lighting) {
    this.lighting = { ...lighting };
    applyLighting(this.viewer, this.lighting);
    this.root.querySelector('#environmentStatus').textContent = '用全景图为模型打光';
    this.syncLightingUI();
  }

  bindLightingParameter(parameter) {
    const range = this.root.querySelector(`#${parameter.id}`);
    const number = this.root.querySelector(`[data-number="${parameter.id}"]`);
    const update = (raw) => {
      const value = clampStudioParameter(parameter, raw, this.lighting[parameter.key]);
      if (value !== this.lighting[parameter.key]) this.markLightingEdit();
      this.lighting[parameter.key] = value;
      range.value = value;
      number.value = formatStudioParameter(parameter, value);
      if (parameter.group === 'rotation') applyEnvironmentRotation(this.viewer, this.lighting);
      else this.viewer[parameter.key] = value;
      this.persist();
      this.updateResetButtons();
    };
    range.addEventListener('input', (event) => update(event.target.value));
    number.addEventListener('change', (event) => update(event.target.value));
    number.addEventListener('blur', (event) => update(event.target.value));
    this.root.querySelector(`[data-reset="${parameter.id}"]`).addEventListener('click', () => this.resetLightingParameter(parameter.key));
  }

  globalAppearanceParameters(kind = 'number') {
    const groups = ['lighting', 'rotation'];
    return groups.flatMap((group) => kind === 'number' ? studioNumericParameters(group) : studioParameters(group));
  }

  resetLightingParameter(key) {
    const parameter = this.globalAppearanceParameters('all').find((item) => item.key === key);
    this.markLightingEdit();
    this.lighting = resetStudioParameter(this.lighting, this.defaultLighting, parameter);
    applyLighting(this.viewer, this.lighting);
    this.syncLightingUI();
    this.persist();
  }

  async loadSharedDefault() {
    const appearance = await this.resolveAppearance(null);
    this.defaultLighting = appearance.projectDefault;
    syncProjectLightingAccess(this, appearance);
    if (!this.modelId) {
      this.lighting = { ...appearance.projectDefault };
      applyLighting(this.viewer, this.lighting);
      this.syncLightingUI();
    }
  }

  async saveSharedDefault() {
    if (!this.defaultLightingWritable || this.savingDefaultLighting) return;
    const button = this.root.querySelector('#saveDefaultLighting');
    const status = this.root.querySelector('#projectLightingStatus');
    this.savingDefaultLighting = true;
    button.disabled = true;
    status.className = 'studio-action-status';
    status.textContent = '正在保存项目默认光照…';
    try {
      this.defaultLighting = sanitizeLighting(await saveDefaultLighting(this.lighting));
      this.updateResetButtons();
      status.className = 'studio-action-status success';
      status.textContent = '已保存项目默认光照。';
    } catch {
      status.className = 'studio-action-status error';
      status.textContent = '项目默认光照保存失败。请在运行服务的电脑上重试。';
    } finally {
      this.savingDefaultLighting = false;
      button.disabled = !this.defaultLightingWritable;
    }
  }

  async selectPreset(key, reset = false) {
    const preset = ENVIRONMENT_PRESETS[key] ?? ENVIRONMENT_PRESETS.neutral;
    const previousLighting = { ...this.lighting };
    this.markLightingEdit();
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
      this.syncLightingUI();
      status.textContent = '环境加载失败，已保留上一个环境';
      this.onMessage('环境贴图加载失败，已保留上一个可用环境。', 'error');
    }
    for (const card of this.root.querySelectorAll('.environment-card')) card.classList.remove('loading');
    this.persist();
  }

  syncLightingUI() {
    const preset = ENVIRONMENT_PRESETS[this.lighting.preset];
    const currentLabel = preset.url === 'neutral'
      ? '<strong class="environment-placeholder">无 HDRI</strong>'
      : `${environmentThumbnail(preset)}<strong>${preset.label}</strong>`;
    this.root.querySelector('#environmentCurrent').innerHTML = `${currentLabel}<i aria-hidden="true">⌄</i>`;
    for (const card of this.root.querySelectorAll('[data-environment-preset]')) {
      const selected = card.dataset.environmentPreset === this.lighting.preset;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
    }
    this.root.querySelector('#toneMapping').value = this.lighting.toneMapping;
    this.root.querySelector('#environmentDesaturate').checked = this.lighting.desaturate;
    this.root.querySelector('#environmentPreview').checked = this.lighting.showEnvironment;
    for (const parameter of this.globalAppearanceParameters()) {
      const value = this.lighting[parameter.key];
      this.root.querySelector(`#${parameter.id}`).value = value;
      this.root.querySelector(`[data-number="${parameter.id}"]`).value = formatStudioParameter(parameter, value);
    }
    this.updateResetButtons();
  }

  updateResetButtons() {
    for (const parameter of this.globalAppearanceParameters('all')) {
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
    this.clearResetFeedback();
    this.closeProjectLightingConfirmation();
    await this.defaultLightingReady;
    const appearance = await this.resolveAppearance(modelId);
    this.defaultLighting = appearance.projectDefault;
    syncProjectLightingAccess(this, appearance);
    this.modelId = modelId;
    this.materials = [...(this.viewer.model?.materials ?? [])];
    this.originalNormalScales = new WeakMap();
    this.materialNormalStrengths = new WeakMap();
    for (const material of this.materials) {
      applyMaterialNormalStrength(material, 1, this.originalNormalScales, this.viewer);
      if (material.normalTexture?.texture) this.materialNormalStrengths.set(material, 1);
    }
    this.originalMaterials = this.materials.map((material) => readMaterial(material, this.materialNormalStrengths));
    this.materialsByIndex = appearance.materialsByIndex;
    this.restoreLighting(sanitizeLighting(appearance.lighting));
    this.materials.forEach((material, index) => {
      if (this.materialsByIndex[index]) applyMaterial(material, this.materialsByIndex[index], this.materialApplyOptions());
    });
    const select = this.root.querySelector('#materialSelect');
    select.replaceChildren(...this.materials.map((material, index) =>
      new Option(`${index + 1}. ${material.name || `未命名材质 ${index + 1}`}`, index),
    ));
    select.disabled = this.materials.length === 0;
    this.root.querySelector('#materialCount').textContent = `${this.materials.length} 个材质`;
    for (const id of ['resetMaterial', 'resetAllMaterials', 'resetModelAppearance']) this.root.querySelector(`#${id}`).disabled = this.materials.length === 0;
    this.renderMaterialControls();
  }

  unloadModel() {
    this.flushPersist();
    this.clearResetFeedback();
    this.closeProjectLightingConfirmation();
    this.materialRenderToken += 1;
    this.modelId = null;
    this.materials = [];
    this.originalMaterials = [];
    this.materialsByIndex = {};
    this.originalNormalScales = new WeakMap();
    this.materialNormalStrengths = new WeakMap();
    this.root.querySelector('#materialSelect').innerHTML = '';
    this.root.querySelector('#materialSelect').disabled = true;
    this.root.querySelector('#materialCount').textContent = '请先加载模型';
    this.root.querySelector('#materialControls').innerHTML = '';
    const textureDetails = this.root.querySelector('#materialTextureChannels');
    textureDetails.open = false;
    textureDetails.hidden = true;
    textureDetails.querySelector('#materialTextureGrid').replaceChildren();
    for (const id of ['resetMaterial', 'resetAllMaterials', 'resetModelAppearance']) this.root.querySelector(`#${id}`).disabled = true;
  }

  renderMaterialControls() {
    const renderToken = ++this.materialRenderToken;
    const select = this.root.querySelector('#materialSelect');
    const index = Number(select.value || 0);
    const material = this.materials[index];
    const container = this.root.querySelector('#materialControls');
    const textureDetails = this.root.querySelector('#materialTextureChannels');
    textureDetails.hidden = !material;
    if (!material) { container.innerHTML = ''; return; }
    const value = readMaterial(material, this.materialNormalStrengths);
    const basicParameters = studioNumericParameters('material-basic');
    const advanced = visibleStudioParameters('material-advanced', material).filter((parameter) => parameter.kind === 'number');
    const originalDoubleSided = this.originalMaterials[index]?.doubleSided ? '双面' : '单面';
    container.innerHTML = `<p class="material-full-name"></p>
      <div class="parameter-group-heading"><strong>常用参数</strong><small data-adjusted-count="material-basic">已调整 0 项</small></div>
      <div class="material-colors">
        <div class="material-color-control"><label for="materialBaseColor">基础颜色</label><span><input id="materialBaseColor" type="color" value="${toHex(value.baseColor)}">${resetButtonMarkup('materialBaseColor', '基础颜色')}</span></div>
        <div class="material-color-control"><label for="materialEmissive">发光颜色</label><span><input id="materialEmissive" type="color" value="${toHex(value.emissive)}">${resetButtonMarkup('materialEmissive', '发光颜色')}</span></div>
      </div>
      ${basicParameters.map(rangeMarkup).join('')}
      <details class="advanced-material surface-options"><summary>表面选项</summary><div class="surface-options-content">
      <label class="select-row material-side-row"><span><strong>网格表面</strong><span class="studio-help" id="materialOriginalSides">模型原始设置：${originalDoubleSided}</span></span><select id="materialDoubleSided" aria-label="网格表面" aria-describedby="materialOriginalSides materialDoubleSidedHelp"><option value="false">单面</option><option value="true">双面</option></select></label>
      <p class="studio-help" id="materialDoubleSidedHelp">双面会显示网格背面。重叠面或内部结构可能产生穿插、重影或闪烁。</p>
      <label class="select-row"><span><strong>透明模式</strong></span><select id="materialAlphaMode"><option value="OPAQUE">不透明</option><option value="MASK">遮罩</option><option value="BLEND">混合</option></select></label></div></details>
      ${advanced.length ? `<details class="advanced-material"><summary>高级物理参数 <small data-adjusted-count="material-advanced">已调整 0 项</small></summary>${advanced.map(rangeMarkup).join('')}</details>` : ''}`;
    container.querySelector('.material-full-name').textContent = select.selectedOptions[0]?.textContent ?? '';
    for (const parameter of [...basicParameters, ...advanced]) {
      const fallback = parameter.key === 'normalStrength' ? 1 : parameter.min;
      this.bindMaterialRange(parameter, value[parameter.key] ?? this.originalMaterials[index]?.[parameter.key] ?? fallback);
    }
    container.querySelector('#materialBaseColor').addEventListener('input', (event) => this.updateMaterial({ baseColor: [...fromHex(event.target.value), value.baseColor[3] ?? 1] }));
    container.querySelector('#materialEmissive').addEventListener('input', (event) => this.updateMaterial({ emissive: fromHex(event.target.value) }));
    container.querySelector('[data-reset="materialBaseColor"]').addEventListener('click', () => this.resetMaterialParameter('baseColor'));
    container.querySelector('[data-reset="materialEmissive"]').addEventListener('click', () => this.resetMaterialParameter('emissive'));
    const doubleSided = container.querySelector('#materialDoubleSided'); doubleSided.value = String(value.doubleSided); doubleSided.addEventListener('change', (event) => this.updateDoubleSided(event));
    const alphaMode = container.querySelector('#materialAlphaMode'); alphaMode.value = value.alphaMode; alphaMode.addEventListener('change', (event) => this.updateMaterial({ alphaMode: event.target.value }));
    const hasNormalTexture = Boolean(material.normalTexture?.texture);
    container.querySelector('#materialNormalStrength')?.closest('.studio-range')?.toggleAttribute('hidden', !hasNormalTexture);
    for (const input of container.querySelectorAll('#materialNormalStrength, [data-number="materialNormalStrength"]')) input.disabled = !hasNormalTexture;
    this.updateMaterialResetButtons(index);
    this.renderTextureChannels(material, textureDetails, renderToken);
  }

  renderTextureChannels(material, details, renderToken) {
    const channels = getMaterialTextureChannels(material);
    const usedCount = channels.filter((channel) => channel.texture).length;
    details.querySelector('#materialTextureCount').textContent = usedCount ? `${usedCount} 个贴图` : '无贴图';
    const grid = details.querySelector('#materialTextureGrid');
    grid.innerHTML = channels.map((channel) => `<article class="texture-card${channel.texture ? '' : ' empty'}" data-texture-channel="${channel.key}">
      ${channel.texture ? '<div class="texture-preview"><span>生成预览中</span></div>' : ''}
      <div class="texture-meta"><strong></strong><small class="texture-name"></small><small class="texture-description"></small></div>
    </article>`).join('');
    const cards = [...grid.querySelectorAll('.texture-card')];
    channels.forEach((channel, channelIndex) => {
      const card = cards[channelIndex];
      card.querySelector('.texture-meta > strong').textContent = channel.label;
      card.querySelector('.texture-description').textContent = channel.description;
      if (!channel.texture) {
        card.querySelector('.texture-name').textContent = '未使用贴图';
        return;
      }
      const source = channel.texture.source;
      card.querySelector('.texture-name').textContent = source?.name || channel.texture.name || (source?.type === 'external' ? '外部纹理' : '嵌入纹理');
      const preview = card.querySelector('.texture-preview');
      this.getTextureThumbnail(channel.texture).catch(() => null).then((thumbnail) => {
        if (renderToken !== this.materialRenderToken || !card.isConnected) return;
        if (!thumbnail) {
          card.classList.add('thumbnail-error');
          preview.textContent = '预览不可用';
          return;
        }
        const image = new Image();
        image.src = thumbnail;
        image.alt = `${channel.label}贴图预览`;
        preview.replaceChildren(image);
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
      if (requested !== previous) this.clearResetFeedback('material');
      this.materialsByIndex[index] = readMaterial(material, this.materialNormalStrengths);
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
    const before = this.resetUndo?.groups.includes('material') ? readMaterial(material, this.materialNormalStrengths) : null;
    applyMaterial(material, change, this.materialApplyOptions());
    const current = readMaterial(material, this.materialNormalStrengths);
    if (before && JSON.stringify(before) !== JSON.stringify(current)) this.clearResetFeedback('material');
    this.materialsByIndex[index] = current;
    this.persist();
    this.updateMaterialResetButtons(index);
  }

  updateMaterialResetButtons(index = Number(this.root.querySelector('#materialSelect').value || 0)) {
    const current = this.materials[index] ? readMaterial(this.materials[index], this.materialNormalStrengths) : null;
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
    if (parameter?.kind === 'number') {
      const value = original[key];
      const range = this.root.querySelector(`#${CSS.escape(parameter.id)}`);
      const number = this.root.querySelector(`[data-number="${parameter.id}"]`);
      if (range) range.value = value;
      if (number) number.value = formatStudioParameter(parameter, value);
    } else if (parameter?.kind === 'color') {
      const color = this.root.querySelector(`#${CSS.escape(parameter.id)}`);
      if (color) color.value = toHex(original[key]);
    }
  }

  resetCurrentMaterial() {
    const index = Number(this.root.querySelector('#materialSelect').value || 0);
    if (!this.materials[index] || !this.originalMaterials[index]) return;
    this.rememberMaterialReset([index], 'resetMaterial', '已重置当前材质。');
    applyMaterial(this.materials[index], this.originalMaterials[index], this.materialApplyOptions());
    delete this.materialsByIndex[index];
    this.persist();
    this.renderMaterialControls();
  }

  resetAllMaterials({ remember = true } = {}) {
    if (remember) this.rememberMaterialReset(Object.keys(this.materialsByIndex), 'resetAllMaterials', '已重置全部材质。');
    this.materials.forEach((material, index) => applyMaterial(material, this.originalMaterials[index], this.materialApplyOptions()));
    this.materialsByIndex = {};
    this.persist();
    this.renderMaterialControls();
  }

  async resetModelAppearance() {
    const { modelId, materials } = this;
    if (!modelId || this.pendingAppearanceReset === materials) return;
    this.pendingAppearanceReset = materials;
    let appearance;
    try {
      appearance = await this.resolveAppearance(null);
    } finally {
      if (this.pendingAppearanceReset === materials) this.pendingAppearanceReset = null;
    }
    if (this.modelId !== modelId || this.materials !== materials) return;
    const previousLighting = Object.keys(this.lighting).some((key) => this.lighting[key] !== appearance.projectDefault[key])
      ? { ...this.lighting }
      : null;
    this.rememberMaterialReset?.(Object.keys(this.materialsByIndex), 'resetModelAppearance', '已恢复默认光照与材质。', previousLighting);
    this.closeProjectLightingConfirmation?.();
    this.defaultLighting = appearance.projectDefault;
    syncProjectLightingAccess(this, appearance);
    this.lighting = sanitizeLighting(appearance.projectDefault);
    applyLighting(this.viewer, this.lighting);
    this.syncLightingUI();
    this.resetAllMaterials({ remember: false });
    this.cancelPersist?.();
    clearStudioState(modelId);
    this.onMessage('已恢复模型的默认光照和材质。', 'success');
  }

  rememberMaterialReset(indices, buttonId, message, lighting = null) {
    const entries = indices.filter((index) => Object.hasOwn(this.materialsByIndex, index))
      .map((index) => [index, structuredClone(this.materialsByIndex[index])]);
    if (!entries.length && !lighting) return;
    this.showResetFeedback('material', message, {
      groups: lighting ? ['lighting', 'material'] : ['material'],
      focusTarget: this.root.querySelector(`#${buttonId}`),
      restore: () => {
        for (const [index, value] of entries) {
          if (this.materials[index]) applyMaterial(this.materials[index], value, this.materialApplyOptions());
          this.materialsByIndex[index] = value;
        }
        if (lighting) this.restoreLighting(lighting);
        this.renderMaterialControls();
      },
    });
  }

  clearResetFeedback(group) {
    if (group && !this.resetUndo?.groups.includes(group)) return;
    this.resetUndo = null;
    for (const feedback of this.root.querySelectorAll('[data-reset-feedback]')) {
      feedback.querySelector('p').textContent = '';
      feedback.querySelector('button').hidden = true;
    }
  }

  showResetFeedback(section, message, undo = null) {
    this.clearResetFeedback();
    const feedback = this.root.querySelector(`[data-reset-feedback="${section}"]`);
    feedback.querySelector('p').textContent = message;
    feedback.querySelector('button').hidden = !undo;
    if (undo) this.resetUndo = { section, ...undo };
  }

  undoLastReset(section) {
    const undo = this.resetUndo;
    if (undo?.section !== section) return;
    undo.restore();
    this.persist();
    this.showResetFeedback(section, '已撤销重置。');
    undo.focusTarget.focus({ preventScroll: true });
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

  materialApplyOptions() {
    return { originalNormalScales: this.originalNormalScales, normalStrengths: this.materialNormalStrengths, viewer: this.viewer };
  }
}
