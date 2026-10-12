import assert from 'node:assert/strict';
import { ExportQualityMode } from '../src/export-quality.js';
import { ExportOptions } from '../src/export-options.js';

function storage(initial = null) {
  const values = new Map(initial ? [['glb-viewer:export-quality:v1', initial]] : []);
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, next) => { values.set(key, next); } };
}

const savedStorage = storage();
const options = new ExportOptions({ maximumDimension: 2048, storage: savedStorage });
assert.equal(options.setOption('width', 4096).width, 2048);
assert.equal(options.setOption('width', 'invalid').width, 2048);
assert.equal(options.setOption('height', 32).height, 64);

let snapshot = options.setOption('exportQuality', ExportQualityMode.HIGH);
assert.equal(snapshot.textureDetailMode, 'base-level');
snapshot = options.setOption('textureDetailMode', 'adaptive');
assert.equal(snapshot.textureDetailMode, 'adaptive');
const restored = new ExportOptions({ maximumDimension: 2048, storage: savedStorage });
assert.equal(restored.getSnapshot().textureDetailMode, 'adaptive');

snapshot = options.setOption('preserveShadow', true);
assert.equal(snapshot.preserveShadow, false);
snapshot = options.setOption('transparent', true);
snapshot = options.setOption('preserveShadow', true);
assert.equal(snapshot.preserveShadow, true);
snapshot = options.setOption('transparent', false);
assert.equal(snapshot.preserveShadow, false);

const plan = options.getExportPlan();
assert.equal(plan.antiAlias, 'fxaa');
assert.equal(plan.background, undefined);

console.log('export options tests passed');
