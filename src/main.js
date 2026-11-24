import '@google/model-viewer';
import '@google/model-viewer-effects';
import './style.css';
import './export-panel.css';
import './render-studio-panel.css';
import './sequence-background.css';
import { folderThumbnailUrl, libraryEntries, models, parentFolder, recentModels } from './model-library.js';
import { filterLibraryItems } from './library-search.js';
import { modelsInFolder, runThumbnailBatch } from './model-thumbnail-batch.js';
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
  refreshSequenceLibrary,
} from './sequence-library.js';
import { SequenceViewer } from './sequence-viewer.js';
import { SequenceBackground, sequenceBackgroundPanel, sequenceGradientOverlay } from './sequence-background.js';
import { finalizePngExport } from './png-export.js';
import {
  ExportQualityMode,
} from './export-quality.js';
import { ExportOptions } from './export-options.js';
import { hasRenderRestorationFailure, renderFixedSizeImage } from './fixed-size-render.js';
import { ModelLoadingModule } from './model-loading.js';
import { ModelViewerLoadingAdapter } from './model-viewer-loading-adapter.js';
import { APPEARANCE_ORIGINAL_VALUE, AppearanceVariantSelector, appearanceOptionMeta, appearanceOptions } from './appearance-variants.js';
import { readExportDimensionCapability } from './webgl-capabilities.js';
import { DEFAULT_SHARED_CAMERA_FRAMING, loadSharedCameraFraming, saveSharedCameraFraming } from './shared-camera-framing.js';
import { applyBuildingCorrection, applyViewerCameraFraming } from './camera-framing-application.js';
import { applyVerticalLensShift, verticalLensShiftCapability } from './vertical-lens-shift.js';

// High-resolution exports must not be dynamically downscaled by model-viewer.
customElements.get('model-viewer').minimumRenderScale = 1;

const sharedCameraFraming = loadSharedCameraFraming();
const exportOptions = new ExportOptions();

