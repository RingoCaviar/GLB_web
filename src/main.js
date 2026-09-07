import '@google/model-viewer';
import './style.css';
import { libraryEntries, models, parentFolder, recentModels } from './model-library.js';
import {
  createModelThumbnail,
  loadSavedModelThumbnail,
  saveModelThumbnail,
  thumbnailCapability,
} from './thumbnail-generator.js';
import {
  createBounds,
  framingInvariant,
  resolveFovChange,
  resolveSafeRadius,
  surfaceRadius,
} from './camera-constraints.js';
import {
  pointerDistance,
  zoomRadiusByPinch,
  zoomRadiusByWheel,
} from './camera-zoom.js';
import {
  applyMaximumTextureQuality,
  resetTextureQuality,
} from './render-quality.js';
import { RenderStudio, studioPanelTemplate } from './render-studio.js';
import { resolveModelAppearance } from './model-appearance.js';
import {
  sequenceLibraryEntries,
  sequenceParentFolder,
  sequenceProducts,
  sequenceWarnings,
  sequenceWritable,
  refreshSequenceLibrary,
} from './sequence-library.js';
import { SequenceViewer } from './sequence-viewer.js';
import { finalizePngExport } from './png-export.js';
import {
  ExportQualityMode,
  loadExportQuality,
  saveExportQuality,
} from './export-quality.js';
import { hasRenderRestorationFailure, renderFixedSizeImage } from './fixed-size-render.js';
import { ModelLoadingModule } from './model-loading.js';
import { ModelViewerLoadingAdapter } from './model-viewer-loading-adapter.js';
import { readExportDimensionCapability } from './webgl-capabilities.js';
import { loadSharedCameraFraming, saveSharedCameraFraming } from './shared-camera-framing.js';
import { applyBuildingCorrection, applyViewerCameraFraming } from './camera-framing-application.js';
import { applyVerticalLensShift, verticalLensShiftCapability } from './vertical-lens-shift.js';

// High-resolution exports must not be dynamically downscaled by model-viewer.
customElements.get('model-viewer').minimumRenderScale = 1;

const sharedCameraFraming = loadSharedCameraFraming();

const state = {
  theta: sharedCameraFraming.theta,
  phi: sharedCameraFraming.phi,
  radius: 1,
  fov: sharedCameraFraming.fov,
  verticalShift: sharedCameraFraming.verticalShift,
  width: 2048,
  height: 2048,
  maximumExportDimension: 8192,
  transparent: false,
  preserveShadow: false,
  exportQuality: loadExportQuality(),
  textureDetailMode: loadExportQuality() === ExportQualityMode.HIGH ? 'base-level' : 'adaptive',
  background: '#e8eaed',
  loaded: false,
  exporting: false,
  models,
  currentFolder: '',
  selectedModel: null,
  modelLibraryOpen: true,
  thumbnailWritable: false,
  thumbnailCapabilityReady: false,
  thumbnailGeneratingId: null,
  mode: 'model',
  sequenceFolder: '',
  selectedSequence: null,
  sequenceLibraryLoading: false,
  sequenceSelectionMode: false,
  selectedSequenceIds: new Set(),
  sequenceJobRunning: false,
  renderQuality: {
    applied: false,
    compatibility: false,
    maximumAnisotropy: 1,
    actualRenderScale: 1,
  },
};

let radiusCapacity = null;
let defaultRadius = null;
let radiusCapacityUpdate = Promise.resolve();
let minimumRadiusUpdate = Promise.resolve();
let cameraApplySequence = 0;
let cameraSyncSequence = 0;
let modelBounds = null;
let currentMinimumRadius = 0.000001;
let lastSafeRadius = state.radius;

