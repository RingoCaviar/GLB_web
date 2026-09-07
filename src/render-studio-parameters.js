const numeric = (id, key, label, min, max, step, group, options = {}) => Object.freeze({
  id, key, label, min, max, step, group, kind: 'number', ...options,
});
const discrete = (id, key, label, group, kind) => Object.freeze({ id, key, label, group, kind });

export const STUDIO_PARAMETERS = Object.freeze([
  discrete('environmentPreset', 'preset', 'HDRI 环境', 'lighting', 'select'),
  discrete('environmentDesaturate', 'desaturate', 'HDRI 去色', 'lighting', 'switch'),
  discrete('environmentPreview', 'showEnvironment', '预览 HDRI 背景', 'lighting', 'switch'),
  discrete('toneMapping', 'toneMapping', '色调映射', 'lighting', 'select'),
  numeric('studioExposure', 'exposure', '曝光', 0.1, 3, 0.05, 'lighting'),
  numeric('studioShadowIntensity', 'shadowIntensity', '阴影强度', 0, 2, 0.05, 'lighting'),
  numeric('studioShadowSoftness', 'shadowSoftness', '阴影柔和度', 0, 1, 0.05, 'lighting'),
  numeric('studioNormalStrength', 'normalStrength', '法线强度', 0, 2, 0.01, 'lighting'),
  numeric('studioEnvironmentRotationX', 'environmentRotationX', 'HDRI 俯仰 X', -180, 180, 1, 'rotation', { unit: '°' }),
  numeric('studioEnvironmentRotationY', 'environmentRotationY', 'HDRI 水平 Y', 0, 360, 1, 'rotation', { unit: '°' }),
  numeric('studioEnvironmentRotationZ', 'environmentRotationZ', 'HDRI 翻滚 Z', -180, 180, 1, 'rotation', { unit: '°' }),
  numeric('materialMetallic', 'metallic', '金属度', 0, 1, 0.01, 'material-basic'),
  numeric('materialRoughness', 'roughness', '粗糙度', 0, 1, 0.01, 'material-basic'),
  numeric('materialEmissiveStrength', 'emissiveStrength', '发光强度', 0, 10, 0.05, 'material-basic'),
  discrete('materialBaseColor', 'baseColor', '基础颜色', 'material-basic', 'color'),
  discrete('materialEmissive', 'emissive', '发光颜色', 'material-basic', 'color'),
  discrete('materialDoubleSided', 'doubleSided', '网格表面', 'material-basic', 'select'),
  discrete('materialAlphaMode', 'alphaMode', '透明模式', 'material-basic', 'select'),
  numeric('material-clearcoat', 'clearcoat', '清漆', 0, 1, 0.01, 'material-advanced', { supportedBy: 'setClearcoatFactor' }),
  numeric('material-clearcoatRoughness', 'clearcoatRoughness', '清漆粗糙度', 0, 1, 0.01, 'material-advanced', { supportedBy: 'setClearcoatRoughnessFactor' }),
  numeric('material-transmission', 'transmission', '透射', 0, 1, 0.01, 'material-advanced', { supportedBy: 'setTransmissionFactor' }),
  numeric('material-ior', 'ior', '折射率', 1, 2.333, 0.01, 'material-advanced', { supportedBy: 'setIor' }),
  numeric('material-thickness', 'thickness', '厚度', 0, 10, 0.01, 'material-advanced', { supportedBy: 'setThicknessFactor' }),
  numeric('material-specular', 'specular', '镜面强度', 0, 1, 0.01, 'material-advanced', { supportedBy: 'setSpecularFactor' }),
  numeric('material-iridescence', 'iridescence', '虹彩', 0, 1, 0.01, 'material-advanced', { supportedBy: 'setIridescenceFactor' }),
  numeric('material-anisotropy', 'anisotropy', '各向异性', 0, 1, 0.01, 'material-advanced', { supportedBy: 'setAnisotropyStrength' }),
]);

const byId = new Map(STUDIO_PARAMETERS.map((parameter) => [parameter.id, parameter]));

export const studioParameter = (id) => byId.get(id) ?? null;
export const studioParameters = (group) => STUDIO_PARAMETERS.filter((parameter) => parameter.group === group);
export const studioNumericParameters = (group) => studioParameters(group).filter((parameter) => parameter.kind === 'number');
export const visibleStudioParameters = (group, target) => studioParameters(group)
  .filter((parameter) => !parameter.supportedBy || typeof target?.[parameter.supportedBy] === 'function');

export function clampStudioParameter(parameter, raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(parameter.max, Math.max(parameter.min, value)) : fallback;
}

export function formatStudioParameter(parameter, value) {
  const decimals = String(parameter.step).includes('.') ? String(parameter.step).split('.')[1].length : 0;
  return Number(value).toFixed(decimals);
}

const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function isStudioParameterChanged(current, baseline, parameter) {
  return !sameValue(current?.[parameter.key], baseline?.[parameter.key]);
}

export function countChangedStudioParameters(current, baseline, group) {
  return studioParameters(group).filter((parameter) => isStudioParameterChanged(current, baseline, parameter)).length;
}

export function resetStudioParameter(current, baseline, parameter) {
  const value = baseline?.[parameter.key];
  return { ...current, [parameter.key]: Array.isArray(value) ? [...value] : value };
}
