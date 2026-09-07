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
  const data = new Float32Array(400 * 200 * 4).fill(0.5);
  await previewFromFloat(data, 400, 200, output);
  const metadata = await sharp(await readFile(output)).metadata();

  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 160);

  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.environment-card-preview img\s*\{[^}]*aspect-ratio:\s*2\s*\/\s*1[^}]*object-fit:\s*contain/s);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('environment preview tests passed');