document.querySelector('#app').innerHTML = `
  <main class="workspace">
    <section class="stage" aria-label="三维模型预览区">
      <header class="stage-header">
        <div>
          <span class="eyebrow">LOCAL 3D STUDIO</span>
          <h1>模型取景台</h1>
        </div>
        <div class="stage-actions">
          <div class="mode-switch" role="group" aria-label="预览模式">
            <button type="button" class="active" data-mode="model">3D 模型</button>
            <button type="button" data-mode="sequence">360° 图片</button>
          </div>
          <button class="library-button" id="openLibrary" type="button">选择模型</button>
          <div class="status-pill" id="modelStatus"><span></span>等待选择模型</div>
        </div>
      </header>

      <div class="viewer-shell" id="viewerShell" data-mode="model">
        <div class="viewer-frame" id="viewerFrame">
          <model-viewer
          id="modelViewer"
          alt="三维模型预览"
          camera-controls
          disable-tap
          touch-action="pan-y"
          camera-orbit="0deg 75deg 105%"
          field-of-view="45deg"
          min-field-of-view="10deg"
          max-field-of-view="90deg"
          min-camera-orbit="auto 1deg 0.000001m"
          max-camera-orbit="auto 179deg auto"
          shadow-intensity="0.75"
          shadow-softness="0.9"
          environment-image="neutral"
          tone-mapping="neutral"
          interaction-prompt="auto"
          interpolation-decay="100"
          >
          </model-viewer>
          <div class="sequence-viewer" id="sequenceViewer" hidden>
            <canvas aria-label="360度产品图片预览"></canvas>
            <div class="sequence-placeholder" aria-live="polite">
              <span class="sequence-spinner"></span>
              <strong id="sequenceLoadingTitle">正在准备 360° 图片</strong>
              <small id="sequenceLoadingProduct">载入产品帧序列…</small>
              <div class="sequence-loading-track"><i id="sequenceLoadingBar"></i></div>
              <small id="sequenceLoadingText">0 / 0 · 0%</small>
              <button class="sequence-retry" id="sequenceRetry" type="button" hidden>重新加载失败帧</button>
            </div>
          </div>
          <div class="frame-outline" aria-hidden="true"></div>
          <div class="frame-label" id="frameLabel">2048 × 2048 · 1:1</div>
          <div class="sequence-toolbar" id="sequenceToolbar" hidden>
            <button type="button" id="sequencePlay" aria-pressed="false"><span>▶</span> 自动旋转</button>
            <i></i>
            <span id="sequenceAngle">俯角 5°</span>
            <span id="sequenceFrame">1 / 21</span>
            <button type="button" id="sequenceReset">重置</button>
          </div>
        </div>
        <div class="viewer-error" id="viewerError" hidden>
          <strong>模型载入失败</strong>
          <span id="viewerErrorText">请选择其他模型，或确认模型文件完整。</span>
        </div>
        <div class="gesture-tip" id="gestureTip">左键旋转 · 滚轮/双指缩放 · 右键平移</div>
        <section class="model-library" id="modelLibrary" aria-label="模型库">
          <div class="library-header">
            <div><span class="eyebrow">MODEL LIBRARY</span><h2>选择要预览的模型</h2></div>
            <div class="library-header-actions">
              <button class="library-batch-button" id="sequenceBatchMode" type="button" hidden>批量选择</button>
              <button class="library-batch-button primary" id="sequenceBatchBuild" type="button" hidden>构建已选 (0)</button>
              <button class="library-close" id="closeLibrary" type="button" aria-label="关闭模型库">×</button>
            </div>
          </div>
          <nav class="breadcrumbs" id="breadcrumbs" aria-label="模型文件夹路径"></nav>
          <div class="library-grid" id="libraryGrid"></div>
          <div class="model-context-menu" id="modelContextMenu" hidden>
            <button type="button" id="generateThumbnail">自动生成缩略图</button>
            <button type="button" id="generateSequenceCache" hidden>构建缩略图缓存</button>
            <small id="contextMenuHint">固定 640 × 480 · 默认视角</small>
          </div>
        </section>
      </div>
    </section>

    <aside class="panel" aria-label="模型控制面板">
      <div id="modelPanel">
      <section class="panel-section export-section">
        <div class="section-heading"><span>01</span><h2>导出图片</h2></div>
        <div class="dimension-grid">
          <label>宽度 <span><input id="exportWidth" type="number" min="64" max="8192" value="2048"><em>px</em><button class="parameter-reset" id="resetExportWidth" type="button" aria-label="重置导出宽度" title="重置导出宽度">↶</button></span></label>
          <label>高度 <span><input id="exportHeight" type="number" min="64" max="8192" value="2048"><em>px</em><button class="parameter-reset" id="resetExportHeight" type="button" aria-label="重置导出高度" title="重置导出高度">↶</button></span></label>
        </div>
        <p class="export-capability" id="exportCapability" aria-live="polite"></p>
        <div class="presets" aria-label="常用分辨率">
          ${[[512,512],[1024,1024],[1920,1080],[2048,2048],[3840,2160],[4096,4096],[8192,8192]].map(([w,h]) => `<button type="button" data-size="${w}x${h}">${w} × ${h}</button>`).join('')}
        </div>
        <label class="select-row" for="exportQuality">
          <span><strong>导出质量</strong><small>高质量以 FXAA 平滑高对比边缘</small></span>
          <select id="exportQuality">
            <option value="standard"${state.exportQuality === ExportQualityMode.STANDARD ? ' selected' : ''}>标准</option>
            <option value="high"${state.exportQuality === ExportQualityMode.HIGH ? ' selected' : ''}>高质量（FXAA）</option>
          </select>
        </label>
        <label class="select-row" for="textureDetailMode">
          <span><strong>贴图锐度</strong><small>原图优先可保留斜面文字与细线</small></span>
          <select id="textureDetailMode">
            <option value="adaptive"${state.textureDetailMode === 'adaptive' ? ' selected' : ''}>自适应（更稳定）</option>
            <option value="base-level"${state.textureDetailMode === 'base-level' ? ' selected' : ''}>原图优先（更锐利）</option>
          </select>
        </label>
        <label class="switch-row">
          <span><strong>透明背景</strong><small>导出 PNG 时移除底色</small></span>
          <input id="transparentToggle" type="checkbox" role="switch"><i></i>
        </label>
        <label class="switch-row">
          <span><strong>保留阴影</strong><small>仅透明 PNG 可用，保留半透明地面阴影</small></span>
          <input id="preserveShadowToggle" type="checkbox" role="switch" disabled><i></i>
        </label>
        <button class="primary-button" id="exportButton" type="button" disabled>
          <span class="button-label">导出 PNG</span><span class="button-meta">2048 × 2048</span>
        </button>
        <p class="message" id="message" aria-live="polite"></p>
      </section>

      <section class="panel-section">
        <div class="section-heading"><span>02</span><h2>相机</h2></div>
        ${controlTemplate('水平旋转', 'theta', -180, 180, 1, '°')}
        ${controlTemplate('俯仰角', 'phi', 1, 179, 1, '°')}
        ${controlTemplate('相机距离', 'radius', 0.000001, 10, 0.001, 'm')}
        ${controlTemplate('垂直 FOV', 'fov', 10, 90, 1, '°')}
        ${controlTemplate('垂直镜头偏移', 'verticalShift', -50, 50, 1, '%')}
        <button class="secondary-button" id="buildingCorrection" type="button">建筑校正（相机水平）</button>
        <button class="secondary-button" id="resetCamera" type="button">重置视角</button>
      </section>

      <section class="panel-section">
        <div class="section-heading"><span>03</span><h2>画面</h2></div>
        <label class="color-row" for="backgroundColor">
          <span>背景颜色</span>
          <span class="color-control"><input id="backgroundColor" type="color" value="#e8eaed"><code id="colorValue">#E8EAED</code><button class="parameter-reset" id="resetBackground" type="button" aria-label="重置背景颜色" title="重置背景颜色">↶</button></span>
        </label>
      </section>

      ${studioPanelTemplate()}
      </div>
      <div class="sequence-panel" id="sequencePanel" hidden>
        <section class="panel-section">
          <div class="section-heading"><span>01</span><h2>保存图片</h2></div>
          <div class="sequence-current"><small>当前原始帧</small><strong id="sequenceFilename">尚未选择产品</strong><span id="sequenceResolution">3000 × 3000 PNG</span></div>
          <button class="primary-button" id="sequenceDownload" type="button" disabled><span class="button-label">保存原始 PNG</span><span class="button-meta" id="sequenceDownloadMeta">原图</span></button>
          <p class="message" id="sequenceMessage" aria-live="polite"></p>
        </section>
        <section class="panel-section">
          <div class="section-heading"><span>02</span><h2>观看控制</h2></div>
          <label class="switch-row">
            <span><strong>自动旋转</strong><small id="sequencePlaybackStatus">以每秒 8 帧播放一次</small></span>
            <input id="sequenceAutoToggle" type="checkbox" role="switch"><i></i>
          </label>
          <label class="switch-row">
            <span><strong>循环拖动</strong><small>开启后手动旋转首尾相接</small></span>
            <input id="sequenceLoopToggle" type="checkbox" role="switch"><i></i>
          </label>
          <label class="switch-row">
            <span><strong>左右反向</strong><small>反转水平拖动的旋转方向</small></span>
            <input id="sequenceReverseToggle" type="checkbox" role="switch"><i></i>
          </label>
          <div class="sequence-stat"><span>当前俯角</span><strong id="sequencePanelAngle">—</strong></div>
          <div class="sequence-stat"><span>缩放比例</span><strong id="sequenceScale">100%</strong></div>
          <button class="secondary-button" id="sequencePanelReset" type="button" disabled>重置观看角度</button>
        </section>
        <section class="panel-section">
          <div class="section-heading"><span>03</span><h2>产品信息</h2></div>
          <div class="sequence-product-info"><span>产品</span><strong id="sequenceProductName">—</strong></div>
          <div class="sequence-facts"><div><strong id="sequenceAngleCount">0</strong><small>俯角</small></div><div><strong id="sequenceTotalFrames">0</strong><small>总帧</small></div><div><strong id="sequenceLoadedFrames">0</strong><small>已载入</small></div></div>
          <div class="sequence-load-track"><i id="sequenceLoadBar"></i></div>
        </section>
      </div>
    </aside>
  </main>
  <div class="model-loading-overlay" id="modelLoadingOverlay" hidden aria-live="polite" aria-busy="true">
    <div class="model-loading-card">
      <span class="model-loading-spinner" aria-hidden="true"></span>
      <strong>正在加载模型</strong>
      <small id="modelLoadingText">请稍候…</small>
    </div>
  </div>
  <dialog class="sequence-build-dialog" id="sequenceBuildDialog">
    <form method="dialog">
      <div class="build-dialog-heading"><div><span class="eyebrow">SEQUENCE CACHE</span><h2>构建缩略图缓存</h2></div><button id="sequenceBuildClose" type="button" aria-label="关闭">×</button></div>
      <div id="sequenceBuildSetup">
        <div class="build-summary" id="sequenceBuildSummary"></div>
        <label class="build-size-label">目标最长边 <span><input id="sequenceBuildSize" type="number" min="64" max="8192" value="1600"><em>px</em></span></label>
        <div class="build-presets">${[512,1024,1600,2048].map((size) => `<button type="button" data-sequence-size="${size}">${size}</button>`).join('')}</div>
        <p class="build-note">保持原始比例、不裁切、不放大小图。重新构建会覆盖选中范围内的已有缓存。</p>
        <button class="primary-button" id="sequenceBuildStart" type="button"><span class="button-label">开始构建</span><span class="button-meta">WebP · 85%</span></button>
      </div>
      <div id="sequenceBuildProgress" hidden>
        <div class="build-progress-value"><strong id="sequenceBuildPercent">0%</strong><span id="sequenceBuildCounts">0 / 0</span></div>
        <div class="build-progress-track"><i id="sequenceBuildBar"></i></div>
        <p id="sequenceBuildCurrent">正在准备并行工作线程…</p>
        <div class="build-result"><span>成功 <strong id="sequenceBuildSuccess">0</strong></span><span>失败 <strong id="sequenceBuildFailed">0</strong></span></div>
      </div>
    </form>
  </dialog>
`;

function controlTemplate(label, id, min, max, step, unit) {
  const value = id === 'verticalShift' ? state[id] * 100 : state[id];
  return `<div class="control-row" data-control="${id}">
    <div class="control-label"><label for="${id}Range">${label}</label><span><input id="${id}Number" type="number" min="${min}" max="${max}" step="${step}" value="${value}"><em>${unit}</em><button class="parameter-reset" data-camera-reset="${id}" type="button" aria-label="重置${label}" title="重置${label}">↶</button></span></div>
    <input id="${id}Range" class="range" type="range" min="${min}" max="${max}" step="${step}" value="${value}">
  </div>`;
}

const viewer = document.querySelector('#modelViewer');
const shell = document.querySelector('#viewerShell');
const viewerFrame = document.querySelector('#viewerFrame');
const status = document.querySelector('#modelStatus');
const errorBox = document.querySelector('#viewerError');
const modelLoadingOverlay = document.querySelector('#modelLoadingOverlay');
const modelLoadingText = document.querySelector('#modelLoadingText');
const exportButton = document.querySelector('#exportButton');
const message = document.querySelector('#message');
const library = document.querySelector('#modelLibrary');
const libraryGrid = document.querySelector('#libraryGrid');
const breadcrumbs = document.querySelector('#breadcrumbs');
const contextMenu = document.querySelector('#modelContextMenu');
const generateThumbnailButton = document.querySelector('#generateThumbnail');
const generateSequenceCacheButton = document.querySelector('#generateSequenceCache');
const contextMenuHint = document.querySelector('#contextMenuHint');
const renderStudio = new RenderStudio(viewer, document.querySelector('#renderStudio'), { onMessage: showMessage });
const sequenceRoot = document.querySelector('#sequenceViewer');
const sequenceViewer = new SequenceViewer(sequenceRoot);
// Keep the fixed-position menu outside the filtered/clipped library overlay.
// Chromium otherwise treats the overlay as its containing block, while the
// pointer coordinates below are relative to the viewport.
document.body.append(contextMenu);
const cameraControls = [
  ...document.querySelectorAll('[data-control] input'),
  document.querySelector('#buildingCorrection'),
  document.querySelector('#resetCamera'),
];
const verticalShiftControls = [
  ...document.querySelectorAll('[data-control="verticalShift"] input'),
  document.querySelector('[data-camera-reset="verticalShift"]'),
  document.querySelector('#buildingCorrection'),
];
let contextModel = null;
let contextSequenceTarget = null;
let pendingSequenceBuildIds = [];
let sequenceJobPoll = 0;

function setCameraControlsDisabled(disabled) {
  for (const control of cameraControls) control.disabled = disabled;
}

function setVerticalShiftAvailable(available) {
  for (const control of verticalShiftControls) control.disabled = !available;
}

function applyLensProjection(target, framing) {
  return applyVerticalLensShift(target, framing.verticalShift);
}

function setStatus(text, type = '') {
  status.className = `status-pill ${type}`;
  status.innerHTML = `<span></span>${text}`;
}