const state = {
  theta: sharedCameraFraming.theta,
  phi: sharedCameraFraming.phi,
  radius: 1,
  fov: sharedCameraFraming.fov,
  verticalShift: sharedCameraFraming.verticalShift,
  buildingCorrection: sharedCameraFraming.buildingCorrection,
  ...exportOptions.getSnapshot(),
  maximumExportDimension: exportOptions.maximumDimension,
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
  selectedModelIds: new Set(),
  thumbnailBatchRunning: false,
  thumbnailBatchStopRequested: false,
  mode: 'model',
  sequenceFolder: '',
  selectedSequence: null,
  sequenceLibraryLoading: false,
  libraryQuery: '',
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

const settingsCategoryIcons = Object.freeze({
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h4l1.4-2h5.2l1.4 2H20v11H4z"/><circle cx="12" cy="13" r="3.2"/><path d="M7.2 10h.01"/></svg>',
  post: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.3"/><path d="M12 4.7v3.1m0 8.4v3.1M4.7 12h3.1m8.4 0h3.1M7 7l2.2 2.2m5.6 5.6L17 17"/></svg>',
  lighting: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.4"/><path d="M12 2.8v3m0 12.4v3M2.8 12h3m12.4 0h3M5.5 5.5l2.1 2.1m8.8 8.8 2.1 2.1m0-13-2.1 2.1m-8.8 8.8-2.1 2.1"/></svg>',
  material: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 7.2 4.1v9.8L12 21l-7.2-4.1V7.1z"/><path d="m4.8 7.1 7.2 4.1 7.2-4.1M12 11.2V21"/></svg>',
});
const settingsCategoryButton = (id, label) => `<button class="settings-category-button" id="settings-toggle-${id}" type="button" data-settings-toggle="${id}" aria-controls="settings-category-${id}" aria-expanded="${id === 'camera'}">${settingsCategoryIcons[id]}<span>${label}</span></button>`;
const parameterResetIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.4 7.2A6 6 0 1 1 4 12.9M4.4 7.2V3.8m0 3.4h3.4"/></svg>';

document.querySelector('#app').innerHTML = `
  <main class="workspace" data-preview-mode="model">
    <section class="stage" aria-label="预览与资源库">
      <header class="stage-header">
        <h1>模型取景台</h1>
        <div class="stage-actions">
          <div class="mode-switch" role="group" aria-label="预览模式">
            <button type="button" class="active" data-mode="model" aria-pressed="true">3D 模型</button>
            <button type="button" data-mode="sequence" aria-pressed="false">360° 图片</button>
          </div>
          <button class="library-button" id="openLibrary" type="button">选择模型</button>
          <button class="theme-toggle" id="themeToggle" type="button" aria-pressed="false" title="切换明暗主题"><span aria-hidden="true">☼</span><span>浅色</span></button>
          <div class="status-pill" id="modelStatus"><span></span>等待选择模型</div>
        </div>
      </header>

      <p class="message stage-message" id="message" role="status"></p>
      <div class="viewer-shell" id="viewerShell" data-mode="model">
        <div class="viewer-frame" id="viewerFrame">
          <model-viewer
          id="modelViewer"
          alt="三维模型预览"
          camera-controls
          disable-tap
          touch-action="pan-y"
          camera-orbit="0deg 75deg 105%"
          field-of-view="${DEFAULT_SHARED_CAMERA_FRAMING.fov}deg"
          min-field-of-view="10deg"
          max-field-of-view="90deg"
          min-camera-orbit="auto 1deg 0.000001m"
          max-camera-orbit="auto 179deg auto"
          shadow-intensity="0.75"
          shadow-softness="0.9"
          environment-image="neutral"
          tone-mapping="neutral"
          interaction-prompt="none"
          interpolation-decay="100"
          >
            <effect-composer render-mode="quality">
              <ssao-effect strength="1.5"></ssao-effect>
              <smaa-effect quality="ultra"></smaa-effect>
              <color-grade-effect tonemapping="neutral"></color-grade-effect>
            </effect-composer>
          </model-viewer>
          <div class="sequence-viewer" id="sequenceViewer" hidden>
            <canvas aria-label="360度产品图片预览"></canvas>
            <div class="sequence-placeholder" aria-live="polite">
              <span class="sequence-spinner" id="sequenceSpinner" aria-hidden="true" hidden></span>
              <strong id="sequenceLoadingTitle">请选择 360° 产品</strong>
              <small id="sequenceLoadingProduct" hidden></small>
              <button class="sequence-retry" id="sequenceRetry" type="button" hidden>重新加载</button>
            </div>
            <div class="sequence-frame-status" id="sequenceFrameStatus" hidden>
              <span id="sequenceFrameStatusText" role="status"></span>
              <button id="sequenceRetryFrame" type="button" hidden>重试</button>
            </div>
          </div>
          ${sequenceGradientOverlay()}
          <div class="frame-outline" aria-hidden="true"></div>
          <div class="sequence-toolbar" id="sequenceToolbar" hidden>
            <button type="button" id="sequencePlay" aria-pressed="false"><span>▶</span> 播放旋转</button>
            <i></i>
            <span id="sequenceAngle">俯角 —</span>
            <span id="sequenceFrame">— / —</span>
            <button type="button" id="sequenceReset" aria-label="重置观看角度">重置</button>
          </div>
        </div>
        <div class="frame-label" id="frameLabel">4096 × 4096 · 1:1</div>
        <div class="viewer-error" id="viewerError" hidden>
          <strong>模型载入失败</strong>
          <span id="viewerErrorText">请选择其他模型，或确认模型文件完整。</span>
        </div>
        <div class="gesture-tip sequence-gesture-tip">左右循环旋转 · 上下切换俯角 · 滚轮/双指缩放</div>
        <section class="model-library" id="modelLibrary" aria-label="模型库">
          <div class="library-tools">
            <label class="library-search" for="librarySearch">
              <span aria-hidden="true">⌕</span>
              <input id="librarySearch" type="search" aria-label="搜索模型或文件夹" placeholder="搜索模型名称或文件夹" autocomplete="off">
              <button id="clearLibrarySearch" type="button" aria-label="清空搜索" hidden>×</button>
            </label>
            <span class="library-count" id="libraryCount" aria-live="polite"></span>
            <span class="library-selection-hint" id="librarySelectionHint" hidden>拖动空白区域即可框选</span>
          </div>
          <nav class="breadcrumbs" id="breadcrumbs" aria-label="模型文件夹路径"></nav>
          <div class="library-grid" id="libraryGrid"></div>
          <div class="model-context-menu" id="modelContextMenu" hidden>
            <button type="button" id="generateThumbnail">自动生成缩略图</button>
            <small id="contextMenuHint">固定 640 × 480 · 默认视角</small>
          </div>
        </section>
      </div>
      <p class="model-gesture-tip" id="gestureTip">
        <span class="mouse-gesture-copy">左键拖动旋转 · 滚轮缩放 · 右键拖动平移</span>
        <span class="touch-gesture-copy">单指拖动旋转 · 双指捏合缩放</span>
      </p>
    </section>

    <aside class="panel" aria-label="预览与图片设置">
      <div class="model-panel" id="modelPanel">
        <details class="panel-section export-section" id="exportSettings">
          <summary class="export-heading" id="exportHeading">导出设置</summary>
          <div class="resolution-controls" role="group" aria-label="分辨率与比例">
            <div class="resolution-select-grid">
              <label class="select-row compact-select-row" for="resolutionPreset">
                <strong>分辨率</strong>
                <select id="resolutionPreset">
                  <option value="1024">1K</option>
                  <option value="2048">2K</option>
                  <option value="3072">3K</option>
                  <option value="4096" selected>4K</option>
                  <option value="custom">自定义</option>
                </select>
              </label>
              <label class="select-row compact-select-row" for="resolutionAspect">
                <strong>比例</strong>
                <select id="resolutionAspect">
                  <option value="1:1" selected>1 : 1</option>
                  <option value="4:3">4 : 3</option>
                  <option value="3:2">3 : 2</option>
                  <option value="16:9">16 : 9</option>
                  <option value="9:16">9 : 16</option>
                  <option value="21:9">21 : 9</option>
                  <option value="custom" hidden disabled>跟随宽高</option>
                </select>
              </label>
            </div>
            <div class="export-custom-dimensions" hidden>
              <div class="dimension-grid">
                <div class="export-dimension"><label for="exportWidth">宽度（px）</label><span><input id="exportWidth" type="number" min="64" max="8192" step="1" value="4096" aria-describedby="exportSizeRange exportDimensionFeedback"><button class="parameter-reset" id="resetExportWidth" type="button" aria-label="重置导出宽度" title="重置导出宽度">${parameterResetIcon}</button></span></div>
                <div class="export-dimension"><label for="exportHeight">高度（px）</label><span><input id="exportHeight" type="number" min="64" max="8192" step="1" value="4096" aria-describedby="exportSizeRange exportDimensionFeedback"><button class="parameter-reset" id="resetExportHeight" type="button" aria-label="重置导出高度" title="重置导出高度">${parameterResetIcon}</button></span></div>
              </div>
              <p class="export-help" id="exportSizeRange"></p>
            </div>
            <p class="export-dimension-feedback" id="exportDimensionFeedback" role="status"></p>
          </div>
          <div class="export-background-controls">
            <div class="switch-row">
              <strong><label for="transparentToggle">透明背景</label></strong>
              <label class="switch-control"><input id="transparentToggle" type="checkbox" role="switch" aria-label="透明背景"><i></i></label>
            </div>
            <div class="switch-row" hidden>
              <strong><label for="preserveShadowToggle">保留地面阴影</label></strong>
              <label class="switch-control"><input id="preserveShadowToggle" type="checkbox" role="switch" aria-label="保留地面阴影" disabled><i></i></label>
            </div>
            <div class="color-row" id="exportBackgroundRow">
              <label for="backgroundColor">背景颜色</label>
              <span class="color-control"><input id="backgroundColor" type="color" value="#e8eaed"><code id="colorValue">#E8EAED</code><button class="parameter-reset" id="resetBackground" type="button" aria-label="重置背景颜色" title="重置背景颜色">${parameterResetIcon}</button></span>
            </div>
          </div>
          <p class="export-help export-background-help" id="exportBackgroundHelp" hidden>关闭透明背景可设置 PNG 的实色背景。</p>
          <details class="export-advanced" id="exportAdvanced">
            <summary><span>质量与设备信息</span><span id="exportQualitySummary"></span></summary>
            <label class="select-row" for="exportQuality">
              <strong>导出质量</strong>
              <select id="exportQuality" aria-describedby="exportQualityHelp">
                <option value="standard"${state.exportQuality === ExportQualityMode.STANDARD ? ' selected' : ''}>标准</option>
                <option value="high"${state.exportQuality === ExportQualityMode.HIGH ? ' selected' : ''}>高质量</option>
              </select>
            </label>
            <p class="export-help" id="exportQualityHelp">实色 PNG 可用高质量档平滑高对比边缘。透明 PNG 固定使用标准采样。切换档位会更新贴图锐度，锐度也可单独调整。</p>
            <label class="select-row" for="textureDetailMode">
              <strong>贴图锐度</strong>
              <select id="textureDetailMode" aria-describedby="textureDetailHelp">
                <option value="adaptive"${state.textureDetailMode === 'adaptive' ? ' selected' : ''}>自适应（更稳定）</option>
                <option value="base-level"${state.textureDetailMode === 'base-level' ? ' selected' : ''}>原图优先（更锐利）</option>
              </select>
            </label>
            <p class="export-help" id="textureDetailHelp">原图优先可保留斜面文字和细线，也可能增加摩尔纹。</p>
            <p class="export-help export-capability" id="exportCapability"></p>
          </details>
        </details>
        <nav class="settings-category-navigation" aria-label="模型参数">
          ${settingsCategoryButton('camera', '相机')}
          ${settingsCategoryButton('post', '后处理')}
          ${settingsCategoryButton('lighting', '灯光')}
          ${settingsCategoryButton('material', '材质')}
        </nav>
        <div class="model-panel-scroll">
          <div class="model-parameters">
            <p class="model-panel-empty" id="modelPanelEmpty" hidden>选择上方的参数类别。</p>
            <section class="settings-category-panel" id="settings-category-camera" data-settings-category-panel="camera" aria-labelledby="settings-toggle-camera">
              <div class="settings-category-panel-inner">
                <div class="panel-section camera-section">
                  ${controlTemplate('垂直视野', 'fov', 10, 90, 1, '°', '度')}
                  ${controlTemplate('水平旋转', 'theta', -180, 180, 1, '°', '度')}
                  ${controlTemplate('俯仰角', 'phi', 1, 179, 1, '°', '度')}
                  ${controlTemplate('相机距离', 'radius', 0.000001, 10, 0.001, 'm', '米')}
                  ${controlTemplate('垂直镜头偏移', 'verticalShift', -50, 50, 1, '%', '百分比')}
                  <label class="switch-row camera-correction" for="buildingCorrection">
                    <span><strong>建筑透视校正</strong><small id="buildingCorrectionHelp">保持相机角度，使画面中的竖直线平行。</small></span>
                    <span class="switch-control"><input id="buildingCorrection" type="checkbox" role="switch" aria-label="建筑透视校正" aria-describedby="buildingCorrectionHelp"><i aria-hidden="true"></i></span>
                  </label>
                  <div class="camera-reset-actions">
                    <button class="secondary-button" id="resetCamera" type="button">重置视角</button>
                    <button class="secondary-button" id="undoCameraReset" type="button" hidden>撤销重置</button>
                  </div>
                  <p class="message camera-message" id="cameraMessage" role="status"></p>
                </div>
              </div>
            </section>
            ${studioPanelTemplate()}
          </div>
        </div>
        <footer class="model-export-footer">
          <div class="model-export-actions">
            <div class="model-export-summary"><span>输出尺寸</span><strong id="exportFooterSummary">4096 × 4096 px</strong></div>
            <button class="primary-button" id="exportButton" type="button" disabled><span class="button-label">导出 PNG</span></button>
          </div>
          <p class="message" id="exportStatus" role="status"></p>
        </footer>
      </div>
      <div class="sequence-panel" id="sequencePanel" hidden>
        <section class="panel-section">
          <div class="section-heading"><h2>保存图片</h2></div>
          <div class="sequence-current"><small>当前原始帧</small><strong id="sequenceFilename">尚未选择产品</strong><span id="sequenceResolution"></span></div>
          <button class="primary-button" id="sequenceDownload" type="button" disabled><span class="button-label">保存原始 PNG</span></button>
          <p class="message" id="sequenceMessage" aria-live="polite"></p>
        </section>
        ${sequenceBackgroundPanel()}
        <section class="panel-section">
          <div class="section-heading"><h2>观看控制</h2></div>
          <div class="switch-row">
            <span><strong>自动旋转</strong><small id="sequencePlaybackStatus">打开产品后以每秒 8 帧播放一次</small></span>
            <label class="switch-control"><input id="sequenceAutoToggle" type="checkbox" role="switch" aria-label="自动旋转"><i></i></label>
          </div>
          <div class="switch-row">
            <span><strong>左右反向</strong><small>反转水平拖动的旋转方向</small></span>
            <label class="switch-control"><input id="sequenceReverseToggle" type="checkbox" role="switch" aria-label="左右反向"><i></i></label>
          </div>
          <div class="sequence-stat"><span>缩放比例</span><strong id="sequenceScale">100%</strong></div>
        </section>
        <section class="panel-section">
          <div class="section-heading"><h2>产品信息</h2></div>
          <div class="sequence-product-info"><span>产品</span><strong id="sequenceProductName">—</strong></div>
          <div class="sequence-facts"><span><strong id="sequenceAngleCount">0</strong> 个俯角</span><span><strong id="sequenceTotalFrames">0</strong> 帧</span></div>
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
  <dialog class="thumbnail-variant-dialog" id="thumbnailVariantDialog">
    <form method="dialog">
      <div class="build-dialog-heading"><h2>选择模型封面外观</h2><button id="thumbnailVariantCancel" type="button" aria-label="取消">×</button></div>
      <p class="thumbnail-variant-note">选择此次生成要使用的外观变体。新封面将替换当前模型封面。</p>
      <div class="thumbnail-variant-options" id="thumbnailVariantOptions" role="radiogroup" aria-label="模型封面外观"></div>
      <div class="thumbnail-variant-actions"><button class="secondary-button" id="thumbnailVariantBack" type="button">取消</button><button class="primary-button" id="thumbnailVariantConfirm" type="button">生成并替换封面</button></div>
    </form>
  </dialog>
  <dialog class="thumbnail-batch-dialog" id="thumbnailBatchDialog">
    <form method="dialog">
      <div class="build-dialog-heading"><h2>批量生成模型封面</h2><button id="thumbnailBatchClose" type="button" aria-label="关闭">×</button></div>
      <div id="thumbnailBatchSetup">
        <div class="build-summary"><div><small>模型</small><strong id="thumbnailBatchTotal">0</strong></div><div><small>生成方式</small><strong>串行</strong></div></div>
        <fieldset class="batch-choice"><legend>封面范围</legend><label><input type="radio" name="thumbnailOverwrite" value="missing" checked> 仅生成缺失封面</label><label><input type="radio" name="thumbnailOverwrite" value="all"> 全部重新生成</label></fieldset>
        <fieldset class="batch-choice"><legend>外观变体</legend><label><input type="radio" name="thumbnailAppearance" value="original" checked> 全部使用原始外观</label><label><input type="radio" name="thumbnailAppearance" value="choose"> 逐个选择外观变体</label></fieldset>
        <p class="build-note">已完成的封面不会回滚；单个模型失败后会继续处理其余模型。</p>
        <button class="primary-button" id="thumbnailBatchStart" type="button">开始生成</button>
      </div>
      <div id="thumbnailBatchProgress" hidden>
        <div class="build-progress-value"><strong id="thumbnailBatchPercent">0%</strong><span id="thumbnailBatchCounts">0 / 0</span></div>
        <div class="build-progress-track"><i id="thumbnailBatchBar"></i></div>
        <p id="thumbnailBatchCurrent">正在准备…</p>
        <div class="build-result"><span>成功 <strong id="thumbnailBatchSuccess">0</strong></span><span>跳过 <strong id="thumbnailBatchSkipped">0</strong></span><span>失败 <strong id="thumbnailBatchFailed">0</strong></span></div>
        <div class="batch-issues" id="thumbnailBatchIssues"></div>
        <button class="danger-button" id="thumbnailBatchStop" type="button">停止任务</button>
      </div>
    </form>
  </dialog>
`;

function controlTemplate(label, id, min, max, step, unit, unitName) {
  const value = id === 'verticalShift' ? state[id] * 100 : state[id];
  return `<div class="control-row" data-control="${id}">
    <div class="control-label"><label for="${id}Number">${label}</label><span><input id="${id}Number" type="number" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}（${unitName}）"><em aria-hidden="true">${unit}</em><button class="parameter-reset" data-camera-reset="${id}" type="button" aria-label="重置${label}" title="重置${label}">${parameterResetIcon}</button></span></div>
    <input id="${id}Range" class="range" type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}（${unitName}）">
  </div>`;
}

const viewer = document.querySelector('#modelViewer');
const shell = document.querySelector('#viewerShell');
const viewerFrame = document.querySelector('#viewerFrame');
const status = document.querySelector('#modelStatus');
const themeToggle = document.querySelector('#themeToggle');
const THEME_STORAGE_KEY = 'glb-viewer:theme:v1';

function applyTheme(theme, { persist = true } = {}) {
  const nextTheme = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = nextTheme;
  themeToggle.setAttribute('aria-pressed', String(nextTheme === 'light'));
  themeToggle.querySelector('span:first-child').textContent = nextTheme === 'light' ? '☾' : '☼';
  themeToggle.querySelector('span:last-child').textContent = nextTheme === 'light' ? '深色' : '浅色';
  themeToggle.title = nextTheme === 'light' ? '切换深色主题' : '切换浅色主题';
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, nextTheme); } catch { /* optional persistence */ }
  }
}

