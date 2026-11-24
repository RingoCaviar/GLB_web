const POSTPROCESS_TONE_MAPPINGS = Object.freeze({
  neutral: 'neutral',
  commerce: 'neutral',
  aces: 'aces_filmic',
  agx: 'agx',
});
export const REALTIME_POSTPROCESSING_STORAGE_KEY = 'glb-viewer:realtime-postprocessing:v1';
export const DEFAULT_REALTIME_POSTPROCESSING = Object.freeze({ smaa: true, ssao: true, ssaoStrength: 1.5, ssaoRadius: 0.15, ssaoSamples: 32 });
const pausedComposers = new WeakMap();

export function loadRealtimePostprocessing(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(REALTIME_POSTPROCESSING_STORAGE_KEY) ?? 'null');
    return {
      smaa: typeof value?.smaa === 'boolean' ? value.smaa : true,
      ssao: typeof value?.ssao === 'boolean' ? value.ssao : true,
      ssaoStrength: Number.isFinite(value?.ssaoStrength) ? value.ssaoStrength : 1.5,
      ssaoRadius: Number.isFinite(value?.ssaoRadius) ? value.ssaoRadius : 0.15,
      ssaoSamples: Number.isFinite(value?.ssaoSamples) ? value.ssaoSamples : 32,
    };
  } catch {
    return { ...DEFAULT_REALTIME_POSTPROCESSING };
  }
}

export function saveRealtimePostprocessing(value, storage = globalThis.localStorage) {
  try {
    storage?.setItem(REALTIME_POSTPROCESSING_STORAGE_KEY, JSON.stringify({
      smaa: value.smaa !== false,
      ssao: value.ssao !== false,
      ssaoStrength: Number(value.ssaoStrength) || 1.5,
      ssaoRadius: Number(value.ssaoRadius) || 0.15,
      ssaoSamples: Number(value.ssaoSamples) || 32,
    }));
    return true;
  } catch {
    return false;
  }
}

export function applyRealtimePostprocessing(viewer, value) {
  const composer = viewer.querySelector?.('effect-composer') ?? pausedComposers.get(viewer);
  const ssao = composer?.querySelector('ssao-effect');
  // model-viewer-effects can initialize SSAO before the composer has created
  // its normal buffer. Rebind it whenever preferences are applied so the
  // effect has the depth/normal input it needs to produce occlusion.
  if (ssao?.effects?.[0] && composer?.normalBuffer) {
    const effect = ssao.effects[0];
    effect.normalBuffer = composer.normalBuffer;
    if (effect.ssaoPass) effect.ssaoPass.normalBuffer = composer.normalBuffer;
    // The library default radius (0.05 world units) is too small for the
    // product-scale models in this viewer, making occlusion effectively
    // invisible. Use a wider neighbourhood and more samples for preview.
    effect.radius = value.ssaoRadius;
    effect.samples = value.ssaoSamples;
    effect.intensity = value.ssaoStrength;
  }
  const modes = [['smaa-effect', value.smaa], ['ssao-effect', value.ssao]];
  for (const [selector, enabled] of modes) {
    const effect = composer?.querySelector(selector);
    if (effect) effect.blendMode = enabled === false ? 'skip' : 'default';
  }
  composer?.queueRender?.();
}

export function applyRealtimeToneMapping(viewer, toneMapping) {
  viewer.toneMapping = toneMapping;
  const colorGrade = viewer.querySelector?.('color-grade-effect');
  if (colorGrade) colorGrade.tonemapping = postprocessToneMapping(toneMapping);
}

function postprocessToneMapping(toneMapping) {
  return POSTPROCESS_TONE_MAPPINGS[toneMapping] ?? 'neutral';
}

export function pauseRealtimePostprocessing(viewer) {
  const composer = viewer.querySelector?.('effect-composer');
  const parent = composer?.parentNode;
  const nextSibling = composer?.nextSibling;
  if (composer) pausedComposers.set(viewer, composer);
  composer?.remove();
  let restored = false;
  return {
    restore() {
      if (restored) return;
      restored = true;
      if (!composer || !parent) return;
      const colorGrade = composer.querySelector('color-grade-effect');
      if (colorGrade) colorGrade.tonemapping = postprocessToneMapping(viewer.toneMapping);
      const reference = nextSibling?.parentNode === parent ? nextSibling : null;
      parent.insertBefore(composer, reference);
      pausedComposers.delete(viewer);
    },
  };
}
