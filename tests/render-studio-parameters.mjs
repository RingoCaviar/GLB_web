import assert from 'node:assert/strict';
import {
  clampStudioParameter, countChangedStudioParameters, formatStudioParameter,
  isStudioParameterChanged, resetStudioParameter, studioNumericParameters, studioParameter, studioParameters,
  visibleStudioParameters,
} from '../src/render-studio-parameters.js';
import { createCoalescedWriter } from '../src/coalesced-writer.js';

const exposure = studioParameter('studioExposure');
assert.equal(exposure.key, 'exposure');
assert.equal(clampStudioParameter(exposure, 99, 1), 3);
assert.equal(clampStudioParameter(exposure, 'bad', 1), 1);
assert.equal(formatStudioParameter(exposure, 1.5), '1.50');
assert.equal(studioParameters('rotation').length, 3);
assert.deepEqual(studioNumericParameters('lighting').map(({ key }) => key), ['exposure', 'shadowIntensity', 'shadowSoftness', 'normalStrength']);
assert.deepEqual(studioNumericParameters('material-basic').map(({ key }) => key), ['metallic', 'roughness', 'emissiveStrength']);
const baseline = { exposure: 1, shadowIntensity: 0.75, shadowSoftness: 0.9, normalStrength: 1 };
const current = { ...baseline, exposure: 1.5, normalStrength: 0.8 };
assert.equal(isStudioParameterChanged(current, baseline, exposure), true);
assert.equal(countChangedStudioParameters(current, baseline, 'lighting'), 2);

for (const id of ['environmentPreset', 'environmentDesaturate', 'environmentPreview', 'toneMapping']) {
  assert.ok(studioParameter(id), `${id} must be defined by the parameter module`);
}
const changedLighting = { ...baseline, preset: 'outdoor', desaturate: false, showEnvironment: false, toneMapping: 'aces' };
const defaultLighting = { ...baseline, preset: 'neutral', desaturate: true, showEnvironment: true, toneMapping: 'neutral' };
assert.equal(countChangedStudioParameters(changedLighting, defaultLighting, 'lighting'), 4);

const advanced = visibleStudioParameters('material-advanced', { setClearcoatFactor() {}, setIor() {} });
assert.deepEqual(advanced.map(({ key }) => key), ['clearcoat', 'ior']);
assert.deepEqual(resetStudioParameter({ baseColor: [0, 0, 0, 1] }, { baseColor: [1, 1, 1, 1] }, studioParameter('materialBaseColor')), { baseColor: [1, 1, 1, 1] });

let scheduled = null;
let scheduledDelay = null;
const writes = [];
const writer = createCoalescedWriter((value) => writes.push(value), 200, {
  schedule(callback, delay) { scheduled = callback; scheduledDelay = delay; return 1; },
  cancel() { scheduled = null; },
});
writer.queue('first');
writer.queue('latest');
assert.equal(scheduledDelay, 200);
assert.deepEqual(writes, []);
scheduled();
assert.deepEqual(writes, ['latest']);
writer.queue('flush-now');
writer.flush();
assert.deepEqual(writes, ['latest', 'flush-now']);
writer.queue('discard');
writer.cancel();
writer.flush();
assert.deepEqual(writes, ['latest', 'flush-now']);
console.log('render studio parameter tests passed');