let savedTheme = 'dark';
try { savedTheme = localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'; } catch { /* optional persistence */ }
applyTheme(savedTheme, { persist: false });
themeToggle.addEventListener('click', () => applyTheme(document.body.dataset.theme === 'light' ? 'dark' : 'light'));
const errorBox = document.querySelector('#viewerError');
const modelLoadingOverlay = document.querySelector('#modelLoadingOverlay');
const modelLoadingText = document.querySelector('#modelLoadingText');
const exportButton = document.querySelector('#exportButton');
const message = document.querySelector('#message');
const exportStatus = document.querySelector('#exportStatus');
const cameraMessage = document.querySelector('#cameraMessage');
const workspace = document.querySelector('.workspace');
const controlPanel = document.querySelector('.panel');
const library = document.querySelector('#modelLibrary');
const libraryGrid = document.querySelector('#libraryGrid');
const breadcrumbs = document.querySelector('#breadcrumbs');
const contextMenu = document.querySelector('#modelContextMenu');
const generateThumbnailButton = document.querySelector('#generateThumbnail');
const contextMenuHint = document.querySelector('#contextMenuHint');
const renderStudio = new RenderStudio(viewer, document.querySelector('#renderStudio'), { onMessage: showMessage });
const appearanceVariantSelector = new AppearanceVariantSelector(viewer, document.querySelector('#appearanceVariants'));
const modelPanel = document.querySelector('#modelPanel');
const modelPanelScroll = modelPanel.querySelector('.model-panel-scroll');
const exportSettings = modelPanel.querySelector('#exportSettings');
const compactSettingsLayout = matchMedia('(max-width: 980px), (max-height: 620px)');
const modelPanelEmpty = modelPanel.querySelector('#modelPanelEmpty');
const settingsCategoryButtons = [...modelPanel.querySelectorAll('[data-settings-toggle]')];
const settingsCategoryPanels = [...modelPanel.querySelectorAll('[data-settings-category-panel]')];
let activeSettingsCategory = null;
let previewCaptureActive = false;

function syncSettingsAvailability() {
  for (const panel of settingsCategoryPanels) {
    const category = panel.dataset.settingsCategoryPanel;
    const active = category === activeSettingsCategory;
    panel.inert = !active || previewCaptureActive;
    panel.hidden = !active;
    panel.setAttribute('aria-hidden', String(!active));
  }
}

function setPreviewCaptureActive(active) {
  previewCaptureActive = active;
  viewer.inert = active;
  syncSettingsAvailability();
}

function setActiveSettingsCategory(category) {
  activeSettingsCategory = category;
  for (const button of settingsCategoryButtons) {
    button.setAttribute('aria-expanded', String(button.dataset.settingsToggle === category));
  }
  syncSettingsAvailability();
  modelPanelEmpty.hidden = category !== null;
}

function firstSettingsControl(panel) {
  if (panel.inert) return null;
  return [...panel.querySelectorAll(':is(input, select, button):enabled, summary')]
    .find((control) => control.getClientRects().length) ?? null;
}

for (const button of settingsCategoryButtons) {
  button.addEventListener('click', (event) => {
    if (modelPanelScroll.contains(document.activeElement)) button.focus({ preventScroll: true });
    const category = button.dataset.settingsToggle;
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    const scrollBounds = modelPanelScroll.getBoundingClientRect();
    const controlBounds = firstSettingsControl(panel)?.getBoundingClientRect();
    const keyboardActivation = event.detail === 0;
    const firstControlIsVisible = controlBounds && controlBounds.top >= scrollBounds.top && controlBounds.bottom <= scrollBounds.bottom;
    if (activeSettingsCategory === category && firstControlIsVisible && !keyboardActivation) {
      setActiveSettingsCategory(null);
      return;
    }
    setActiveSettingsCategory(category);
    const firstControl = firstSettingsControl(panel);
    if (compactSettingsLayout.matches && exportSettings.open && firstControl &&
        firstControl.getBoundingClientRect().bottom - panel.getBoundingClientRect().top > modelPanelScroll.clientHeight) {
      exportSettings.open = false;
    }
    const viewport = modelPanelScroll.getBoundingClientRect();
    const panelTop = panel.getBoundingClientRect().top;
    const firstBounds = firstControl?.getBoundingClientRect();
    const revealTop = firstBounds && firstBounds.bottom - panelTop > viewport.height
      ? firstBounds.top - 8
      : panelTop;
    modelPanelScroll.scrollTop += revealTop - viewport.top;
    if (keyboardActivation) firstControl?.focus({ preventScroll: true });
  });
}
modelPanel.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || !activeSettingsCategory || document.querySelector('dialog[open]')) return;
  const button = settingsCategoryButtons.find(({ dataset }) => dataset.settingsToggle === activeSettingsCategory);
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  if (event.target !== button && !panel.contains(event.target)) return;
  const variantPopover = modelPanel.querySelector('#appearanceVariantPopover:not([hidden])');
  if (variantPopover && panel.contains(variantPopover)) {
    appearanceVariantSelector.closePopover();
    modelPanel.querySelector('#appearanceVariantToggle').focus();
    event.preventDefault();
    return;
  }
  button.focus({ preventScroll: true });
  setActiveSettingsCategory(null);
  event.preventDefault();
});
setActiveSettingsCategory('camera');
exportSettings.open = !compactSettingsLayout.matches;
compactSettingsLayout.addEventListener('change', ({ matches }) => {
  if (!exportSettings.contains(document.activeElement)) exportSettings.open = !matches;
});
const sequenceRoot = document.querySelector('#sequenceViewer');
const sequenceViewer = new SequenceViewer(sequenceRoot);
const sequenceBackground = new SequenceBackground(sequenceRoot, document.querySelector('#sequenceBackground'),
  document.querySelector('#sequenceGradientOverlay'));

function syncLibraryLayout() {
  const open = state.modelLibraryOpen;
  workspace.classList.toggle('library-open', open);
  controlPanel.hidden = open;
}

syncLibraryLayout();
// Keep the fixed-position menu outside the filtered/clipped library overlay.
// Chromium otherwise treats the overlay as its containing block, while the
// pointer coordinates below are relative to the viewport.
document.body.append(contextMenu);
const undoCameraReset = document.querySelector('#undoCameraReset');
let cameraResetUndo = null;
const cameraControls = [
  ...document.querySelectorAll('[data-control] input'),
  document.querySelector('#buildingCorrection'),
  document.querySelector('#resetCamera'),
  undoCameraReset,
];
const verticalShiftControls = [
  ...document.querySelectorAll('[data-control="verticalShift"] input'),
  document.querySelector('[data-camera-reset="verticalShift"]'),
  document.querySelector('#buildingCorrection'),
];
let contextModel = null;
let contextModelFolder = null;
let sequenceDownloading = false;
let pendingThumbnailVariant = null;
let pendingThumbnailBatchModels = [];
let selectionDrag = null;
let selectionDragClickBlock = false;
const selectionBox = document.createElement('div');
selectionBox.className = 'library-selection-box';
selectionBox.hidden = true;
document.body.append(selectionBox);

function setCameraControlsDisabled(disabled) {
  for (const control of cameraControls) control.disabled = disabled;
}

function setVerticalShiftAvailable(available) {
  for (const control of verticalShiftControls) control.disabled = !available;
}

function applyLensProjection(target, framing) {
  return applyVerticalLensShift(target, framing.verticalShift, {}, framing.buildingCorrection);
}