function setModelLoading(loading, modelName = '') {
  modelLoadingOverlay.hidden = !loading;
  modelLoadingText.textContent = loading && modelName ? `正在载入“${modelName}”…` : '请稍候…';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function renderModelLibrary() {
  if (state.mode === 'sequence') {
    renderSequenceLibrary();
    return;
  }
  document.querySelector('.library-header .eyebrow').textContent = 'MODEL LIBRARY';
  document.querySelector('.library-header h2').textContent = '选择要预览的模型';
  library.setAttribute('aria-label', '模型库');
  document.querySelector('#sequenceBatchMode').hidden = true;
  document.querySelector('#sequenceBatchBuild').hidden = true;
  document.querySelector('#closeLibrary').disabled = !state.selectedModel;
  const entries = libraryEntries(state.currentFolder);
  const pathParts = state.currentFolder.split('/').filter(Boolean);
  breadcrumbs.innerHTML = [
    '<button type="button" data-folder="">全部模型</button>',
    ...pathParts.map((part, index) => {
      const path = pathParts.slice(0, index + 1).join('/');
      return `<span>/</span><button type="button" data-folder="${escapeHtml(path)}">${escapeHtml(part)}</button>`;
    }),
  ].join('');

  const folderCards = [
    ...(state.currentFolder ? [`<button class="library-card folder-card back-card" type="button" data-folder="${escapeHtml(parentFolder(state.currentFolder))}">
      <span class="folder-icon back" aria-hidden="true"></span><strong>返回上一级</strong><small>${escapeHtml(parentFolder(state.currentFolder) || '全部模型')}</small>
    </button>`] : []),
    ...entries.folders.map((folder) => {
    const path = state.currentFolder ? `${state.currentFolder}/${folder}` : folder;
    return `<button class="library-card folder-card" type="button" data-folder="${escapeHtml(path)}">
      <span class="folder-icon" aria-hidden="true"></span>
      <strong>${escapeHtml(folder)}</strong><small>打开文件夹</small>
    </button>`;
    }),
  ];
  const modelCard = (model) => {
    const generating = state.thumbnailGeneratingId === model.id;
    return `<button class="library-card model-card${state.selectedModel?.id === model.id ? ' selected' : ''}${generating ? ' generating' : ''}" type="button" data-model-id="${escapeHtml(model.id)}">
    <span class="thumbnail">${model.thumbnailUrl
      ? `<img src="${escapeHtml(model.thumbnailUrl)}" alt="" loading="lazy">`
      : '<span class="model-placeholder" aria-hidden="true">3D</span>'}</span>
    ${generating ? '<span class="thumbnail-busy">生成中…</span>' : ''}
    <strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.folderPath || 'models')}</small>
  </button>`;
  };
  const modelCards = entries.models.map(modelCard);
  const recentSection = !state.currentFolder && state.models.length
    ? `<section class="recent-models" aria-labelledby="recentModelsTitle">
        <div class="library-section-title"><h3 id="recentModelsTitle">最近更新</h3><span>最新添加的模型 · 最多 10 个</span></div>
        <div class="recent-grid">${recentModels(10).map(modelCard).join('')}</div>
      </section>
      <div class="library-section-title browse-title"><h3>浏览文件夹</h3><span>按目录查找全部模型</span></div>`
    : '';
  libraryGrid.innerHTML = recentSection + [...folderCards, ...modelCards].join('') ||
    '<div class="library-empty">这个文件夹中没有可预览的 GLB 模型。</div>';
}

function renderSequenceLibrary() {
  document.querySelector('.library-header .eyebrow').textContent = '360° PRODUCT LIBRARY';
  document.querySelector('.library-header h2').textContent = '选择要预览的360°产品';
  library.setAttribute('aria-label', '360度产品库');
  const batchMode = document.querySelector('#sequenceBatchMode');
  const batchBuild = document.querySelector('#sequenceBatchBuild');
  batchMode.hidden = false;
  batchMode.textContent = state.sequenceSelectionMode ? '退出批量' : '批量选择';
  batchMode.classList.toggle('active', state.sequenceSelectionMode);
  batchBuild.hidden = !state.sequenceSelectionMode;
  batchBuild.textContent = `构建已选 (${state.selectedSequenceIds.size})`;
  batchBuild.disabled = !state.selectedSequenceIds.size || !sequenceWritable || state.sequenceJobRunning;
  document.querySelector('#closeLibrary').disabled = !state.selectedSequence;
  const entries = sequenceLibraryEntries(state.sequenceFolder);
  const pathParts = state.sequenceFolder.split('/').filter(Boolean);
  breadcrumbs.innerHTML = [
    '<button type="button" data-sequence-folder="">全部产品</button>',
    ...pathParts.map((part, index) => {
      const path = pathParts.slice(0, index + 1).join('/');
      return `<span>/</span><button type="button" data-sequence-folder="${escapeHtml(path)}">${escapeHtml(part)}</button>`;
    }),
  ].join('');
  const folders = [
    ...(state.sequenceFolder ? [`<button class="library-card folder-card back-card" type="button" data-sequence-folder="${escapeHtml(sequenceParentFolder(state.sequenceFolder))}">
      <span class="folder-icon back" aria-hidden="true"></span><strong>返回上一级</strong><small>${escapeHtml(sequenceParentFolder(state.sequenceFolder) || '全部产品')}</small></button>`] : []),
    ...entries.folders.map((folder) => {
      const path = state.sequenceFolder ? `${state.sequenceFolder}/${folder}` : folder;
      return `<button class="library-card folder-card" type="button" data-sequence-folder="${escapeHtml(path)}" data-build-folder="${escapeHtml(path)}"><span class="folder-icon" aria-hidden="true"></span><strong>${escapeHtml(folder)}</strong><small>打开文件夹 · 右键构建</small></button>`;
    }),
  ];
  const cards = entries.products.map((product) => `<button class="library-card sequence-card cache-${product.cacheStatus}${state.selectedSequence?.id === product.id ? ' selected' : ''}${state.selectedSequenceIds.has(product.id) ? ' batch-selected' : ''}" type="button" data-sequence-id="${escapeHtml(product.id)}">
    <span class="thumbnail">${product.thumbnailUrl ? `<img src="${escapeHtml(product.thumbnailUrl)}" alt="" loading="lazy">` : '<span class="sequence-placeholder-icon" aria-hidden="true">360°</span>'}<b class="sequence-badge">${product.cacheStatus === 'ready' ? '360°' : '↓ 未构建'}</b>${state.sequenceSelectionMode ? `<span class="sequence-checkbox">${state.selectedSequenceIds.has(product.id) ? '✓' : ''}</span>` : ''}</span>
    <strong>${escapeHtml(product.name)}</strong><small>${product.angles.length} 个俯角 · ${product.totalFrames} 帧 · ${product.cacheStatus === 'ready' ? `${product.maxSize}px` : '需要构建'}</small>
  </button>`);
  libraryGrid.innerHTML = state.sequenceLibraryLoading
    ? '<div class="library-empty">正在扫描 image_sequence 并清理失效缓存…</div>'
    : [...folders, ...cards].join('') || '<div class="library-empty">image_sequence 中没有可用的帧序列产品。</div>';
}

function closeContextMenu() {
  contextModel = null;
  contextSequenceTarget = null;
  contextMenu.hidden = true;
}

function openContextMenu(event, model) {
  contextModel = model;
  contextSequenceTarget = null;
  generateThumbnailButton.hidden = false;
  generateSequenceCacheButton.hidden = true;
  generateThumbnailButton.disabled = !state.thumbnailCapabilityReady ||
    !state.thumbnailWritable || state.thumbnailGeneratingId !== null;
  generateThumbnailButton.textContent = state.thumbnailGeneratingId === model.id
    ? '正在生成缩略图…'
    : '自动生成缩略图';
  contextMenuHint.textContent = !state.thumbnailCapabilityReady
    ? '正在检查本机写入权限…'
    : state.thumbnailWritable
      ? '固定 640 × 480 · 默认视角 · 直接覆盖'
      : '当前设备只读；请在服务主机上操作';
  contextMenu.hidden = false;
  contextMenu.style.left = '0px';
  contextMenu.style.top = '0px';
  const { width, height } = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  contextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
}

function positionContextMenu(event) {
  contextMenu.hidden = false;
  contextMenu.style.left = '0px';
  contextMenu.style.top = '0px';
  const { width, height } = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  contextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
}

function openSequenceContextMenu(event, target) {
  contextModel = null;
  contextSequenceTarget = target;
  generateThumbnailButton.hidden = true;
  generateSequenceCacheButton.hidden = false;
  generateSequenceCacheButton.disabled = !sequenceWritable || state.sequenceJobRunning;
  generateSequenceCacheButton.textContent = target.type === 'folder' ? '递归构建此文件夹' : '构建此产品缓存';
  contextMenuHint.textContent = !sequenceWritable ? '当前设备只读；请在服务主机上操作' : '按目标最长边等比生成 · 直接覆盖';
  positionContextMenu(event);
}

async function reloadSequenceLibrary() {
  state.sequenceLibraryLoading = true;
  if (state.mode === 'sequence') renderSequenceLibrary();
  try {
    await refreshSequenceLibrary();
    if (sequenceWarnings.length) console.warn('[360°图片]', ...sequenceWarnings);
    if (state.selectedSequence) state.selectedSequence = sequenceProducts.find((item) => item.id === state.selectedSequence.id) ?? null;
    const availableIds = new Set(sequenceProducts.map((item) => item.id));
    state.selectedSequenceIds = new Set([...state.selectedSequenceIds].filter((id) => availableIds.has(id)));
  } catch (error) {
    console.error(error);
    setStatus('产品库扫描失败', 'error');
  } finally {
    state.sequenceLibraryLoading = false;
    if (state.mode === 'sequence') renderSequenceLibrary();
  }
}

function thumbnailErrorMessage(error) {
  if (error.message === 'MODEL_LOAD_FAILED' || error.message === 'MODEL_TIMEOUT') return '模型载入失败，无法生成缩略图。';
  if (['IMAGE_ENCODE_FAILED', 'IMAGE_SIZE_MISMATCH', 'RENDER_SIZE_MISMATCH', 'EMPTY_RENDER'].includes(error.code ?? error.message)) return '浏览器未能生成 640 × 480 WebP，请检查 WebGL 支持。';
  if (error.message === 'READ_ONLY_CLIENT' || error.status === 403) return '当前设备没有写入权限，请在服务主机上操作。';
  return '缩略图保存失败，请检查模型目录权限和服务日志。';
}

async function generateModelThumbnail(model) {
  if (!model || !state.thumbnailWritable || state.thumbnailGeneratingId !== null) return;
  state.thumbnailGeneratingId = model.id;
  closeContextMenu();
  renderModelLibrary();
  showMessage(`正在为 ${model.name} 生成 640 × 480 缩略图…`);
  try {
    const appearance = await resolveModelAppearance(model.id);
    if (appearance.usedBuiltinDefault) showMessage('项目默认光照读取失败，缩略图已使用内置默认光照。', 'error');
    const dataUrl = await createModelThumbnail(model.url, {
      ...appearance,
    }, state);
    const result = await saveModelThumbnail(model.id, dataUrl);
    model.thumbnailUrl = result.thumbnailUrl;
    showMessage(`已生成 ${result.filename}。`, 'success');
  } catch (error) {
    console.error(error);
    showMessage(thumbnailErrorMessage(error), 'error');
  } finally {
    state.thumbnailGeneratingId = null;
    renderModelLibrary();
  }
}

function openModelLibrary() {
  state.modelLibraryOpen = true;
  library.hidden = false;
  renderModelLibrary();
  if (state.mode === 'sequence') reloadSequenceLibrary();
}

function closeModelLibrary() {
  if (state.mode === 'model' ? !state.selectedModel : !state.selectedSequence) return;
  state.modelLibraryOpen = false;
  library.hidden = true;
}

function switchMode(mode) {
  if (!['model', 'sequence'].includes(mode) || state.mode === mode) return;
  state.mode = mode;
  shell.dataset.mode = mode;
  sequenceViewer.stop();
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelector('#modelPanel').hidden = mode !== 'model';
  document.querySelector('#sequencePanel').hidden = mode !== 'sequence';
  viewer.hidden = mode !== 'model';
  sequenceRoot.hidden = mode !== 'sequence';
  document.querySelector('#sequenceToolbar').hidden = mode !== 'sequence' || !state.selectedSequence;
  document.querySelector('#openLibrary').textContent = mode === 'model' ? '选择模型' : '选择产品';
  document.querySelector('#gestureTip').textContent = mode === 'model'
    ? '左键旋转 · 滚轮/双指缩放 · 右键平移'
    : '左右旋转 · 上下切换俯角 · 滚轮/双指缩放';
  document.querySelector('#frameLabel').textContent = mode === 'model' ? `${state.width} × ${state.height} · ${(state.width / state.height).toFixed(2)}:1` : '360° PRODUCT VIEW';
  if (mode === 'sequence') {
    setStatus(state.selectedSequence ? `正在载入 ${state.selectedSequence.name}` : '等待选择产品');
    if (!state.selectedSequence) openModelLibrary();
    else sequenceViewer.load(state.selectedSequence);
    requestAnimationFrame(() => sequenceViewer.resize());
    reloadSequenceLibrary();
  } else {
    setStatus(state.selectedModel?.name || '等待选择模型', state.loaded ? 'ready' : '');
    if (!state.selectedModel) openModelLibrary();
    sequenceViewer.unload();
  }
  renderModelLibrary();
}

async function selectSequence(product) {
  if (!product) return;
  if (state.sequenceSelectionMode) {
    if (state.selectedSequenceIds.has(product.id)) state.selectedSequenceIds.delete(product.id);
    else state.selectedSequenceIds.add(product.id);
    renderSequenceLibrary();
    return;
  }
  if (product.cacheStatus !== 'ready') {
    setStatus('缓存未构建', 'error');
    setSequenceMessage('请右键产品并构建缩略图缓存后再查看。', 'error');
    return;
  }
  state.selectedSequence = product;
  state.modelLibraryOpen = false;
  library.hidden = true;
  document.querySelector('#sequenceToolbar').hidden = false;
  document.querySelector('#sequenceDownload').disabled = true;
  document.querySelector('#sequencePanelReset').disabled = true;
  setStatus(`正在载入 ${product.name}`);
  setSequenceMessage('正在载入全部预览帧，完成后即可流畅旋转…');
  document.querySelector('#sequenceProductName').textContent = product.name;
  document.querySelector('#sequenceAngleCount').textContent = product.angles.length;
  document.querySelector('#sequenceTotalFrames').textContent = product.totalFrames;
  await sequenceViewer.load(product);
}

function selectedBuildProducts(ids) {
  const wanted = new Set(ids);
  return sequenceProducts.filter((product) => wanted.has(product.id));
}

function sourceResolutionSummary(products) {
  const resolutions = products.flatMap((product) => product.resolutions ?? []);
  if (!resolutions.length) return '无法读取';
  const unique = [...new Map(resolutions.map((item) => [`${item.width}×${item.height}`, item])).values()];
  if (unique.length === 1) return `${unique[0].width} × ${unique[0].height}`;
  const pixels = unique.map((item) => item.width * item.height);
  const smallest = unique[pixels.indexOf(Math.min(...pixels))];
  const largest = unique[pixels.indexOf(Math.max(...pixels))];
  return `${smallest.width} × ${smallest.height} — ${largest.width} × ${largest.height}（${unique.length} 种）`;
}

function openSequenceBuildDialog(ids) {
  const products = selectedBuildProducts([...new Set(ids)]);
  if (!products.length) return;
  pendingSequenceBuildIds = products.map((product) => product.id);
  const total = products.reduce((sum, product) => sum + product.totalFrames, 0);
  const overwrite = products.filter((product) => product.cacheStatus === 'ready').reduce((sum, product) => sum + product.totalFrames, 0);
  document.querySelector('#sequenceBuildSummary').innerHTML = `
    <div><small>产品</small><strong>${products.length}</strong></div>
    <div><small>总帧数</small><strong>${total}</strong></div>
    <div class="wide"><small>源分辨率</small><strong>${escapeHtml(sourceResolutionSummary(products))}</strong></div>
    <div class="wide"><small>缓存</small><strong>将覆盖 ${overwrite} 帧，构建 ${total} 帧</strong></div>`;
  document.querySelector('#sequenceBuildSetup').hidden = false;
  document.querySelector('#sequenceBuildProgress').hidden = true;
  document.querySelector('#sequenceBuildClose').disabled = false;
  document.querySelector('#sequenceBuildStart').disabled = !sequenceWritable;
  document.querySelector('#sequenceBuildDialog').showModal();
}

function updateSequenceJob(job) {
  const total = job.total || selectedBuildProducts(pendingSequenceBuildIds).reduce((sum, product) => sum + product.totalFrames, 0);
  const completed = job.completed || 0;
  const percent = total ? Math.round(completed / total * 100) : 0;
  document.querySelector('#sequenceBuildPercent').textContent = `${percent}%`;
  document.querySelector('#sequenceBuildCounts').textContent = `${completed} / ${total}`;
  document.querySelector('#sequenceBuildBar').style.width = `${percent}%`;
  document.querySelector('#sequenceBuildSuccess').textContent = job.succeeded || 0;
  document.querySelector('#sequenceBuildFailed').textContent = job.failed || 0;
  const done = ['completed', 'completed_with_errors', 'failed'].includes(job.status);
  document.querySelector('#sequenceBuildCurrent').textContent = done
    ? job.status === 'completed' ? '构建完成，产品库已刷新。' : `构建完成，${job.failed || 0} 帧失败。`
    : job.currentProduct ? `正在构建：${job.currentProduct}` : '正在准备并行工作线程…';
  if (done) document.querySelector('#sequenceBuildClose').disabled = false;
  return done;
}

async function pollSequenceJob() {
  clearTimeout(sequenceJobPoll);
  try {
    const response = await fetch('/__sequence/job', { cache: 'no-store' });
    const job = await response.json();
    if (updateSequenceJob(job)) {
      state.sequenceJobRunning = false;
      await reloadSequenceLibrary();
      return;
    }
  } catch (error) {
    console.error(error);
  }
  sequenceJobPoll = setTimeout(pollSequenceJob, 250);
}

async function startSequenceBuild() {
  const maxSize = Number(document.querySelector('#sequenceBuildSize').value);
  if (!Number.isInteger(maxSize) || maxSize < 64 || maxSize > 8192) {
    document.querySelector('#sequenceBuildSize').focus();
    return;
  }
  state.sequenceJobRunning = true;
  document.querySelector('#sequenceBuildSetup').hidden = true;
  document.querySelector('#sequenceBuildProgress').hidden = false;
  document.querySelector('#sequenceBuildClose').disabled = true;
  try {
    const response = await fetch('/__sequence/job', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: pendingSequenceBuildIds, maxSize }),
    });
    if (!response.ok) throw new Error((await response.json()).error || `BUILD_${response.status}`);
    await pollSequenceJob();
  } catch (error) {
    state.sequenceJobRunning = false;
    updateSequenceJob({ status: 'failed', failed: 0 });
    document.querySelector('#sequenceBuildCurrent').textContent = `无法开始构建：${error.message}`;
  }
}

