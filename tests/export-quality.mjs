import assert from 'node:assert/strict';
import {
  EXPORT_QUALITY_STORAGE_KEY,
  ExportQualityMode,
  loadExportQuality,
  resolveExportScale,
  saveExportQuality,
} from '../src/export-quality.js';

assert.deepEqual(resolveExportScale({ width: 1024, height: 512, mode: ExportQualityMode.STANDARD, maximumDimension: 4096 }), {
  scale: 1, requestedScale: 1, downgraded: false, renderWidth: 1024, renderHeight: 512,
});
assert.deepEqual(resolveExportScale({ width: 1024, height: 512, mode: ExportQualityMode.HIGH, maximumDimension: 4096 }), {
  scale: 2, requestedScale: 2, downgraded: false, renderWidth: 2048, renderHeight: 1024,
});
assert.deepEqual(resolveExportScale({ width: 4096, height: 2048, mode: ExportQualityMode.HIGH, maximumDimension: 6000 }), {
  scale: 6000 / 4096, requestedScale: 2, downgraded: true, renderWidth: 6000, renderHeight: 3000,
});
assert.throws(() => resolveExportScale({ width: 0, height: 1 }), /INVALID_EXPORT_DIMENSIONS/);

const values = new Map();
const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
assert.equal(loadExportQuality(storage), ExportQualityMode.STANDARD);
assert.equal(saveExportQuality(ExportQualityMode.HIGH, storage), ExportQualityMode.HIGH);
assert.equal(values.get(EXPORT_QUALITY_STORAGE_KEY), ExportQualityMode.HIGH);
assert.equal(loadExportQuality(storage), ExportQualityMode.HIGH);

console.log('export quality tests passed');