function setStatus(text, type = '') {
  status.className = `status-pill ${type}`;
  status.innerHTML = `<span></span>${escapeHtml(text)}`;
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

function updateLibrarySearch(mode, visibleCount, totalCount) {
  const input = document.querySelector('#librarySearch');
  const searchLabel = mode === 'sequence' ? '搜索产品或文件夹' : '搜索模型或文件夹';
  input.placeholder = searchLabel;
  input.setAttribute('aria-label', searchLabel);
  if (input.value !== state.libraryQuery) input.value = state.libraryQuery;
  document.querySelector('#clearLibrarySearch').hidden = !state.libraryQuery;
  document.querySelector('#libraryCount').textContent = state.libraryQuery
    ? `找到 ${visibleCount} / ${totalCount} 项`
    : `共 ${totalCount} 项`;
}

function updateSelectionHint(active) {
  const hint = document.querySelector('#librarySelectionHint');
  hint.hidden = !active;
  hint.textContent = active ? '拖动空白区域即可框选 · Shift 可追加选择' : '';
}

function renderModelLibrary() {
  if (state.mode === 'sequence') {
    renderSequenceLibrary();
    return;
  }
  library.setAttribute('aria-label', '模型库');
  updateSelectionHint(true);
  const searching = Boolean(state.libraryQuery.trim());
  const entries = searching
    ? { folders: [], models: filterLibraryItems(state.models, state.libraryQuery) }
    : libraryEntries(state.currentFolder);
  updateLibrarySearch('model', entries.models.length, state.models.length);
  breadcrumbs.hidden = searching;
  const pathParts = state.currentFolder.split('/').filter(Boolean);
  breadcrumbs.innerHTML = [
    '<button type="button" data-folder="">全部模型</button>',
    ...pathParts.map((part, index) => {
      const path = pathParts.slice(0, index + 1).join('/');
      return `<span>/</span><button type="button" data-folder="${escapeHtml(path)}">${escapeHtml(part)}</button>`;
    }),
  ].join('');

  const folderCards = searching ? [] : [
    ...(state.currentFolder ? [`<button class="library-card folder-card back-card" type="button" data-folder="${escapeHtml(parentFolder(state.currentFolder))}">
      <span class="folder-icon back" aria-hidden="true"></span><strong>返回上一级</strong><small>${escapeHtml(parentFolder(state.currentFolder) || '全部模型')}</small>
    </button>`] : []),
    ...entries.folders.map((folder) => {
    const path = state.currentFolder ? `${state.currentFolder}/${folder}` : folder;
    const thumbnailUrl = folderThumbnailUrl(path, state.models);
    return `<button class="library-card folder-card${thumbnailUrl ? ' with-cover' : ''}" type="button" data-folder="${escapeHtml(path)}" data-thumbnail-folder="${escapeHtml(path)}">
      ${thumbnailUrl
        ? `<span class="thumbnail folder-preview"><img src="${escapeHtml(thumbnailUrl)}" alt="" loading="lazy"><span class="folder-preview-label"><span class="folder-symbol" aria-hidden="true"></span>文件夹</span></span>`
        : '<span class="folder-icon" aria-hidden="true"></span>'}
      <strong>${escapeHtml(folder)}</strong>${thumbnailUrl ? '' : '<small>文件夹</small>'}
    </button>`;
    }),
  ];
  const modelCard = (model) => {
    const generating = state.thumbnailGeneratingId === model.id;
    return `<button class="library-card model-card${state.selectedModel?.id === model.id ? ' selected' : ''}${state.selectedModelIds.has(model.id) ? ' batch-selected' : ''}${generating ? ' generating' : ''}" type="button" data-model-id="${escapeHtml(model.id)}">
    <span class="thumbnail">${model.thumbnailUrl
      ? `<img src="${escapeHtml(model.thumbnailUrl)}" alt="" loading="lazy">`
      : '<span class="model-placeholder" aria-hidden="true">3D</span>'}</span>
    ${generating ? '<span class="thumbnail-busy">生成中…</span>' : ''}
    <span class="sequence-checkbox selection-indicator" aria-label="已选择"${state.selectedModelIds.has(model.id) ? '' : ' hidden'}>✓</span>
    <strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.folderPath || 'models')}</small>
  </button>`;
  };
  const modelCards = entries.models.map(modelCard);
  const recentSection = !searching && !state.currentFolder && state.models.length
    ? `<section class="recent-models" aria-labelledby="recentModelsTitle">
        <div class="library-section-title"><h3 id="recentModelsTitle">最近添加</h3></div>
        <div class="recent-grid">${recentModels(10).map(modelCard).join('')}</div>
      </section>
      <div class="library-section-title browse-title"><h3>浏览文件夹</h3></div>`
    : '';
  libraryGrid.innerHTML = recentSection + [...folderCards, ...modelCards].join('') ||
    `<div class="library-empty">${searching ? `没有找到与“${escapeHtml(state.libraryQuery.trim())}”匹配的模型。` : '这个文件夹中没有可预览的 GLB 模型。'}</div>`;
}

function renderSequenceLibrary() {
  library.setAttribute('aria-label', '360度产品库');
  updateSelectionHint(false);
  const searching = Boolean(state.libraryQuery.trim());
  const entries = searching
    ? { folders: [], products: filterLibraryItems(sequenceProducts, state.libraryQuery) }
    : sequenceLibraryEntries(state.sequenceFolder);
  updateLibrarySearch('sequence', entries.products.length, sequenceProducts.length);
  breadcrumbs.hidden = searching;
  const pathParts = state.sequenceFolder.split('/').filter(Boolean);
  breadcrumbs.innerHTML = [
    '<button type="button" data-sequence-folder="">全部产品</button>',
    ...pathParts.map((part, index) => {
      const path = pathParts.slice(0, index + 1).join('/');
      return `<span>/</span><button type="button" data-sequence-folder="${escapeHtml(path)}">${escapeHtml(part)}</button>`;
    }),
  ].join('');
  const folders = searching ? [] : [
    ...(state.sequenceFolder ? [`<button class="library-card folder-card back-card" type="button" data-sequence-folder="${escapeHtml(sequenceParentFolder(state.sequenceFolder))}">
      <span class="folder-icon back" aria-hidden="true"></span><strong>返回上一级</strong><small>${escapeHtml(sequenceParentFolder(state.sequenceFolder) || '全部产品')}</small></button>`] : []),
    ...entries.folders.map((folder) => {
      const path = state.sequenceFolder ? `${state.sequenceFolder}/${folder}` : folder;
      return `<button class="library-card folder-card" type="button" data-sequence-folder="${escapeHtml(path)}"><span class="folder-icon" aria-hidden="true"></span><strong>${escapeHtml(folder)}</strong><small>文件夹</small></button>`;
    }),
  ];
  const cards = entries.products.map((product) => `<button class="library-card sequence-card${state.selectedSequence?.id === product.id ? ' selected' : ''}" type="button" data-sequence-id="${escapeHtml(product.id)}">
    <span class="thumbnail"><img src="${escapeHtml(product.thumbnailUrl)}" alt="" loading="lazy" decoding="async" fetchpriority="low"></span>
    <strong>${escapeHtml(product.name)}</strong><small>${product.angles.length} 个俯角 · ${product.totalFrames} 帧</small>
  </button>`);
  libraryGrid.innerHTML = state.sequenceLibraryLoading
    ? '<div class="library-empty">正在读取 360° 产品…</div>'
    : [...folders, ...cards].join('') || `<div class="library-empty">${searching ? `没有找到与“${escapeHtml(state.libraryQuery.trim())}”匹配的产品。` : 'image_sequence 中没有可用的帧序列产品。'}</div>`;
}

function closeContextMenu() {
  contextModel = null;
  contextModelFolder = null;
  contextMenu.hidden = true;
}

function openContextMenu(event, model) {
  contextModel = model;
  contextModelFolder = null;
  generateThumbnailButton.hidden = false;
  generateThumbnailButton.disabled = !state.thumbnailCapabilityReady ||
    !state.thumbnailWritable || state.thumbnailGeneratingId !== null;
  generateThumbnailButton.textContent = state.selectedModelIds.size > 1
    ? `为已选 ${state.selectedModelIds.size} 个生成缩略图`
    : state.thumbnailGeneratingId === model.id
    ? '正在生成缩略图…'
    : '自动生成缩略图';
  contextMenuHint.textContent = !state.thumbnailCapabilityReady
    ? '正在检查缩略图写入权限…'
    : state.thumbnailWritable
      ? `${state.selectedModelIds.size > 1 ? `已选 ${state.selectedModelIds.size} 个 · ` : ''}固定 640 × 480 · 当前预览视角`
      : '当前服务不支持保存缩略图';
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

async function reloadSequenceLibrary() {
  if (state.sequenceLibraryLoading) return;
  state.sequenceLibraryLoading = true;
  if (state.mode === 'sequence') renderSequenceLibrary();
  try {
    await refreshSequenceLibrary();
    if (sequenceWarnings.length) console.warn('[360°图片]', ...sequenceWarnings);
    if (state.selectedSequence) {
      state.selectedSequence = sequenceProducts.find((item) => item.id === state.selectedSequence.id) ?? null;
      if (state.mode === 'sequence' && !state.selectedSequence) {
        sequenceViewer.unload();
        updateSequenceUI();
        document.querySelector('#sequenceToolbar').hidden = true;
        state.modelLibraryOpen = true;
        syncLibraryLayout();
        library.hidden = false;
        setStatus('等待选择产品');
      }
    }
  } catch (error) {
    console.error(error);
    if (state.mode === 'sequence') setStatus('产品库读取失败', 'error');
  } finally {
    state.sequenceLibraryLoading = false;
    if (state.mode === 'sequence') renderSequenceLibrary();
  }
}

function thumbnailErrorMessage(error) {
  if (error.message === 'MODEL_LOAD_FAILED' || error.message === 'MODEL_TIMEOUT') return '模型载入失败，无法生成缩略图。';
  if (['IMAGE_ENCODE_FAILED', 'IMAGE_SIZE_MISMATCH', 'RENDER_SIZE_MISMATCH', 'EMPTY_RENDER'].includes(error.code ?? error.message)) return '浏览器未能生成 640 × 480 WebP，请检查 WebGL 支持。';
  if (error.message === 'INVALID_ORIGIN' || error.status === 403) return '请求来源未通过校验，请从当前服务页面重试。';
  if (error.code === 'MATERIAL_LOAD_FAILED') return '模型材质加载失败，无法生成完整的缩略图。';
  if (error.code === 'VARIANT_UNAVAILABLE') return '选择的外观变体已不可用，请重新选择。';
  if (error.code === 'VARIANT_APPLY_TIMEOUT') return '外观变体应用超时，未生成模型封面。';
  return '缩略图保存失败，请检查模型目录权限和服务日志。';
}

function openModelFolderContextMenu(event, folderPath) {
  contextModel = null;
  contextModelFolder = folderPath;
  generateThumbnailButton.hidden = false;
  const count = modelsInFolder(state.models, folderPath).length;
  generateThumbnailButton.disabled = !state.thumbnailWritable || state.thumbnailBatchRunning || count === 0;
  generateThumbnailButton.textContent = '递归生成此文件夹封面';
  contextMenuHint.textContent = `${count} 个模型 · 可选仅缺失或全部覆盖`;
  positionContextMenu(event);
}

function chooseThumbnailVariant(options) {
  const dialog = document.querySelector('#thumbnailVariantDialog');
  pendingThumbnailVariant = options[0];
  const displayOptions = appearanceOptions(options.filter((value) => value !== APPEARANCE_ORIGINAL_VALUE));
  document.querySelector('#thumbnailVariantOptions').innerHTML = displayOptions.map(({ value, label }, index) => {
    return `<button type="button" role="radio" aria-checked="${index === 0}" data-thumbnail-variant="${escapeHtml(value)}"><span><strong>${escapeHtml(label)}</strong><small>${appearanceOptionMeta(value)}</small></span><i aria-hidden="true">✓</i></button>`;
  }).join('');
  dialog.showModal();
  return new Promise((resolve) => { dialog._resolveVariant = resolve; });
}

function finishThumbnailVariantChoice(value) {
  const dialog = document.querySelector('#thumbnailVariantDialog');
  const resolve = dialog._resolveVariant;
  dialog._resolveVariant = null;
  if (dialog.open) dialog.close();
  resolve?.(value);
}

async function createAndSaveModelThumbnail(model, chooseVariant) {
  const appearance = await resolveModelAppearance(model.id);
  const dataUrl = await createModelThumbnail(model.url, appearance, state, { chooseVariant });
  const result = await saveModelThumbnail(model.id, dataUrl);
  model.thumbnailUrl = result.thumbnailUrl;
  model.hasDedicatedThumbnail = true;
  return result;
}

async function generateModelThumbnail(model) {
  if (!model || !state.thumbnailWritable || state.thumbnailGeneratingId !== null) return;
  state.thumbnailGeneratingId = model.id;
  closeContextMenu(); renderModelLibrary();
  showMessage(`正在为 ${model.name} 生成 640 × 480 缩略图…`);
  try {
    const result = await createAndSaveModelThumbnail(model, chooseThumbnailVariant);
    showMessage(`已生成 ${result.filename}。`, 'success');
  } catch (error) {
    if (error.code === 'THUMBNAIL_CANCELLED') showMessage('已取消生成模型封面。');
    else { console.error(error); showMessage(thumbnailErrorMessage(error), 'error'); }
  } finally {
    state.thumbnailGeneratingId = null; renderModelLibrary();
  }
}

function openThumbnailBatchDialog(targetModels) {
  pendingThumbnailBatchModels = [...new Map(targetModels.map((model) => [model.id, model])).values()];
  closeContextMenu();
  document.querySelector('#thumbnailBatchTotal').textContent = pendingThumbnailBatchModels.length;
  document.querySelector('#thumbnailBatchSetup').hidden = false;
  document.querySelector('#thumbnailBatchProgress').hidden = true;
  document.querySelector('#thumbnailBatchClose').disabled = false;
  const stop = document.querySelector('#thumbnailBatchStop');
  stop.disabled = false; stop.textContent = '停止任务'; stop.className = 'danger-button';
  document.querySelector('#thumbnailBatchDialog').showModal();
}

function renderThumbnailBatchProgress(progress, result) {
  const completed = result.successIds.length + result.unchangedIds.length + result.skippedIds.length + result.failedIds.length;
  const total = pendingThumbnailBatchModels.length;
  const percent = total ? Math.round(completed / total * 100) : 100;
  document.querySelector('#thumbnailBatchPercent').textContent = `${percent}%`;
  document.querySelector('#thumbnailBatchCounts').textContent = `${completed} / ${total}`;
  document.querySelector('#thumbnailBatchBar').style.width = `${percent}%`;
  document.querySelector('#thumbnailBatchSuccess').textContent = result.successIds.length;
  document.querySelector('#thumbnailBatchSkipped').textContent = result.skippedIds.length + result.unchangedIds.length;
  document.querySelector('#thumbnailBatchFailed').textContent = result.failedIds.length;
  if (progress?.model) document.querySelector('#thumbnailBatchCurrent').textContent = `正在处理：${progress.model.name} (${progress.index + 1} / ${total})`;
  document.querySelector('#thumbnailBatchIssues').innerHTML = result.issues.slice(-6).map((issue) => `<p><strong>${escapeHtml(issue.name || issue.id)}</strong><span>${escapeHtml(issue.reason || issue.status)}</span></p>`).join('');
}

async function startThumbnailBatch() {
  const overwrite = document.querySelector('[name="thumbnailOverwrite"]:checked').value;
  const appearanceStrategy = document.querySelector('[name="thumbnailAppearance"]:checked').value;
  state.thumbnailBatchRunning = true; state.thumbnailBatchStopRequested = false;
  document.querySelector('#thumbnailBatchSetup').hidden = true;
  document.querySelector('#thumbnailBatchProgress').hidden = false;
  document.querySelector('#thumbnailBatchClose').disabled = true;
  const result = await runThumbnailBatch(pendingThumbnailBatchModels, async (model) => {
    if (overwrite === 'missing' && model.hasDedicatedThumbnail) return { status: 'unchanged' };
    state.thumbnailGeneratingId = model.id; renderModelLibrary();
    try {
      const chooser = appearanceStrategy === 'original' ? async () => APPEARANCE_ORIGINAL_VALUE : chooseThumbnailVariant;
      await createAndSaveModelThumbnail(model, chooser);
      return { status: 'success' };
    } catch (error) {
      if (error.code === 'THUMBNAIL_CANCELLED') return { status: 'skipped', reason: '未选择外观' };
      error.message = thumbnailErrorMessage(error); throw error;
    } finally { state.thumbnailGeneratingId = null; renderModelLibrary(); }
  }, {
    shouldStop: () => state.thumbnailBatchStopRequested,
    onProgress: (progress) => renderThumbnailBatchProgress(progress, progress.result),
  });
  state.thumbnailBatchRunning = false;
  const retryIds = new Set([...result.skippedIds, ...result.failedIds, ...result.pendingIds]);
  state.selectedModelIds = retryIds;
  renderModelLibrary(); renderThumbnailBatchProgress(null, result);
  document.querySelector('#thumbnailBatchCurrent').textContent = result.stopped ? '已停止，已完成结果保留。' : retryIds.size ? '任务完成，失败或跳过项已保留勾选。' : '全部模型封面生成完成。';
  const stop = document.querySelector('#thumbnailBatchStop');
  stop.disabled = false; stop.textContent = '关闭'; stop.className = 'secondary-button';
  document.querySelector('#thumbnailBatchClose').disabled = false;
}

function openModelLibrary() {
  state.modelLibraryOpen = true;
  syncLibraryLayout();
  library.hidden = false;
  renderModelLibrary();
  if (state.mode === 'sequence') reloadSequenceLibrary();
}

function closeModelLibrary() {
  if (state.mode === 'model' ? !state.selectedModel : !state.selectedSequence) return;
  state.modelLibraryOpen = false;
  syncLibraryLayout();
  library.hidden = true;
}

function switchMode(mode) {
  if (!['model', 'sequence'].includes(mode) || state.mode === mode) return;
  state.mode = mode;
  state.libraryQuery = '';
  state.selectedModelIds.clear();
  workspace.dataset.previewMode = mode;
  shell.dataset.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  modelPanel.hidden = mode !== 'model';
  document.querySelector('#sequencePanel').hidden = mode !== 'sequence';
  viewer.hidden = mode !== 'model';
  sequenceRoot.hidden = mode !== 'sequence';
  document.querySelector('#sequenceToolbar').hidden = mode !== 'sequence' || !state.selectedSequence;
  document.querySelector('#openLibrary').textContent = mode === 'model' ? '选择模型' : '选择产品';
  document.querySelector('#frameLabel').hidden = mode !== 'model';
  if (mode === 'sequence') {
    if (state.selectedSequence) {
      selectSequence(state.selectedSequence);
      reloadSequenceLibrary();
    } else {
      setStatus('等待选择产品');
      updateSequenceUI();
      openModelLibrary();
    }
    requestAnimationFrame(() => sequenceViewer.resize());
  } else {
    setStatus(state.selectedModel?.name || '等待选择模型', state.loaded ? 'ready' : '');
    if (!state.selectedModel) openModelLibrary();
    sequenceBackground.setReady(false);
    sequenceViewer.unload();
  }
  renderModelLibrary();
}

function selectSequence(product) {
  if (!product) return;
  state.selectedSequence = product;
  state.modelLibraryOpen = false;
  syncLibraryLayout();
  library.hidden = true;
  document.querySelector('#sequenceToolbar').hidden = false;
  setStatus(`正在载入 ${product.name}`);
  setSequenceMessage('');
  sequenceViewer.load(product);
}

function setSequenceMessage(text, type = '') {
  const element = document.querySelector('#sequenceMessage');
  element.textContent = text;
  element.className = `message ${type}`;
}

function updateSequenceUI(detail = sequenceViewer.snapshot()) {
  const { frame, product, ready, loading, buffering, frameFailed } = detail;
  sequenceBackground.setReady(state.mode === 'sequence' && ready);
  document.querySelector('#sequenceAngle').textContent = detail.angle === null ? '俯角 —' : `俯角 ${detail.angle}°`;
  document.querySelector('#sequenceFrame').textContent = detail.frameCount ? `${detail.framePosition} / ${detail.frameCount}` : '— / —';
  document.querySelector('#sequenceScale').textContent = `${Math.round(detail.scale * 100)}%`;
  document.querySelector('#sequenceFilename').textContent = frame?.originalFilename ?? (product ? '—' : '尚未选择产品');
  document.querySelector('#sequenceResolution').textContent = frame?.width && frame?.height ? `${frame.width} × ${frame.height} PNG` : '';
  document.querySelector('#sequenceProductName').textContent = product?.name ?? '—';
  document.querySelector('#sequenceAngleCount').textContent = product?.angles.length ?? 0;
  document.querySelector('#sequenceTotalFrames').textContent = detail.total;
  const loadingProduct = document.querySelector('#sequenceLoadingProduct');
  loadingProduct.textContent = product?.name ?? '';
  loadingProduct.hidden = !product;
  document.querySelector('#sequenceSpinner').hidden = !loading;
  document.querySelector('#sequenceLoadingTitle').textContent = !product ? '请选择 360° 产品'
    : loading ? '正在加载首张图片' : '无法加载产品图片';
  document.querySelector('#sequenceRetry').hidden = !product || ready || loading;
  document.querySelector('#sequenceFrameStatus').hidden = !ready || (!buffering && !frameFailed);
  const frameStatus = document.querySelector('#sequenceFrameStatusText');
  const frameStatusText = frameFailed ? '这张图片加载失败' : buffering ? '正在加载画面…' : '';
  if (frameStatus.textContent !== frameStatusText) frameStatus.textContent = frameStatusText;
  document.querySelector('#sequenceRetryFrame').hidden = !frameFailed;
  document.querySelector('#sequenceDownload').disabled = !frame || !ready || sequenceDownloading;
  document.querySelector('#sequenceReset').disabled = !ready;
  document.querySelector('#sequenceAutoToggle').checked = detail.autoRotate;
  document.querySelector('#sequenceAutoToggle').disabled = !ready;
  document.querySelector('#sequenceReverseToggle').checked = detail.reverse;
  document.querySelector('#sequenceReverseToggle').disabled = !detail.product;
  document.querySelector('#sequencePlaybackStatus').textContent = detail.playbackComplete
    ? '已播放完成'
    : '打开产品后以每秒 8 帧播放一次';
  const play = document.querySelector('#sequencePlay');
  play.disabled = !ready;
  play.classList.toggle('active', detail.playing);
  play.setAttribute('aria-pressed', String(detail.playing));
  play.innerHTML = detail.playing ? '<span>Ⅱ</span> 暂停旋转' : detail.playbackComplete
    ? '<span>↻</span> 重新播放' : '<span>▶</span> 播放旋转';
}

async function downloadSequenceFrame() {
  const frame = sequenceViewer.frame;
  if (!frame || sequenceDownloading) return;
  const product = sequenceViewer.product;
  sequenceDownloading = true;
  const button = document.querySelector('#sequenceDownload');
  button.disabled = true;
  button.querySelector('.button-label').textContent = '正在准备原图…';
  setSequenceMessage('正在读取原始 PNG…');
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
    if (sequenceViewer.product === product) setSequenceMessage(`已保存原始帧 ${frame.index}。`, 'success');
  } catch (error) {
    console.error(error);
    if (sequenceViewer.product === product) setSequenceMessage('原始图片下载失败，请检查网络后重试。', 'error');
  } finally {
    sequenceDownloading = false;
    button.disabled = !sequenceViewer.ready || !sequenceViewer.frame;
    button.querySelector('.button-label').textContent = '保存原始 PNG';
  }
}

async function resetModelRuntime() {
  state.loaded = false;
  clearCameraResetUndo();
  showCameraMessage('');
  showMessage('', '', exportStatus);
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
  appearanceVariantSelector.unloadModel();
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
  document.querySelector('#buildingCorrection').checked = state.buildingCorrection;
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
  await Promise.all((viewer.model?.materials ?? []).map((material) => material.ensureLoaded()));
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
  appearanceVariantSelector.loadModel(model);
  setStatus(model.name, 'ready');
  setCameraControlsDisabled(false);
  setVerticalShiftAvailable(shiftCapability.available);
  exportButton.disabled = false;
  if (!shiftCapability.available) showCameraMessage('当前设备无法使用垂直镜头偏移和建筑透视校正。', 'error');
  showMessage(state.renderQuality.compatibility ? '' : '当前浏览器使用通用纹理过滤。');
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
  syncLibraryLayout();
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
  defaultRadius = roundDistance(radius);
  const radiusRange = document.querySelector('#radiusRange');
  const radiusNumber = document.querySelector('#radiusNumber');
  const step = Number(Math.max(radius / 1000, 0.000001).toPrecision(2));
  radiusCapacity = niceDistanceCeiling(radius * 10);
  radiusRange.max = radiusCapacity;
  radiusRange.step = 'any';
  radiusNumber.step = step;
  radiusNumber.disabled = false;
  radiusRange.disabled = false;
  viewer.maxCameraOrbit = `auto 179deg ${radiusCapacity}m`;
  radiusCapacityUpdate = viewer.updateComplete;
  setControl('radius', defaultRadius);
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
    if (value !== state[id]) clearCameraResetUndo();
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
        showCameraMessage('已到模型表面。垂直视野受到限制，以保持画面中的物体大小。', 'error');
      } else if (cameraMessage.dataset.fovLimited === 'true') {
        showCameraMessage('已解除近距的垂直视野限制。', 'success');
      }
      cameraMessage.dataset.fovLimited = String(resolved.limited || safety.corrected);
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
  clearCameraResetUndo();
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
  clearCameraResetUndo();
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
  clearCameraResetUndo();
  viewer.cameraTarget = 'auto auto auto';
  await viewer.updateComplete;
  setControl('theta', 0);
  setControl('phi', 75);
  if (defaultRadius !== null) setControl('radius', roundDistance(defaultRadius));
  setControl('fov', DEFAULT_SHARED_CAMERA_FRAMING.fov);
  await applyCamera({ immediate: true });
  showMessage('已聚焦模型。', 'success');
}