function setSequenceMessage(text, type = '') {
  const element = document.querySelector('#sequenceMessage');
  element.textContent = text;
  element.className = `message ${type}`;
}

function updateSequenceUI(detail = sequenceViewer.snapshot()) {
  const frame = detail.frame;
  document.querySelector('#sequenceAngle').textContent = detail.angle === null ? '俯角 —' : `俯角 ${detail.angle}°`;
  document.querySelector('#sequencePanelAngle').textContent = detail.angle === null ? '—' : `${detail.angle}°`;
  document.querySelector('#sequenceFrame').textContent = detail.frameCount ? `${detail.framePosition} / ${detail.frameCount}` : '— / —';
  document.querySelector('#sequenceScale').textContent = `${Math.round(detail.scale * 100)}%`;
  document.querySelector('#sequenceFilename').textContent = frame?.originalFilename ?? '尚未选择产品';
  document.querySelector('#sequenceDownloadMeta').textContent = frame ? `帧 ${frame.index}` : '原图';
  document.querySelector('#sequenceLoadedFrames').textContent = detail.loaded;
  document.querySelector('#sequenceLoadBar').style.width = `${detail.total ? detail.loaded / detail.total * 100 : 0}%`;
  const progress = detail.total ? Math.round(detail.loaded / detail.total * 100) : 0;
  document.querySelector('#sequenceLoadingProduct').textContent = detail.product?.name || '载入产品帧序列…';
  document.querySelector('#sequenceLoadingText').textContent = `${detail.loaded} / ${detail.total} · ${progress}%`;
  document.querySelector('#sequenceLoadingBar').style.width = `${progress}%`;
  document.querySelector('#sequenceLoadingTitle').textContent = detail.failed
    ? `${detail.failed} 帧加载失败`
    : detail.ready ? '360° 图片已准备完成' : '正在准备 360° 图片';
  document.querySelector('#sequenceRetry').hidden = !detail.failed || detail.loading;
  document.querySelector('#sequenceDownload').disabled = !frame || !detail.ready;
  document.querySelector('#sequencePanelReset').disabled = !detail.ready;
  document.querySelector('#sequenceAutoToggle').checked = detail.playing;
  document.querySelector('#sequenceAutoToggle').disabled = !detail.ready;
  document.querySelector('#sequenceLoopToggle').checked = detail.loop;
  document.querySelector('#sequenceLoopToggle').disabled = !detail.product;
  document.querySelector('#sequenceReverseToggle').checked = detail.reverse;
  document.querySelector('#sequenceReverseToggle').disabled = !detail.product;
  document.querySelector('#sequencePlaybackStatus').textContent = detail.playbackComplete
    ? '已播放完成'
    : '以每秒 8 帧播放一次';
  const play = document.querySelector('#sequencePlay');
  play.disabled = !detail.ready;
  play.classList.toggle('active', detail.playing);
  play.setAttribute('aria-pressed', String(detail.playing));
  play.innerHTML = detail.playing ? '<span>Ⅱ</span> 暂停旋转' : detail.playbackComplete
    ? '<span>↻</span> 重新播放' : '<span>▶</span> 自动旋转';
}

