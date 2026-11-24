import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  decodeThumbnail,
  createThumbnailMiddleware,
  hasValidOrigin,
  isLocalRequest,
  localAddresses,
  readWebpDimensions,
  resolveModelTarget,
} from '../scripts/thumbnail-middleware.mjs';

function vp8xWebp(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

const image = vp8xWebp(640, 480);
assert.deepEqual(readWebpDimensions(image), { width: 640, height: 480 });
assert.equal(decodeThumbnail(`data:image/webp;base64,${image.toString('base64')}`).length, image.length);
assert.throws(() => decodeThumbnail(`data:image/webp;base64,${vp8xWebp(641, 480).toString('base64')}`), /INVALID_IMAGE_SIZE/);
assert.throws(() => decodeThumbnail('data:image/png;base64,AAAA'), /INVALID_IMAGE/);

const addresses = localAddresses({ Ethernet: [{ address: '192.168.1.10' }] });
assert.equal(isLocalRequest({ socket: { remoteAddress: '::ffff:192.168.1.10' } }, addresses), true);
assert.equal(isLocalRequest({ socket: { remoteAddress: '192.168.1.99' } }, addresses), false);
assert.equal(hasValidOrigin({ method: 'POST', headers: { origin: 'http://localhost:5173', host: 'localhost:5173' } }), true);
assert.equal(hasValidOrigin({ method: 'POST', headers: { origin: 'http://attacker.test', host: 'localhost:5173' } }), false);
assert.equal(hasValidOrigin({ method: 'POST', headers: { host: 'localhost:5173' } }), false);

const root = await fs.mkdtemp(join(tmpdir(), 'glb-thumbnail-test-'));
const modelsRoot = join(root, 'models');
await fs.mkdir(join(modelsRoot, '中文 文件夹', '子目录'), { recursive: true });
await fs.writeFile(join(modelsRoot, '中文 文件夹', '子目录', '模型.glb'), 'glb');
try {
  const target = await resolveModelTarget(modelsRoot, '中文 文件夹/子目录/模型.glb');
  assert.equal(target.filename, '模型.cover.webp');
  for (const invalid of [
    '../模型.glb', '/模型.glb', 'C:/模型.glb', '中文 文件夹\\模型.glb',
    '中文 文件夹//模型.glb', '中文 文件夹/模型.png', '',
  ]) {
    await assert.rejects(resolveModelTarget(modelsRoot, invalid));
  }
  await assert.rejects(resolveModelTarget(modelsRoot, '中文 文件夹/不存在.glb'));

  const middleware = createThumbnailMiddleware(root);
  const server = createServer((request, response) => {
    Object.defineProperty(request.socket, 'remoteAddress', { value: '192.168.1.99' });
    middleware(request, response, () => { response.statusCode = 404; response.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const capability = await fetch(`${base}/__thumbnail/capability`);
    assert.deepEqual(await capability.json(), { writable: true });
    const save = await fetch(`${base}/__thumbnail/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ modelId: '中文 文件夹/子目录/模型.glb', dataUrl: `data:image/webp;base64,${image.toString('base64')}` }),
    });
    assert.equal(save.status, 200, '局域网访问者应能生成模型封面');
    assert.deepEqual(await fs.readFile(target.thumbnailPath), image);
    const rejected = await fetch(`${base}/__thumbnail/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.test' },
      body: JSON.stringify({ modelId: '中文 文件夹/子目录/模型.glb', dataUrl: `data:image/webp;base64,${image.toString('base64')}` }),
    });
    assert.equal(rejected.status, 403, '跨来源写入仍应拒绝');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log('缩略图中间件测试通过：局域网写入、WebP 尺寸、路径边界和 Origin 校验均符合预期。');