function showCameraMessage(text, type = '') {
  showMessage(text, type, cameraMessage);
  cameraMessage.dataset.fovLimited = 'false';
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

function clearCameraResetUndo() {
  if (!cameraResetUndo) return;
  cameraResetUndo = null;
  undoCameraReset.hidden = true;
}

const resetCamera = document.querySelector('#resetCamera');
resetCamera.addEventListener('click', async () => {
  if (!state.loaded || state.exporting || cameraResetUndo) return;
  const { theta, phi, radius, fov, verticalShift, buildingCorrection } = state;
  const { x, y, z } = viewer.getCameraTarget();
  const previous = { framing: { theta, phi, radius, fov, verticalShift }, buildingCorrection, target: `${x}m ${y}m ${z}m` };
  cameraResetUndo = previous;
  viewer.cameraTarget = 'auto auto auto';
  await viewer.updateComplete;
  if (cameraResetUndo !== previous) return;
  setControl('theta', 0);
  setControl('phi', 75);
  if (defaultRadius !== null) setControl('radius', roundDistance(defaultRadius));
  setControl('fov', DEFAULT_SHARED_CAMERA_FRAMING.fov);
  setControl('verticalShift', 0);
  state.buildingCorrection = false;
  document.querySelector('#buildingCorrection').checked = false;
  saveSharedCameraFraming(state);
  await applyCamera({ immediate: true });
  if (cameraResetUndo !== previous) return;
  undoCameraReset.hidden = false;
  showCameraMessage('已恢复默认视角。', 'success');
});

undoCameraReset.addEventListener('click', async () => {
  if (!cameraResetUndo || !state.loaded || state.exporting) return;
  const model = state.selectedModel;
  const { framing, buildingCorrection, target } = cameraResetUndo;
  resetCamera.focus({ preventScroll: true });
  clearCameraResetUndo();
  viewer.cameraTarget = target;
  state.buildingCorrection = buildingCorrection;
  document.querySelector('#buildingCorrection').checked = buildingCorrection;
  for (const [key, value] of Object.entries(framing)) setControl(key, value);
  await applyCamera({ immediate: true });
  if (state.loaded && state.selectedModel === model && !cameraResetUndo) showCameraMessage('已撤销视角重置。', 'success');
});

document.querySelector('#buildingCorrection').addEventListener('change', async (event) => {
  clearCameraResetUndo();
  const corrected = applyBuildingCorrection(state, event.target.checked);
  state.buildingCorrection = corrected.buildingCorrection;
  saveSharedCameraFraming(state);
  await applyCamera({ immediate: true });
  showCameraMessage(state.buildingCorrection
    ? '已开启建筑透视校正；相机角度保持不变。'
    : '已关闭建筑透视校正。', 'success');
});

function cameraDefaults() {
  return { theta: 0, phi: 75, radius: defaultRadius ?? state.radius, fov: DEFAULT_SHARED_CAMERA_FRAMING.fov, verticalShift: 0 };
}
for (const button of document.querySelectorAll('[data-camera-reset]')) {
  button.addEventListener('click', async () => {
    clearCameraResetUndo();
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
const resetBackground = document.querySelector('#resetBackground');
const transparentToggle = document.querySelector('#transparentToggle');
const preserveShadowToggle = document.querySelector('#preserveShadowToggle');
const exportQualityInput = document.querySelector('#exportQuality');
const textureDetailInput = document.querySelector('#textureDetailMode');
const widthInput = document.querySelector('#exportWidth');
const heightInput = document.querySelector('#exportHeight');
const resolutionPreset = document.querySelector('#resolutionPreset');
const resolutionAspect = document.querySelector('#resolutionAspect');
const footerSummary = document.querySelector('#exportFooterSummary');
const customDimensions = document.querySelector('.export-custom-dimensions');
const dimensionFeedback = document.querySelector('#exportDimensionFeedback');
const resetWidth = document.querySelector('#resetExportWidth');
const resetHeight = document.querySelector('#resetExportHeight');
const frameLabel = document.querySelector('#frameLabel');
const exportCapability = readExportDimensionCapability();
const exportCapabilityMessage = document.querySelector('#exportCapability');
const maximumExportDimension = Math.min(
  exportOptions.maximumDimension,
  exportCapability.maximumDimension ?? exportOptions.maximumDimension,
);
let exportDimensionRevision = 0;

exportOptions.setMaximumDimension(maximumExportDimension);
widthInput.max = maximumExportDimension;
heightInput.max = maximumExportDimension;
document.querySelector('#exportSizeRange').textContent = `每边支持 64–${maximumExportDimension} px 的整数。`;
exportCapabilityMessage.textContent = exportCapability.available
  ? `可设置上限 ${maximumExportDimension} px。设备 WebGL 纹理上限 ${exportCapability.textureSize} px，渲染缓冲上限 ${exportCapability.renderbufferSize} px。`
  : `可设置上限 ${maximumExportDimension} px。浏览器未提供 WebGL 尺寸上限，导出时将验证实际可用尺寸。`;
const supportedPresets = [...resolutionPreset.options].filter((option) => {
  if (option.value === 'custom') return false;
  option.disabled = Number(option.value) > maximumExportDimension;
  return !option.disabled;
});
if (resolutionPreset.selectedOptions[0].disabled) {
  resolutionPreset.value = supportedPresets.at(-1)?.value ?? 'custom';
}

function updateBackgroundControls() {
  colorInput.disabled = state.transparent;
  resetBackground.disabled = state.transparent || state.background === '#e8eaed';
  document.querySelector('#exportBackgroundRow').hidden = state.transparent;
  document.querySelector('#exportBackgroundHelp').hidden = !state.transparent;
  shell.classList.toggle('export-transparent', state.transparent);
}

colorInput.addEventListener('input', () => {
  state.background = colorInput.value;
  document.querySelector('#colorValue').textContent = colorInput.value.toUpperCase();
  shell.style.setProperty('--viewer-background', colorInput.value);
  updateBackgroundControls();
});
resetBackground.addEventListener('click', () => {
  colorInput.value = '#e8eaed';
  colorInput.dispatchEvent(new Event('input'));
});

function applyExportOptions(snapshot = exportOptions.getSnapshot()) {
  Object.assign(state, snapshot, { maximumExportDimension: snapshot.maximumDimension });
  exportQualityInput.value = snapshot.exportQuality;
  textureDetailInput.value = snapshot.textureDetailMode;
  transparentToggle.checked = snapshot.transparent;
  preserveShadowToggle.checked = snapshot.preserveShadow;
  preserveShadowToggle.disabled = !snapshot.transparent;
  preserveShadowToggle.closest('.switch-row').hidden = !snapshot.transparent;
  const quality = exportOptions.getExportPlan().antiAlias === 'fxaa' ? '高质量' : '标准采样';
  const texture = snapshot.textureDetailMode === 'base-level' ? '原图优先' : '自适应';
  document.querySelector('#exportQualitySummary').textContent = `${quality} · ${texture}`;
  updateBackgroundControls();
  updateExportSummary();
}

transparentToggle.addEventListener('change', (event) => {
  applyExportOptions(exportOptions.setOption('transparent', event.target.checked));
});

preserveShadowToggle.addEventListener('change', (event) => {
  applyExportOptions(exportOptions.setOption('preserveShadow', event.target.checked));
});

exportQualityInput.addEventListener('change', (event) => {
  applyExportOptions(exportOptions.setOption('exportQuality', event.target.value));
});

textureDetailInput.addEventListener('change', (event) => {
  applyExportOptions(exportOptions.setOption('textureDetailMode', event.target.value));
});

function greatestCommonDivisor(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function actualExportAspect() {
  const divisor = greatestCommonDivisor(state.width, state.height);
  return `${state.width / divisor}:${state.height / divisor}`;
}

function updateExportSummary() {
  const dimensions = `${state.width} × ${state.height} px`;
  const background = state.transparent
    ? (state.preserveShadow ? '透明背景 · 保留阴影' : '透明背景')
    : '实色背景';
  const aspect = resolutionAspect.value === 'custom' ? actualExportAspect() : resolutionAspect.value;
  footerSummary.textContent = `${dimensions} · ${background}`;
  frameLabel.textContent = `${state.width} × ${state.height} · ${aspect}${state.transparent ? ` · ${background}` : ''}`;
  updateFramingGuide();
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
}

function updateDimensions({
  width = widthInput.valueAsNumber,
  height = heightInput.valueAsNumber,
  commit = true,
  aspect,
  reportCorrection = false,
} = {}) {
  if (!commit && ![width, height].every((value) => Number.isInteger(value) && value >= 64 && value <= maximumExportDimension)) return;
  exportOptions.setOption('width', Number.isFinite(width) ? width : state.width);
  const next = exportOptions.setOption('height', Number.isFinite(height) ? height : state.height);
  if (next.width !== state.width || next.height !== state.height) exportDimensionRevision++;
  state.width = next.width;
  state.height = next.height;
  if (commit) {
    widthInput.value = state.width;
    heightInput.value = state.height;
    dimensionFeedback.textContent = reportCorrection && (width !== state.width || height !== state.height)
      ? `已调整为 ${state.width} × ${state.height} px。每边需填写 64–${maximumExportDimension} 的整数。`
      : '';
  }
  const customPreset = resolutionPreset.value === 'custom';
  if (customPreset) {
    const ratio = aspect && width === state.width && height === state.height ? aspect : actualExportAspect();
    resolutionAspect.value = [...resolutionAspect.options].some((option) => option.value === ratio) ? ratio : 'custom';
  }
  customDimensions.hidden = !customPreset;
  resetWidth.disabled = state.width === Math.min(4096, maximumExportDimension);
  resetHeight.disabled = state.height === Math.min(4096, maximumExportDimension);
  updateExportSummary();
}

function applyResolutionPreset({ aspectChanged = false } = {}) {
  const customPreset = resolutionPreset.value === 'custom';
  if (customPreset && !aspectChanged) {
    updateDimensions({ width: state.width, height: state.height, aspect: resolutionAspect.value });
    return;
  }
  if (!resolutionAspect.value || resolutionAspect.value === 'custom') resolutionAspect.value = '1:1';
  const aspect = resolutionAspect.value;
  const [ratioWidth, ratioHeight] = aspect.split(':').map(Number);
  const base = customPreset ? Math.max(state.width, state.height) : Number(resolutionPreset.value);
  const ratio = ratioWidth / ratioHeight;
  const width = ratio >= 1 ? base : Math.round(base * ratio);
  const height = ratio >= 1 ? Math.round(base / ratio) : base;
  updateDimensions({ width, height, aspect, reportCorrection: customPreset });
}

function applySupportedDrawingBufferSize({ width, height }) {
  resolutionPreset.value = 'custom';
  updateDimensions({ width, height });
}

[widthInput, heightInput].forEach((input) => {
  input.addEventListener('input', () => updateDimensions({ commit: false }));
  input.addEventListener('change', () => updateDimensions({ reportCorrection: true }));
});
resolutionPreset.addEventListener('change', () => applyResolutionPreset());
resolutionAspect.addEventListener('change', () => applyResolutionPreset({ aspectChanged: true }));
resetWidth.addEventListener('click', () => updateDimensions({ width: 4096, height: state.height }));
resetHeight.addEventListener('click', () => updateDimensions({ width: state.width, height: 4096 }));
applyExportOptions();
applyResolutionPreset();
new ResizeObserver(updateFramingGuide).observe(shell);

function showMessage(text, type = '', target = message) {
  target.textContent = text;
  target.classList.toggle('success', type === 'success');
  target.classList.toggle('error', type === 'error');
}

let activeExportTask = null;
let exportAbortController = null;

function exportImage() {
  if (!state.loaded || state.exporting || exportButton.disabled) return activeExportTask;
  exportAbortController = new AbortController();
  activeExportTask = performExportImage(exportAbortController.signal).finally(() => {
    activeExportTask = null;
    exportAbortController = null;
  });
  activeExportTask.catch(() => {});
  return activeExportTask;
}

async function performExportImage(signal) {
  if (widthInput.valueAsNumber !== state.width || heightInput.valueAsNumber !== state.height) {
    updateDimensions({ reportCorrection: true });
  }
  const exportPlan = exportOptions.getExportPlan();
  const { width, height, transparent, preserveShadow, textureDetailMode } = exportPlan;
  const background = state.background;
  const modelName = state.selectedModel?.name || 'model';
  const maximumAnisotropy = state.renderQuality.maximumAnisotropy;
  const dimensionRevision = exportDimensionRevision;
  const { theta, phi, radius, fov, verticalShift, buildingCorrection } = state;
  const cameraFraming = Object.freeze({ theta, phi, radius, fov, verticalShift, buildingCorrection });
  const useFxaa = exportPlan.antiAlias === 'fxaa';
  const scaleLabel = useFxaa ? 'FXAA 抗锯齿' : '标准采样';

  state.exporting = true;
  shell.classList.add('exporting');
  exportButton.disabled = true;
  exportButton.classList.add('busy');
  exportButton.querySelector('.button-label').textContent = '正在渲染…';
  showMessage(`正在生成 ${width} × ${height} PNG…`, '', exportStatus);

  try {
    setPreviewCaptureActive(true);
    const rendered = await renderFixedSizeImage(viewer, {
      width,
      height,
      background: transparent ? 'transparent' : background,
      hideEnvironment: true,
      transparent,
      preserveShadow,
      textureDetailMode,
      cameraFraming,
      signal,
    });
    if (signal.aborted) return;
    const detailLabel = rendered.textureDetail.applied
      ? `原图优先（${rendered.textureDetail.textureCount} 张纹理，${maximumAnisotropy}× 各向异性）`
      : `自适应 mipmap（${maximumAnisotropy}× 各向异性）`;
    const blob = await finalizePngExport(rendered.blob, {
      width,
      height,
      transparent,
      background,
      antiAlias: useFxaa ? 'fxaa' : 'none',
    });
    const dimensions = await readImageDimensions(blob);
    if (signal.aborted) return;
    if (dimensions.width !== width || dimensions.height !== height) {
      throw new Error(`SIZE_MISMATCH:${dimensions.width}x${dimensions.height}`);
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    const safeModelName = modelName
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/[. ]+$/g, '') || 'model';
    link.download = `${safeModelName}_${width}x${height}_${stamp}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage(`已导出 ${width} × ${height} PNG。 ${scaleLabel}，${detailLabel}。`, 'success', exportStatus);
  } catch (error) {
    const code = error?.code ?? error?.message;
    const restorationFailed = hasRenderRestorationFailure(error);
    if (signal.aborted || code === 'RENDER_ABORTED') {
      if (restorationFailed) throw error;
      showMessage('', '', exportStatus);
      return;
    }
    console.error(error);
    const mismatch = code === 'RENDER_SIZE_MISMATCH' || String(error?.message).startsWith('SIZE_MISMATCH');
    const detailUnavailable = code === 'TEXTURE_DETAIL_UNAVAILABLE';
    const drawingBufferTooSmall = code === 'RENDER_BUFFER_TOO_SMALL';
    let feedback = '导出失败。请降低尺寸或检查浏览器的 WebGL 支持，再重试。';
    if (restorationFailed) {
      feedback = '取景预览恢复失败，请重新加载模型后再导出。';
    } else if (detailUnavailable) {
      feedback = '当前浏览器无法启用原图优先。请在「质量与设备信息」中选择「自适应（更稳定）」后重试。';
      exportSettings.open = true;
      document.querySelector('#exportAdvanced').open = true;
      textureDetailInput.scrollIntoView({ block: 'nearest' });
    } else if (drawingBufferTooSmall) {
      const supported = `${error.details.width} × ${error.details.height}`;
      if (exportDimensionRevision === dimensionRevision) {
        applySupportedDrawingBufferSize(error.details);
        feedback = `浏览器实际能绘制 ${supported} px。已填入可用尺寸，请确认后重新导出。`;
      } else {
        feedback = `浏览器实际能绘制 ${supported} px。当前尺寸设置已保留，可改用该尺寸后重试。`;
      }
    } else if (mismatch) {
      feedback = `浏览器未能生成本次要求的 ${width} × ${height} px，请降低导出尺寸后重试。`;
    }
    showMessage(feedback, 'error', exportStatus);
    if (restorationFailed) throw error;
  } finally {
    state.exporting = false;
    setPreviewCaptureActive(false);
    shell.classList.remove('exporting');
    exportButton.disabled = signal.aborted || !state.loaded;
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
document.querySelector('#librarySearch').addEventListener('input', (event) => {
  state.libraryQuery = event.target.value;
  renderModelLibrary();
});
document.querySelector('#clearLibrarySearch').addEventListener('click', () => {
  state.libraryQuery = '';
  renderModelLibrary();
  document.querySelector('#librarySearch').focus();
});
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => switchMode(button.dataset.mode)));

function selectionModeActive() {
  return state.mode === 'model';
}

function selectionCards() {
  return [...libraryGrid.querySelectorAll('[data-model-id]')];
}

function updateSelectionVisuals() {
  for (const card of selectionCards()) {
    const active = state.selectedModelIds.has(card.dataset.modelId);
    card.classList.toggle('batch-selected', active);
    card.querySelector('.selection-indicator')?.toggleAttribute('hidden', !active);
  }
}

function updateSelectionDrag(event) {
  if (!selectionDrag) return;
  if (!selectionDrag.moved) {
    const distance = Math.hypot(event.clientX - selectionDrag.startX, event.clientY - selectionDrag.startY);
    if (distance < 5) return;
    selectionDrag.moved = true;
  }
  event.preventDefault();
  const left = Math.min(selectionDrag.startX, event.clientX);
  const top = Math.min(selectionDrag.startY, event.clientY);
  const width = Math.abs(event.clientX - selectionDrag.startX);
  const height = Math.abs(event.clientY - selectionDrag.startY);
  selectionBox.style.left = `${left}px`;
  selectionBox.style.top = `${top}px`;
  selectionBox.style.width = `${width}px`;
  selectionBox.style.height = `${height}px`;
  const dragRect = { left, top, right: left + width, bottom: top + height };
  const cards = selectionDrag.cards;
  const next = new Set(selectionDrag.baseSelection);
  const intersectingIds = new Set();
  for (const { card, rect } of cards) {
    const intersects = rect.left < dragRect.right && rect.right > dragRect.left &&
      rect.top < dragRect.bottom && rect.bottom > dragRect.top;
    if (!intersects) continue;
    intersectingIds.add(card.dataset.modelId);
    next.add(card.dataset.modelId);
  }
  if (!selectionDrag.additive) {
    for (const id of selectionDrag.baseSelection) {
      if (!intersectingIds.has(id)) next.delete(id);
    }
  }
  state.selectedModelIds = next;
  updateSelectionVisuals();
}

function finishSelectionDrag() {
  if (!selectionDrag) return;
  document.removeEventListener('pointermove', updateSelectionDrag);
  document.removeEventListener('pointerup', finishSelectionDrag);
  selectionBox.hidden = true;
  libraryGrid.classList.remove('is-selecting');
  selectionDragClickBlock = selectionDrag.moved;
  if (selectionDragClickBlock) setTimeout(() => { selectionDragClickBlock = false; }, 0);
  selectionDrag = null;
}

libraryGrid.addEventListener('pointerdown', (event) => {
  if (!selectionModeActive() || event.button !== 0 || event.target.closest('input, a')) return;
  selectionDrag = {
    startX: event.clientX,
    startY: event.clientY,
    baseSelection: new Set(state.selectedModelIds),
    additive: event.shiftKey || event.ctrlKey || event.metaKey,
    cards: selectionCards().map((card) => ({ card, rect: card.getBoundingClientRect() })),
    moved: false,
  };
  selectionBox.hidden = false;
  selectionBox.style.left = `${event.clientX}px`;
  selectionBox.style.top = `${event.clientY}px`;
  selectionBox.style.width = '0px';
  selectionBox.style.height = '0px';
  libraryGrid.classList.add('is-selecting');
  document.addEventListener('pointermove', updateSelectionDrag);
  document.addEventListener('pointerup', finishSelectionDrag);
});

library.addEventListener('click', (event) => {
  if (selectionDragClickBlock) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const sequenceFolderButton = event.target.closest('[data-sequence-folder]');
  if (sequenceFolderButton) {
    state.sequenceFolder = sequenceFolderButton.dataset.sequenceFolder;
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
  if (modelButton) {
    const model = state.models.find((item) => item.id === modelButton.dataset.modelId);
    if (state.mode === 'model') {
      // A plain click keeps the primary library action discoverable: open the
      // model. Modifier-click is the explicit additive/toggle selection path.
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        if (state.selectedModelIds.has(model.id)) state.selectedModelIds.delete(model.id);
        else state.selectedModelIds.add(model.id);
        renderModelLibrary();
      } else {
        selectModel(model);
      }
    } else selectModel(model);
  }
});
library.addEventListener('dblclick', (event) => {
  const modelButton = event.target.closest('[data-model-id]');
  if (!modelButton || state.mode !== 'model') return;
  const model = state.models.find((item) => item.id === modelButton.dataset.modelId);
  if (model) selectModel(model);
});
library.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('[data-model-id], [data-folder], [data-sequence-id], [data-sequence-folder]')) return;
  if (selectionModeActive()) {
    state.selectedModelIds.clear();
    renderModelLibrary();
  }
});
library.addEventListener('contextmenu', (event) => {
  if (state.mode !== 'model' || window.matchMedia('(pointer: coarse)').matches) return;
  const modelCard = event.target.closest('[data-model-id]');
  const modelFolder = event.target.closest('[data-thumbnail-folder]');
  if (!modelCard && !modelFolder) return;
  event.preventDefault();
  if (modelFolder) { openModelFolderContextMenu(event, modelFolder.dataset.thumbnailFolder); return; }
  const model = state.models.find((item) => item.id === modelCard.dataset.modelId);
  if (model) {
    if (!state.selectedModelIds.has(model.id)) {
      state.selectedModelIds.clear();
      state.selectedModelIds.add(model.id);
      renderModelLibrary();
    }
    openContextMenu(event, model);
  }
});
generateThumbnailButton.addEventListener('click', () => {
  if (contextModelFolder !== null) openThumbnailBatchDialog(modelsInFolder(state.models, contextModelFolder));
  else if (state.selectedModelIds.size > 1) openThumbnailBatchDialog(state.models.filter((model) => state.selectedModelIds.has(model.id)));
  else generateModelThumbnail(contextModel);
});
document.querySelector('#thumbnailVariantOptions').addEventListener('click', (event) => {
  const option = event.target.closest('[data-thumbnail-variant]');
  if (!option) return;
  pendingThumbnailVariant = option.dataset.thumbnailVariant;
  document.querySelectorAll('[data-thumbnail-variant]').forEach((button) => button.setAttribute('aria-checked', String(button === option)));
});
document.querySelector('#thumbnailVariantConfirm').addEventListener('click', () => finishThumbnailVariantChoice(pendingThumbnailVariant));
document.querySelector('#thumbnailVariantBack').addEventListener('click', () => finishThumbnailVariantChoice(null));
document.querySelector('#thumbnailVariantCancel').addEventListener('click', () => finishThumbnailVariantChoice(null));
document.querySelector('#thumbnailVariantDialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  finishThumbnailVariantChoice(null);
});
document.querySelector('#thumbnailBatchStart').addEventListener('click', startThumbnailBatch);
document.querySelector('#thumbnailBatchStop').addEventListener('click', () => {
  if (state.thumbnailBatchRunning) {
    state.thumbnailBatchStopRequested = true;
    document.querySelector('#thumbnailBatchStop').disabled = true;
    document.querySelector('#thumbnailBatchCurrent').textContent = '正在停止，当前模型完成后不再启动新任务…';
  } else document.querySelector('#thumbnailBatchDialog').close();
});
document.querySelector('#thumbnailBatchClose').addEventListener('click', () => { if (!state.thumbnailBatchRunning) document.querySelector('#thumbnailBatchDialog').close(); });
document.querySelector('#thumbnailBatchDialog').addEventListener('cancel', (event) => { if (state.thumbnailBatchRunning) event.preventDefault(); });
document.addEventListener('click', (event) => {
  if (!contextMenu.hidden && !contextMenu.contains(event.target)) closeContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeContextMenu();
});
libraryGrid.addEventListener('scroll', closeContextMenu, { passive: true });

for (const type of ['change', 'progress', 'playchange', 'playcomplete', 'reversechange', 'frameerror']) {
  sequenceViewer.addEventListener(type, (event) => updateSequenceUI(event.detail));
}
sequenceViewer.addEventListener('ready', (event) => {
  updateSequenceUI(event.detail);
  if (state.mode === 'sequence') setStatus(event.detail.product.name, 'ready');
});
sequenceViewer.addEventListener('loaderror', (event) => {
  updateSequenceUI(event.detail);
  if (!event.detail.ready && state.mode === 'sequence') setStatus('图片加载失败', 'error');
});
sequenceViewer.addEventListener('viewererror', (event) => {
  updateSequenceUI(event.detail);
  if (state.mode === 'sequence') setStatus('没有可用图片', 'error');
});
document.querySelector('#sequencePlay').addEventListener('click', () => sequenceViewer.setPlaying(!sequenceViewer.playing));
document.querySelector('#sequenceAutoToggle').addEventListener('change', (event) => sequenceViewer.setAutoRotate(event.target.checked));
document.querySelector('#sequenceReverseToggle').addEventListener('change', (event) => sequenceViewer.setReverse(event.target.checked));
document.querySelector('#sequenceRetry').addEventListener('click', () => {
  setStatus(`正在重试 ${state.selectedSequence?.name || '产品'}`);
  sequenceViewer.retryFailed();
});
document.querySelector('#sequenceRetryFrame').addEventListener('click', () => sequenceViewer.retryFailed());
document.querySelector('#sequenceReset').addEventListener('click', () => sequenceViewer.reset());
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