async function downloadSequenceFrame() {
  const frame = sequenceViewer.frame;
  if (!frame) return;
  const button = document.querySelector('#sequenceDownload');
  button.disabled = true;
  button.querySelector('.button-label').textContent = '正在准备原图…';
  setSequenceMessage('正在读取 3000 × 3000 原始 PNG…');
  try {
    const response = await fetch(frame.originalUrl);
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = frame.originalFilename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSequenceMessage(`已保存原始帧 ${frame.index}。`, 'success');
  } catch (error) {
    console.error(error);
    setSequenceMessage('原始图片下载失败，请检查网络后重试。', 'error');
  } finally {
    button.disabled = !sequenceViewer.ready;
    button.querySelector('.button-label').textContent = '保存原始 PNG';
  }
}

async function resetModelRuntime() {
  state.loaded = false;
  state.renderQuality = {
    applied: false,
    compatibility: false,
    maximumAnisotropy: 1,
    actualRenderScale: 1,
  };
  radiusCapacity = null;
  defaultRadius = null;
  modelBounds = null;
  currentMinimumRadius = 0.000001;
  lastSafeRadius = 1;
  pendingZoomRadius = null;
  activeTouches.clear();
  pinchStart = null;
  cancelAnimationFrame(zoomFrame);
  cancelAnimationFrame(cameraSyncFrame);
  zoomFrame = 0;
  cameraApplySequence++;
  cameraSyncSequence++;
  resetTextureQuality(viewer);
  renderStudio.unloadModel();
  viewer.cameraTarget = 'auto auto auto';
  await applyViewerCameraFraming(viewer, { ...state, radius: 'auto' }, {
    applyProjection: applyLensProjection,
  });
  viewer.minCameraOrbit = 'auto 1deg 0.000001m';
  viewer.maxCameraOrbit = 'auto 179deg auto';
  setControl('theta', state.theta);
  setControl('phi', state.phi);
  setControl('radius', 1);
  setControl('fov', state.fov);
  setControl('verticalShift', state.verticalShift);
  document.querySelector('#radiusRange').min = 0.000001;
  document.querySelector('#radiusRange').max = 10;
  document.querySelector('#radiusNumber').min = 0.000001;
  setCameraControlsDisabled(true);
  exportButton.disabled = true;
}

async function cancelFixedSizeRender() {
  if (!activeExportTask) return;
  exportAbortController?.abort(new Error('MODEL_CHANGED'));
  await activeExportTask;
}

async function prepareLoadedModel(model) {
  state.loaded = true;
  await viewer.updateFraming();
  await applyViewerCameraFraming(viewer, { ...state, radius: 'auto' }, { immediate: true });
  modelBounds = createBounds(viewer.getBoundingBoxCenter(), viewer.getDimensions());
  const initialOrbit = viewer.getCameraOrbit();
  if (Number.isFinite(initialOrbit.radius) && initialOrbit.radius > 0) {
    initializeRadiusControl(initialOrbit.radius);
    lastSafeRadius = initialOrbit.radius;
    await updateMinimumRadius();
  }
  await applyCamera({ immediate: true });
  const shiftCapability = verticalLensShiftCapability(viewer);
  state.renderQuality = { ...state.renderQuality, ...applyMaximumTextureQuality(viewer) };
  await renderStudio.loadModel(model.id);
  setStatus(model.name, 'ready');
  setCameraControlsDisabled(false);
  setVerticalShiftAvailable(shiftCapability.available);
  exportButton.disabled = false;
  showMessage(!shiftCapability.available
    ? '垂直镜头偏移与建筑校正当前不可用；普通相机功能不受影响。'
    : !state.renderQuality.compatibility
    ? '当前浏览器已启用最佳通用纹理过滤；最大各向异性兼容层不可用。'
    : `已加载 ${model.name}；${state.renderQuality.maximumAnisotropy}× 各向异性。`,
  !shiftCapability.available || !state.renderQuality.compatibility ? 'error' : 'success');
  requestAnimationFrame(syncCameraFromViewer);
}

const modelLoading = new ModelLoadingModule({
  adapter: new ModelViewerLoadingAdapter(viewer),
  cancelFixedSizeRender,
  resetRuntime: resetModelRuntime,
  prepareModel: prepareLoadedModel,
});

