import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { buildSequenceProducts, publicSequenceProducts, scanSequenceLibrary } from '../scripts/sequence-cache.mjs';
import {
  buildPreloadOrder,
  blendFrameState,
  horizontalDragFrame,
  manualFrameIndex,
  nextPlaybackFrame,
  smoothstep,
} from '../src/sequence-viewer.js';

const productFixture = {
  angles: [
    { angle: 5, frames: Array.from({ length: 8 }, (_, index) => ({ previewUrl: `5-${index}` })) },
    { angle: 10, frames: Array.from({ length: 3 }, (_, index) => ({ previewUrl: `10-${index}` })) },
  ],
};
const preloadOrder = buildPreloadOrder(productFixture);
assert.equal(preloadOrder.length, 11);
assert.deepEqual(preloadOrder.slice(0, 7).map((frame) => frame.previewUrl),
  ['5-0', '5-1', '5-7', '5-2', '5-6', '5-3', '5-5']);
assert.deepEqual(nextPlaybackFrame(2, 4), { index: 3, complete: false });
assert.deepEqual(nextPlaybackFrame(3, 4), { index: 3, complete: true });
assert.equal(manualFrameIndex(-1, 4, false), 0);
assert.equal(manualFrameIndex(4, 4, false), 3);
assert.equal(manualFrameIndex(-1, 4, true), 3);
assert.equal(manualFrameIndex(4, 4, true), 0);
assert.equal(horizontalDragFrame(10, 36, false), 8);
assert.equal(horizontalDragFrame(10, -36, false), 12);
assert.equal(horizontalDragFrame(10, 36, true), 12);
assert.equal(horizontalDragFrame(10, -36, true), 8);
assert.deepEqual(blendFrameState(2.25, 4, false), {
  position: 2.25, current: 2, next: 3, progress: .25, display: 2,
});
assert.deepEqual(blendFrameState(2.75, 4, false), {
  position: 2.75, current: 2, next: 3, progress: .75, display: 3,
});
assert.deepEqual(blendFrameState(3.5, 4, false), {
  position: 3, current: 3, next: 3, progress: 0, display: 3,
});
assert.deepEqual(blendFrameState(3.5, 4, true), {
  position: 3.5, current: 3, next: 0, progress: .5, display: 0,
});
assert.equal(smoothstep(0), 0);
assert.equal(smoothstep(.5), .5);
assert.equal(smoothstep(1), 1);

const root = await mkdtemp(join(tmpdir(), 'glb-sequence-'));
try {
  const product = join(root, 'image_sequence', '测试产品');
  const source = join(product, '测试产品_俯角5_0001.png');
  await mkdir(product, { recursive: true });
  await sharp({
    create: { width: 40, height: 30, channels: 4, background: '#7bd7a2' },
  }).png().toFile(source);

  let library = publicSequenceProducts(await scanSequenceLibrary(root));
  assert.equal(library.length, 1);
  assert.equal(library[0].cacheStatus, 'missing');
  assert.deepEqual(library[0].resolutions, [{ width: 40, height: 30 }]);

  const progress = [];
  const first = await buildSequenceProducts(root, ['测试产品'], 512, (value) => progress.push(value.completed));
  assert.deepEqual({ total: first.total, succeeded: first.succeeded, failed: first.failed }, { total: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(progress, [0, 1]);
  const preview = join(root, 'image_sequence', '.generated', '测试产品', '测试产品_俯角5_0001.webp');
  const metadata = await sharp(await readFile(preview)).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 40);
  assert.equal(metadata.height, 30);

  library = publicSequenceProducts(await scanSequenceLibrary(root));
  assert.equal(library[0].cacheStatus, 'ready');
  assert.equal(library[0].maxSize, 512);
  assert.match(library[0].thumbnailUrl, /^\/__sequence\/file/);

  const before = (await stat(preview)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await buildSequenceProducts(root, ['测试产品'], 1600);
  assert.ok((await stat(preview)).mtimeMs >= before);
  library = publicSequenceProducts(await scanSequenceLibrary(root));
  assert.equal(library[0].maxSize, 1600);

  await sharp({ create: { width: 24, height: 18, channels: 4, background: '#ffcc55' } }).png().toFile(source);
  library = publicSequenceProducts(await scanSequenceLibrary(root));
  assert.equal(library[0].cacheStatus, 'ready');
  assert.match(library[0].thumbnailUrl, /^\/__sequence\/file/);

  await rm(product, { recursive: true, force: true });
  library = publicSequenceProducts(await scanSequenceLibrary(root));
  assert.deepEqual(library, []);
  await assert.rejects(stat(preview), /ENOENT/);
  console.log('sequence preview tests passed');
} finally {
  sharp.cache(false);
  await rm(root, { recursive: true, force: true });
}
