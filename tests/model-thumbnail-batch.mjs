import assert from 'node:assert/strict';
import { modelsInFolder, runThumbnailBatch } from '../src/model-thumbnail-batch.js';

const models = [
  { id: 'a/one.glb', folderPath: 'a' },
  { id: 'a/deep/two.glb', folderPath: 'a/deep' },
  { id: 'ab/three.glb', folderPath: 'ab' },
];

assert.deepEqual(modelsInFolder(models, 'a').map(({ id }) => id), ['a/one.glb', 'a/deep/two.glb']);

{
  const calls = [];
  const result = await runThumbnailBatch(models, async (model) => {
    calls.push(model.id);
    if (model.id === 'a/deep/two.glb') throw new Error('bad material');
    if (model.id === 'ab/three.glb') return { status: 'skipped', reason: '未选择外观' };
    return { status: 'success' };
  });
  assert.deepEqual(calls, models.map(({ id }) => id), '必须按顺序串行执行');
  assert.deepEqual(result.successIds, ['a/one.glb']);
  assert.deepEqual(result.skippedIds, ['ab/three.glb']);
  assert.deepEqual(result.failedIds, ['a/deep/two.glb']);
}

{
  const result = await runThumbnailBatch([models[0]], async () => ({ status: 'unchanged' }));
  assert.deepEqual(result.unchangedIds, ['a/one.glb']);
  assert.deepEqual(result.skippedIds, []);
}

{
  let stopped = false;
  const result = await runThumbnailBatch(models, async () => {
    stopped = true;
    return { status: 'success' };
  }, { shouldStop: () => stopped });
  assert.equal(result.stopped, true);
  assert.deepEqual(result.successIds, ['a/one.glb']);
  assert.deepEqual(result.pendingIds, ['a/deep/two.glb', 'ab/three.glb']);
}

console.log('批量封面生成测试通过');