async function selectModel(model) {
  if (!model) return;
  const task = modelLoading.select(model);
  const snapshot = modelLoading.getSnapshot();
  state.selectedModel = snapshot.model;
  state.modelLibraryOpen = false;
  library.hidden = true;
  errorBox.hidden = true;
  setModelLoading(true, model.name);
  setStatus(`正在载入 ${model.name}`);
  showMessage(`正在载入模型：${model.name}`);
  const result = await task;
  if (result.status === 'cancelled') return;
  setModelLoading(false);
  if (result.status === 'ready') {
    closeModelLibrary();
    return;
  }
  state.loaded = false;
  setStatus('载入失败', 'error');
  document.querySelector('#viewerErrorText').textContent = result.status === 'restore-failed'
    ? `“${model.name}”恢复查看器状态失败，请重新选择模型。`
    : `“${model.name}”载入失败，请选择其他模型或检查文件。`;
  errorBox.hidden = false;
  setCameraControlsDisabled(true);
  exportButton.disabled = true;
  showMessage(result.status === 'restore-failed' ? `模型“${model.name}”恢复失败。` : `模型“${model.name}”载入失败。`, 'error');
  openModelLibrary();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

function normalizeDegrees(rad) {
  let deg = rad * 180 / Math.PI;
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  return Math.round(deg * 10) / 10;
}

function roundDistance(value) {
  return Number(value.toPrecision(6));
}

function niceDistanceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function setControl(id, value) {
  if (id === 'radius') ensureRadiusCapacity(value);
  state[id] = value;
  const displayedValue = id === 'verticalShift' ? value * 100 : value;
  document.querySelector(`#${id}Range`).value = displayedValue;
  document.querySelector(`#${id}Number`).value = displayedValue;
  const range = document.querySelector(`#${id}Range`);
  const percentage = (displayedValue - Number(range.min)) / (Number(range.max) - Number(range.min)) * 100;
  range.style.setProperty('--range-progress', `${percentage}%`);
  if (state.loaded && ['theta', 'phi', 'fov', 'verticalShift'].includes(id)) {
    saveSharedCameraFraming(state);
  }
  updateCameraResetButtons();
}

function ensureRadiusCapacity(radius) {
  if (!state.loaded || !Number.isFinite(radius) ||
      (radiusCapacity !== null && radius <= radiusCapacity)) {
    return radiusCapacityUpdate;
  }
  radiusCapacity = niceDistanceCeiling(radius * 1.25);
  const radiusRange = document.querySelector('#radiusRange');
  radiusRange.max = radiusCapacity;
  viewer.maxCameraOrbit = `auto 179deg ${radiusCapacity}m`;
  radiusCapacityUpdate = viewer.updateComplete;
  return radiusCapacityUpdate;
}

function calculateMinimumRadius(theta = state.theta, phi = state.phi) {
  if (!state.loaded || !modelBounds) return currentMinimumRadius;
  return surfaceRadius({
    bounds: modelBounds,
    target: viewer.getCameraTarget(),
    theta,
    phi,
  });
}

function calculateSafeRadius(radius, theta = state.theta, phi = state.phi, previousRadius = lastSafeRadius) {
  if (!state.loaded || !modelBounds) {
    return { radius, minimumRadius: currentMinimumRadius, corrected: false };
  }
  return resolveSafeRadius({
    bounds: modelBounds,
    target: viewer.getCameraTarget(),
    theta,
    phi,
    radius,
    previousRadius,
  });
}

function updateMinimumRadius(theta = state.theta, phi = state.phi) {
  const minimum = calculateMinimumRadius(theta, phi);
  if (!Number.isFinite(minimum) || minimum <= 0) return minimumRadiusUpdate;
  currentMinimumRadius = minimum;
  const radiusRange = document.querySelector('#radiusRange');
  const radiusNumber = document.querySelector('#radiusNumber');
  radiusRange.min = minimum;
  radiusNumber.min = minimum;
  viewer.minCameraOrbit = `auto 1deg ${minimum}m`;
  minimumRadiusUpdate = viewer.updateComplete;
  return minimumRadiusUpdate;
}

function initializeRadiusControl(radius) {
  defaultRadius = radius;
  const radiusRange = document.querySelector('#radiusRange');
  const radiusNumber = document.querySelector('#radiusNumber');
  const step = Number(Math.max(radius / 1000, 0.000001).toPrecision(2));
  radiusCapacity = niceDistanceCeiling(radius * 10);
  radiusRange.max = radiusCapacity;
  radiusRange.step = step;
  radiusNumber.step = step;
  radiusNumber.disabled = false;
  radiusRange.disabled = false;
  viewer.maxCameraOrbit = `auto 179deg ${radiusCapacity}m`;
  radiusCapacityUpdate = viewer.updateComplete;
  setControl('radius', roundDistance(radius));
}

async function applyCamera({ immediate = false } = {}) {
  const sequence = ++cameraApplySequence;
  const safety = calculateSafeRadius(state.radius);
  if (safety.radius !== state.radius) setControl('radius', roundDistance(safety.radius));
  const minimum = safety.minimumRadius;
  await Promise.all([
    updateMinimumRadius(state.theta, state.phi),
    ensureRadiusCapacity(state.radius),
  ]);
  if (sequence !== cameraApplySequence) return;
  lastSafeRadius = state.radius;
  await applyViewerCameraFraming(viewer, state, {
    immediate,
    applyProjection: applyLensProjection,
  });
  if (sequence !== cameraApplySequence) return;
}

document.querySelector('#radiusNumber').removeAttribute('max');
document.querySelector('#radiusNumber').disabled = true;
document.querySelector('#radiusRange').disabled = true;

['theta', 'phi', 'radius', 'fov', 'verticalShift'].forEach((id) => {
  const range = document.querySelector(`#${id}Range`);
  const number = document.querySelector(`#${id}Number`);
  const update = (raw) => {
    const numericValue = Number(raw);
    if (!Number.isFinite(numericValue)) {
      setControl(id, state[id]);
      return;
    }
    const minimum = calculateMinimumRadius();
    let value = id === 'radius'
      ? Math.max(minimum, numericValue)
      : clamp(numericValue, Number(range.min), Number(range.max));
    if (id === 'verticalShift') value /= 100;
    if (id === 'fov' && value !== state.fov) {
      const resolved = resolveFovChange({
        radius: state.radius,
        fov: state.fov,
        requestedFov: value,
        minimumRadius: minimum,
      });
      const safety = calculateSafeRadius(resolved.radius, state.theta, state.phi, state.radius);
      setControl('radius', roundDistance(safety.radius));
      value = safety.corrected
        ? 2 * Math.atan(framingInvariant(state.radius, state.fov) / safety.radius) * 180 / Math.PI
        : resolved.fov;
      if (resolved.limited || safety.corrected) {
        showMessage('已到模型表面，FOV 已受限以保持物体大小。', 'error');
      } else if (message.textContent.includes('FOV 已受限')) {
        showMessage('已解除近距 FOV 限制。', 'success');
      }
    }
    setControl(id, value);
    applyCamera({ immediate: ['fov', 'verticalShift'].includes(id) });
  };
  range.addEventListener('input', (event) => update(event.target.value));
  number.addEventListener('change', (event) => update(event.target.value));
  number.addEventListener('blur', (event) => update(event.target.value));
  setControl(id, state[id]);
});
setCameraControlsDisabled(true);

viewer.addEventListener('render-scale', (event) => {
  const scale = Number(event.detail?.renderScale ?? event.detail?.scaleFactor ?? 1);
  state.renderQuality.actualRenderScale = Number.isFinite(scale) ? scale : 1;
  if (state.loaded && state.renderQuality.actualRenderScale < 0.999) {
    showMessage('设备正在降低预览渲染比例；导出仍会尝试使用完整目标分辨率。', 'error');
  }
});

let cameraSyncFrame;
viewer.addEventListener('camera-change', (event) => {
  // Programmatic interpolation reports transient values. Only direct user
  // interaction is allowed to replace the stable camera goal state.
  if (event.detail.source !== 'user-interaction') return;
  cancelAnimationFrame(cameraSyncFrame);
  cameraSyncFrame = requestAnimationFrame(syncCameraFromViewer);
});

async function syncCameraFromViewer() {
  if (!state.loaded || state.exporting) return;
  const sequence = ++cameraSyncSequence;
  const orbit = viewer.getCameraOrbit();
  const theta = normalizeDegrees(orbit.theta);
  const phi = Math.round(orbit.phi * 180 / Math.PI * 10) / 10;
  const safety = calculateSafeRadius(orbit.radius, theta, phi, lastSafeRadius);
  await updateMinimumRadius(theta, phi);
  if (sequence !== cameraSyncSequence) return;
  const safeRadius = Math.max(currentMinimumRadius, safety.radius);
  if (document.activeElement !== document.querySelector('#thetaNumber')) {
    setControl('theta', theta);
  }
  if (document.activeElement !== document.querySelector('#phiNumber')) {
    setControl('phi', phi);
  }
  if (Number.isFinite(orbit.radius)) {
    if (document.activeElement !== document.querySelector('#radiusNumber')) {
      setControl('radius', roundDistance(safeRadius));
    }
  }
  const actualFov = viewer.getFieldOfView();
  if (Number.isFinite(actualFov) && Math.abs(actualFov - state.fov) > 0.01) {
    await applyCamera({ immediate: true });
    if (sequence !== cameraSyncSequence) return;
  }
  lastSafeRadius = safeRadius;
  if (Math.abs(safeRadius - orbit.radius) > 1e-9) await applyCamera({ immediate: true });
}

let zoomFrame = 0;
let pendingZoomRadius = null;
let lastZoomInputAt = -Infinity;
const activeTouches = new Map();
let pinchStart = null;

function liveRadius() {
  const radius = viewer.getCameraOrbit().radius;
  return Number.isFinite(radius) && radius > 0 ? radius : state.radius;
}

function queueZoomRadius(radius) {
  if (!state.loaded || state.exporting || !Number.isFinite(radius) || radius <= 0) return;
  pendingZoomRadius = radius;
  if (zoomFrame) return;
  zoomFrame = requestAnimationFrame(() => {
    zoomFrame = 0;
    const nextRadius = pendingZoomRadius;
    pendingZoomRadius = null;
    const orbit = viewer.getCameraOrbit();
    const theta = normalizeDegrees(orbit.theta);
    const phi = orbit.phi * 180 / Math.PI;
    const safety = calculateSafeRadius(nextRadius, theta, phi, liveRadius());
    setControl('radius', roundDistance(safety.radius));
    applyCamera();
  });
}

function wheelZoom(event) {
  if (!state.loaded || state.exporting) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  queueRelativeZoom(event.deltaY, event.deltaMode);
}

function queueRelativeZoom(deltaY, deltaMode = 0) {
  const now = performance.now();
  const baseRadius = now - lastZoomInputAt > 150
    ? liveRadius()
    : pendingZoomRadius ?? state.radius;
  lastZoomInputAt = now;
  queueZoomRadius(zoomRadiusByWheel(baseRadius, deltaY, deltaMode));
}

function updateTouch(event) {
  if (event.pointerType !== 'touch') return;
  activeTouches.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
  if (activeTouches.size === 2 && pinchStart === null) {
    const [first, second] = activeTouches.values();
    pinchStart = {
      distance: pointerDistance(first, second),
      radius: liveRadius(),
    };
  }
}

viewer.addEventListener('wheel', wheelZoom, { capture: true, passive: false });
viewer.addEventListener('pointerdown', updateTouch, { capture: true });
viewer.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'touch' || !activeTouches.has(event.pointerId)) return;
  updateTouch(event);
  if (activeTouches.size !== 2 || pinchStart === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const [first, second] = activeTouches.values();
  const distance = pointerDistance(first, second);
  queueZoomRadius(zoomRadiusByPinch(pinchStart.radius, pinchStart.distance, distance));
}, { capture: true, passive: false });

