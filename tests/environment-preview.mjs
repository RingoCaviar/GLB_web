import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { FloatType } from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { previewFromFloat } from '../scripts/environment-manifest-plugin.mjs';
import presets from '../src/environment-presets.generated.js';

for (const preset of presets.filter(({ url }) => url !== 'neutral')) {
  assert.ok(preset.grayscaleUrl, `${preset.label} 应提供灰度 HDRI 环境`);
}

const environmentDirectory = resolve('public/environments');
for (const file of await readdir(environmentDirectory)) {
  if (!file.endsWith('.hdr')) continue;
  const bytes = await readFile(join(environmentDirectory, file));
  const texture = new RGBELoader().setDataType(FloatType).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const maximumWidth = file.endsWith('.grayscale.hdr') ? 1024 : 2048;
  assert.ok(texture.width <= maximumWidth, `${file} 宽度应不超过 ${maximumWidth}px`);
  assert.equal(texture.height * 2, texture.width, `${file} 应保持 2:1 等距全景比例`);
}

const directory = await mkdtemp(join(tmpdir(), 'glb-hdri-preview-'));
try {
  const output = join(directory, 'preview.webp');
  const data = new Float32Array(400 * 200 * 4);
  for (let y = 0; y < 200; y += 1) {
    for (let x = 0; x < 400; x += 1) {
      const offset = (y * 400 + x) * 4;
      data[offset + (y < 100 ? 0 : 2)] = 4;
      data[offset + 3] = 1;
    }
  }
  await previewFromFloat(data, 400, 200, output);
  const image = sharp(await readFile(output));
  const metadata = await image.metadata();

  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 160);
  const { data: pixels, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const top = (10 * info.width + 160) * info.channels;
  const bottom = (150 * info.width + 160) * info.channels;
  assert.ok(pixels[top] > pixels[top + 2], 'HDR 顶部必须保持在预览图顶部');
  assert.ok(pixels[bottom + 2] > pixels[bottom], 'HDR 底部必须保持在预览图底部');

  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.environment-card-preview img\s*\{[^}]*aspect-ratio:\s*2\s*\/\s*1[^}]*object-fit:\s*contain/s);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('environment preview tests passed');
