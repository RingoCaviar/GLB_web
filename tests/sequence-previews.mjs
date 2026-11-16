import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { withSequenceServer } from './sequence-test-server.mjs';
import { checkSequenceViewer } from './sequence-viewer.mjs';

const root = await mkdtemp(join(tmpdir(), 'glb-sequence-'));
try {
  const sourceRoot = join(root, 'image_sequence');
  const product = join(sourceRoot, '系列', '测试产品');
  const filename = '测试产品_俯角5_0001.png';
  const source = join(product, filename);
  const original = await sharp({
    create: { width: 2400, height: 1200, channels: 4, background: '#7bd7a280' },
  }).png().toBuffer();
  await mkdir(product, { recursive: true });
  await writeFile(source, original);

  await withSequenceServer(root, async (request) => {
    async function library() {
      const response = await request('/__sequence/library');
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.deepEqual(data.warnings, []);
      return data.products;
    }

    const [item] = await library();
    assert.equal(item.id, '系列/测试产品');
    assert.equal(item.totalFrames, 1);
    assert.deepEqual(item.resolutions, [{ width: 2400, height: 1200 }]);
    const [frame] = item.angles[0].frames;
    assert.equal(frame.originalFilename, filename);
    assert.match(frame.previewUrl, /^\/__sequence\/file\?/);
    const dragParams = new URL(frame.dragUrl, 'http://localhost').searchParams;
    assert.equal(dragParams.get('kind'), 'drag');
    assert.equal(dragParams.get('v'), new URL(frame.previewUrl, 'http://localhost').searchParams.get('v'));

    for (const [url, width, height] of [
      [item.thumbnailUrl, 320, 160], [frame.dragUrl, 640, 320], [frame.previewUrl, 1600, 800],
    ]) {
      const response = await request(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/webp');
      assert.match(response.headers.get('cache-control'), /\bno-store\b/);
      const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      assert.equal(metadata.width, width);
      assert.equal(metadata.height, height);
      assert.equal(metadata.hasAlpha, true);
    }
    const download = await request(frame.originalUrl);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
    assert.deepEqual(await readdir(sourceRoot), ['系列']);
    assert.deepEqual(await readdir(product), [filename]);
    assert.equal((await request('/__sequence/job', { method: 'POST' })).status, 404);

    const staging = join(sourceRoot, '.generated', '.blender-orbit-test');
    await mkdir(staging, { recursive: true });
    const stagedFrame = join(staging, filename);
    const legacy = join(sourceRoot, '.generated', 'old.webp');
    await writeFile(stagedFrame, original);
    await writeFile(legacy, 'existing local cache');
    await sharp({ create: { width: 24, height: 18, channels: 4, background: '#ffcc55' } }).png().toFile(source);
    const [updated] = await library();
    assert.deepEqual(updated.resolutions, [{ width: 24, height: 18 }]);
    const nextFrame = updated.angles[0].frames[0];
    assert.notEqual(nextFrame.previewUrl, frame.previewUrl);
    assert.equal(nextFrame.dragUrl, undefined);
    const newImage = await request(nextFrame.previewUrl);
    assert.equal(newImage.status, 200);
    const updatedMeta = await sharp(Buffer.from(await newImage.arrayBuffer())).metadata();
    assert.deepEqual([updatedMeta.width, updatedMeta.height], [24, 18]);

    const rejected = new URLSearchParams({ kind: 'preview', id: `.generated/.blender-orbit-test/${filename}` });
    const rejectedResponse = await request(`/__sequence/file?${rejected}`);
    assert.ok([400, 404].includes(rejectedResponse.status));
    await rm(product, { recursive: true, force: true });
    assert.deepEqual(await library(), []);
    assert.deepEqual(await readFile(stagedFrame), original);
    assert.equal(await readFile(legacy, 'utf8'), 'existing local cache');
  });
  await checkSequenceViewer();
  console.log('sequence preview tests passed');
} finally {
  sharp.cache(false);
  await rm(root, { recursive: true, force: true });
}