function finishTouch(event) {
  if (event.pointerType !== 'touch') return;
  activeTouches.delete(event.pointerId);
  pinchStart = null;
}

viewer.addEventListener('pointerup', finishTouch, { capture: true });
viewer.addEventListener('pointercancel', finishTouch, { capture: true });
viewer.addEventListener('keydown', (event) => {
  if (!state.loaded || state.exporting || !['PageUp', 'PageDown'].includes(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const delta = event.key === 'PageUp' ? 120 : -120;
  queueRelativeZoom(delta);
}, { capture: true });

async function focusModel() {
  if (!state.loaded || state.exporting || state.mode !== 'model') return;
  viewer.cameraTarget = 'auto auto auto';
  await viewer.updateComplete;
  setControl('theta', 0);
  setControl('phi', 75);
  if (defaultRadius !== null) setControl('radius', roundDistance(defaultRadius));
  setControl('fov', 45);
  await applyCamera({ immediate: true });
  showMessage('已聚焦模型。', 'success');
}

window.addEventListener('keydown', (event) => {
  const target = event.target;
  const isTextEntry = target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable;
  if (isTextEntry || event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== 'f') return;
  if (!state.loaded || state.exporting || state.mode !== 'model') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  focusModel();
}, { capture: true });

document.querySelector('#resetCamera').addEventListener('click', async () => {
  viewer.cameraTarget = 'auto auto auto';
  await viewer.updateComplete;
  setControl('theta', 0);
  setControl('phi', 75);
  if (defaultRadius !== null) setControl('radius', roundDistance(defaultRadius));
  setControl('fov', 45);
  setControl('verticalShift', 0);
  await applyCamera({ immediate: true });
  showMessage('已恢复默认视角。', 'success');
});

document.querySelector('#buildingCorrection').addEventListener('click', async () => {
  const corrected = applyBuildingCorrection(state);
  setControl('phi', corrected.phi);
  await applyCamera({ immediate: true });
  showMessage('相机已保持水平，可用垂直镜头偏移调整建筑构图。', 'success');
});

function cameraDefaults() {
  return { theta: 0, phi: 75, radius: defaultRadius ?? state.radius, fov: 45, verticalShift: 0 };
}
for (const button of document.querySelectorAll('[data-camera-reset]')) {
  button.addEventListener('click', async () => {
    const id = button.dataset.cameraReset;
    setControl(id, cameraDefaults()[id]);
    await applyCamera({ immediate: true });
    updateCameraResetButtons();
  });
}
function updateCameraResetButtons() {
  const defaults = cameraDefaults();
  for (const button of document.querySelectorAll('[data-camera-reset]')) button.disabled = Number(state[button.dataset.cameraReset]) === Number(defaults[button.dataset.cameraReset]);
}

const colorInput = document.querySelector('#backgroundColor');
colorInput.addEventListener('input', () => {
  state.background = colorInput.value;
  document.querySelector('#colorValue').textContent = colorInput.value.toUpperCase();
  shell.style.setProperty('--viewer-background', colorInput.value);
  document.querySelector('#resetBackground').disabled = colorInput.value.toLowerCase() === '#e8eaed';
});
document.querySelector('#resetBackground').addEventListener('click', () => {
  colorInput.value = '#e8eaed';
  colorInput.dispatchEvent(new Event('input'));
});
document.querySelector('#resetBackground').disabled = true;

const preserveShadowToggle = document.querySelector('#preserveShadowToggle');
document.querySelector('#transparentToggle').addEventListener('change', (event) => {
  state.transparent = event.target.checked;
  preserveShadowToggle.disabled = !state.transparent;
});

preserveShadowToggle.addEventListener('change', (event) => {
  state.preserveShadow = event.target.checked;
});

document.querySelector('#exportQuality').addEventListener('change', (event) => {
  state.exportQuality = saveExportQuality(event.target.value);
  state.textureDetailMode = state.exportQuality === ExportQualityMode.HIGH ? 'base-level' : 'adaptive';
  document.querySelector('#textureDetailMode').value = state.textureDetailMode;
});

document.querySelector('#textureDetailMode').addEventListener('change', (event) => {
  state.textureDetailMode = event.target.value;
});

const widthInput = document.querySelector('#exportWidth');
const heightInput = document.querySelector('#exportHeight');
const exportCapability = readExportDimensionCapability();
const exportCapabilityMessage = document.querySelector('#exportCapability');
if (exportCapability.available) {
  state.maximumExportDimension = exportCapability.maximumDimension;
  widthInput.max = state.maximumExportDimension;
  heightInput.max = state.maximumExportDimension;
  exportCapabilityMessage.textContent = `设备 WebGL 单边上限：${state.maximumExportDimension}px（纹理 ${exportCapability.textureSize}px · 渲染缓冲 ${exportCapability.renderbufferSize}px）`;
} else {
  exportCapabilityMessage.textContent = '无法读取设备 WebGL 尺寸上限；导出将按当前浏览器能力尝试。';
}
function greatestCommonDivisor(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function updateFramingGuide() {
  const shellWidth = shell.clientWidth;
  const shellHeight = shell.clientHeight;
  if (!shellWidth || !shellHeight) return;
  const outputAspect = state.width / state.height;
  const shellAspect = shellWidth / shellHeight;
  const frameWidth = outputAspect >= shellAspect
    ? shellWidth
    : shellHeight * outputAspect;
  const frameHeight = outputAspect >= shellAspect
    ? shellWidth / outputAspect
    : shellHeight;
  viewerFrame.style.width = `${Math.max(1, frameWidth)}px`;
  viewerFrame.style.height = `${Math.max(1, frameHeight)}px`;
  const divisor = greatestCommonDivisor(state.width, state.height);
  document.querySelector('#frameLabel').textContent =
    `${state.width} × ${state.height} · ${state.width / divisor}:${state.height / divisor}`;
  shell.classList.toggle('extreme-frame', outputAspect > 4 || outputAspect < 0.25);
}

function updateDimensions({ commit = true } = {}) {
  const requestedWidth = Number(widthInput.value);
  const requestedHeight = Number(heightInput.value);
  if (!commit && (
    !Number.isFinite(requestedWidth) || requestedWidth < 64 || requestedWidth > state.maximumExportDimension ||
    !Number.isFinite(requestedHeight) || requestedHeight < 64 || requestedHeight > state.maximumExportDimension
  )) return;
  state.width = clamp(requestedWidth, 64, state.maximumExportDimension);
  state.height = clamp(requestedHeight, 64, state.maximumExportDimension);
  if (commit) {
    widthInput.value = state.width;
    heightInput.value = state.height;
  }
  exportButton.querySelector('.button-meta').textContent = `${state.width} × ${state.height}`;
  document.querySelectorAll('[data-size]').forEach((button) => {
    button.classList.toggle('active', button.dataset.size === `${state.width}x${state.height}`);
  });
  updateFramingGuide();
  document.querySelector('#resetExportWidth').disabled = state.width === 2048;
  document.querySelector('#resetExportHeight').disabled = state.height === 2048;
}

function applySupportedDrawingBufferSize({ width, height }) {
  widthInput.value = width;
  heightInput.value = height;
  updateDimensions();
}

[widthInput, heightInput].forEach((input) => {
  input.addEventListener('input', () => updateDimensions({ commit: false }));
  input.addEventListener('change', () => updateDimensions());
});
document.querySelectorAll('[data-size]').forEach((button) => button.addEventListener('click', () => {
  const [width, height] = button.dataset.size.split('x');
  widthInput.value = width;
  heightInput.value = height;
  updateDimensions();
}));
document.querySelector('#resetExportWidth').addEventListener('click', () => { widthInput.value = 2048; updateDimensions(); });
document.querySelector('#resetExportHeight').addEventListener('click', () => { heightInput.value = 2048; updateDimensions(); });
updateDimensions();
new ResizeObserver(updateFramingGuide).observe(shell);

function showMessage(text, type = '') {
  message.textContent = text;
  message.className = `message ${type}`;
}

let activeExportTask = null;
let exportAbortController = null;

function exportImage() {
  if (!state.loaded || state.exporting) return activeExportTask;
  exportAbortController = new AbortController();
  activeExportTask = performExportImage(exportAbortController.signal).finally(() => {
    activeExportTask = null;
    exportAbortController = null;
  });
  activeExportTask.catch(() => {});
  return activeExportTask;
}

async function performExportImage(signal) {
  if (!state.loaded || state.exporting) return;
  updateDimensions();
  state.exporting = true;
  shell.classList.add('exporting');
  exportButton.disabled = true;
  exportButton.classList.add('busy');
  exportButton.querySelector('.button-label').textContent = '正在渲染…';
  const useFxaa = state.exportQuality === ExportQualityMode.HIGH;
  const scaleLabel = useFxaa ? 'FXAA 抗锯齿' : '标准采样';
  showMessage(`${state.width} × ${state.height} 图片生成中（${scaleLabel}），请稍候…`);

  try {
    const rendered = await renderFixedSizeImage(viewer, {
      width: state.width,
      height: state.height,
      background: state.transparent ? 'transparent' : state.background,
      hideEnvironment: true,
      transparent: state.transparent,
      preserveShadow: state.preserveShadow,
      textureDetailMode: state.textureDetailMode,
      cameraFraming: state,
      signal,
    });
    const detailLabel = rendered.textureDetail.applied
      ? `原图优先（${rendered.textureDetail.textureCount} 张纹理，${state.renderQuality.maximumAnisotropy}× 各向异性）`
      : `自适应 mipmap（${state.renderQuality.maximumAnisotropy}× 各向异性）`;
    const blob = await finalizePngExport(rendered.blob, {
      ...state,
      width: state.width,
      height: state.height,
      antiAlias: useFxaa ? 'fxaa' : 'none',
    });
    const dimensions = await readImageDimensions(blob);
    if (dimensions.width !== state.width || dimensions.height !== state.height) {
      throw new Error(`SIZE_MISMATCH:${dimensions.width}x${dimensions.height}`);
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    const safeModelName = (state.selectedModel?.name || 'model')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/[. ]+$/g, '') || 'model';
    link.download = `${safeModelName}_${state.width}x${state.height}_${stamp}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage(`已导出 ${state.width} × ${state.height} PNG；${scaleLabel}，${detailLabel}。`, 'success');
  } catch (error) {
    console.error(error);
    const code = error?.code ?? error?.message;
    const mismatch = code === 'RENDER_SIZE_MISMATCH' || String(error?.message).startsWith('SIZE_MISMATCH');
    const detailUnavailable = code === 'TEXTURE_DETAIL_UNAVAILABLE';
    const drawingBufferTooSmall = code === 'RENDER_BUFFER_TOO_SMALL';
    if (code === 'RENDER_ABORTED') return;
    if (drawingBufferTooSmall) applySupportedDrawingBufferSize(error.details);
    showMessage(detailUnavailable
      ? '当前浏览器无法启用原图优先，请选择“自适应（更稳定）”后重试。'
      : drawingBufferTooSmall
        ? `浏览器实际只能绘制 ${state.width} × ${state.height}；已自动填入该尺寸，未生成裁剪图。请再次点击导出。`
      : mismatch
        ? '浏览器未能生成精确尺寸，请将系统显示缩放设为 100% 后重试。'
        : '导出失败。此分辨率可能超过当前设备的 WebGL 或显存上限，请降低尺寸后重试。', 'error');
    if (hasRenderRestorationFailure(error)) throw error;
  } finally {
    state.exporting = false;
    shell.classList.remove('exporting');
    exportButton.disabled = false;
    exportButton.classList.remove('busy');
    exportButton.querySelector('.button-label').textContent = '导出 PNG';
  }
}

async function readImageDimensions(blob) {
  const bitmap = await createImageBitmap(blob);
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dimensions;
}

exportButton.addEventListener('click', exportImage);

document.querySelector('#openLibrary').addEventListener('click', openModelLibrary);
document.querySelector('#closeLibrary').addEventListener('click', closeModelLibrary);
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => switchMode(button.dataset.mode)));
library.addEventListener('click', (event) => {
  const sequenceFolderButton = event.target.closest('[data-sequence-folder]');
  if (sequenceFolderButton) {
    state.sequenceFolder = sequenceFolderButton.dataset.sequenceFolder;
    state.selectedSequenceIds.clear();
    renderModelLibrary();
    return;
  }
  const sequenceButton = event.target.closest('[data-sequence-id]');
  if (sequenceButton) {
    selectSequence(sequenceProducts.find((product) => product.id === sequenceButton.dataset.sequenceId));
    return;
  }
  const folderButton = event.target.closest('[data-folder]');
  if (folderButton) {
    state.currentFolder = folderButton.dataset.folder;
    renderModelLibrary();
    return;
  }
  const modelButton = event.target.closest('[data-model-id]');
  if (modelButton) selectModel(state.models.find((model) => model.id === modelButton.dataset.modelId));
});
library.addEventListener('contextmenu', (event) => {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  const sequenceCard = event.target.closest('[data-sequence-id]');
  const sequenceFolder = event.target.closest('[data-build-folder]');
  if (state.mode === 'sequence' && (sequenceCard || sequenceFolder)) {
    event.preventDefault();
    if (sequenceCard) openSequenceContextMenu(event, { type: 'product', id: sequenceCard.dataset.sequenceId });
    else openSequenceContextMenu(event, { type: 'folder', id: sequenceFolder.dataset.buildFolder });
    return;
  }
  const modelCard = event.target.closest('[data-model-id]');
  if (!modelCard) return;
  event.preventDefault();
  const model = state.models.find((item) => item.id === modelCard.dataset.modelId);
  if (model) openContextMenu(event, model);
});
generateThumbnailButton.addEventListener('click', () => generateModelThumbnail(contextModel));
generateSequenceCacheButton.addEventListener('click', () => {
  if (!contextSequenceTarget) return;
  const ids = contextSequenceTarget.type === 'product' ? [contextSequenceTarget.id]
    : sequenceProducts.filter((product) => product.id.startsWith(`${contextSequenceTarget.id}/`)).map((product) => product.id);
  closeContextMenu();
  openSequenceBuildDialog(ids);
});
document.querySelector('#sequenceBatchMode').addEventListener('click', () => {
  state.sequenceSelectionMode = !state.sequenceSelectionMode;
  state.selectedSequenceIds.clear();
  renderSequenceLibrary();
});
document.querySelector('#sequenceBatchBuild').addEventListener('click', () => openSequenceBuildDialog([...state.selectedSequenceIds]));
document.querySelectorAll('[data-sequence-size]').forEach((button) => button.addEventListener('click', () => {
  document.querySelector('#sequenceBuildSize').value = button.dataset.sequenceSize;
}));
document.querySelector('#sequenceBuildStart').addEventListener('click', startSequenceBuild);
document.querySelector('#sequenceBuildClose').addEventListener('click', () => {
  if (!state.sequenceJobRunning) document.querySelector('#sequenceBuildDialog').close();
});
document.querySelector('#sequenceBuildDialog').addEventListener('cancel', (event) => {
  if (state.sequenceJobRunning) event.preventDefault();
});
document.addEventListener('click', (event) => {
  if (!contextMenu.hidden && !contextMenu.contains(event.target)) closeContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeContextMenu();
});
libraryGrid.addEventListener('scroll', closeContextMenu, { passive: true });

sequenceViewer.addEventListener('change', (event) => updateSequenceUI(event.detail));
sequenceViewer.addEventListener('progress', (event) => updateSequenceUI(event.detail));
sequenceViewer.addEventListener('playchange', (event) => updateSequenceUI(event.detail));
sequenceViewer.addEventListener('loopchange', (event) => updateSequenceUI(event.detail));
sequenceViewer.addEventListener('reversechange', (event) => updateSequenceUI(event.detail));
sequenceViewer.addEventListener('playcomplete', (event) => {
  updateSequenceUI(event.detail);
  setSequenceMessage('本轮旋转已播放完成。', 'success');
});
sequenceViewer.addEventListener('ready', (event) => {
  updateSequenceUI(event.detail);
  setStatus(state.selectedSequence.name, 'ready');
  setSequenceMessage('全部预览帧已载入，可以流畅旋转查看。', 'success');
});
sequenceViewer.addEventListener('frameerror', (event) => {
  updateSequenceUI(event.detail);
  setSequenceMessage('有预览帧载入失败，完成检查后可以重新加载。', 'error');
});
sequenceViewer.addEventListener('loaderror', (event) => {
  updateSequenceUI(event.detail);
  setStatus(`${event.detail.failed} 帧载入失败`, 'error');
  setSequenceMessage('部分预览帧未能载入，请点击“重新加载失败帧”。原始 PNG 未受影响。', 'error');
});
sequenceViewer.addEventListener('viewererror', () => {
  setStatus('载入失败', 'error');
  setSequenceMessage('产品帧序列为空，请重新选择或检查图片。', 'error');
});
document.querySelector('#sequencePlay').addEventListener('click', () => sequenceViewer.setPlaying(!sequenceViewer.playing));
document.querySelector('#sequenceAutoToggle').addEventListener('change', (event) => sequenceViewer.setPlaying(event.target.checked));
document.querySelector('#sequenceLoopToggle').addEventListener('change', (event) => sequenceViewer.setLoop(event.target.checked));
document.querySelector('#sequenceReverseToggle').addEventListener('change', (event) => sequenceViewer.setReverse(event.target.checked));
document.querySelector('#sequenceRetry').addEventListener('click', () => {
  setStatus(`正在重试 ${state.selectedSequence?.name || '产品'}`);
  setSequenceMessage('正在重新加载失败帧…');
  sequenceViewer.retryFailed();
});
document.querySelector('#sequenceReset').addEventListener('click', () => sequenceViewer.reset());
document.querySelector('#sequencePanelReset').addEventListener('click', () => sequenceViewer.reset());
document.querySelector('#sequenceDownload').addEventListener('click', downloadSequenceFrame);

renderModelLibrary();
Promise.all(state.models.map(async (model) => {
  const thumbnailUrl = await loadSavedModelThumbnail(model.id);
  if (thumbnailUrl) model.thumbnailUrl = thumbnailUrl;
})).then(() => renderModelLibrary());
if (state.models.length === 0) {
  setStatus('没有可用模型', 'error');
  libraryGrid.innerHTML = '<div class="library-empty">models 文件夹中没有找到 GLB 文件。</div>';
}
thumbnailCapability().then((writable) => {
  state.thumbnailWritable = writable;
  state.thumbnailCapabilityReady = true;
});
