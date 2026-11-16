import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { withSequenceServer } from './sequence-test-server.mjs';

const blender = process.env.BLENDER_BIN || 'blender';
const driver = fileURLToPath(new URL('./blender-sequence-render.py', import.meta.url));
const productName = '测试 产品';
const root = await mkdtemp(join(tmpdir(), 'glb-blender-sequence-'));

try {
  const projectRoot = join(root, '中文 项目');
  const sourceRoot = join(projectRoot, 'image_sequence');
  const scripts = join(projectRoot, 'scripts');
  await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, 'sequence-cache.mjs'), '');
  const render = spawnSync(blender, [
    '--background', '--factory-startup', '--threads', '2', '--python-exit-code', '1',
    '--python', driver, '--', projectRoot,
  ], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180_000,
    env: { ...process.env, BLENDER_USER_RESOURCES: join(root, 'blender-profile') },
  });
  if (render.error?.code === 'ENOENT') {
    throw new Error('请安装 Blender 5.1.2 并将 BLENDER_BIN 设为其可执行文件路径。', { cause: render.error });
  }
  if (render.error) throw render.error;
  assert.equal(render.status, 0, [render.stdout, render.stderr].filter(Boolean).join('\n'));
  assert.deepEqual((await readdir(sourceRoot)).filter((name) => name !== '.generated'), [productName]);

  await withSequenceServer(projectRoot, async (request) => {
    const library = await request('/__sequence/library');
    assert.equal(library.status, 200);
    const { products, warnings } = await library.json();
    assert.deepEqual(warnings, []);
    assert.equal(products.length, 1);
    const [product] = products;
    assert.equal(product.name, productName);
    assert.equal(product.id, productName);
    assert.equal(product.totalFrames, 8);
    assert.deepEqual(product.resolutions, [{ width: 80, height: 64 }]);
    assert.deepEqual(product.angles.map(({ angle }) => angle), [-12.5, 5.125]);

    for (const { angle, frames } of product.angles) {
      assert.deepEqual(frames.map(({ index }) => index), [1, 2, 3, 4]);
      const imageHashes = new Set();
      for (const { index, originalFilename } of frames) {
        const expectedFilename = `${productName}_俯角${angle}_${String(index).padStart(4, '0')}.png`;
        assert.equal(originalFilename, expectedFilename);
        const image = sharp(join(sourceRoot, productName, originalFilename));
        const metadata = await image.metadata();
        assert.equal(metadata.format, 'png');
        assert.equal(metadata.hasAlpha, true);
        const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
        const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
        assert.ok(Math.abs(data[center + 3] - 128) <= 1, `${originalFilename} should apply compositor opacity near its center`);
        assert.equal(data[3], 0, `${originalFilename} should have a transparent background`);
        imageHashes.add(createHash('sha256').update(data).digest('hex'));
      }
      assert.equal(imageHashes.size, 4, `Elevation ${angle} should contain four distinct views`);
    }

    const firstFrame = product.angles[1].frames[0];
    assert.equal(firstFrame.originalFilename, `${productName}_俯角5.125_0001.png`);
    for (const url of [product.thumbnailUrl, firstFrame.previewUrl]) {
      const response = await request(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/webp');
      const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.width, 80);
      assert.equal(metadata.height, 64);
      assert.equal(metadata.hasAlpha, true);
    }
    const original = await request(firstFrame.originalUrl);
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()),
      await readFile(join(sourceRoot, productName, firstFrame.originalFilename)));
    const staging = join(sourceRoot, '.generated');
    assert.deepEqual(await readdir(staging).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }), []);
  });
  console.log('Blender 360° sequence integration passed');
} finally {
  sharp.cache(false);
  await rm(root, { recursive: true, force: true });
}
