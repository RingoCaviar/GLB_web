import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FloatType } from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

const environmentRoot = resolve(process.cwd(), 'public/environments');

function usage() {
  console.log('Usage: node scripts/preprocess-environments.mjs --size <1024|2048>');
}

function parseSize(argumentsList) {
  const index = argumentsList.indexOf('--size');
  const value = Number(argumentsList[index + 1]);
  if (index < 0 || ![1024, 2048].includes(value)) throw new Error('INVALID_SIZE');
  return value;
}

function pixelToRgbe(data, offset) {
  const red = Math.max(0, data[offset]); const green = Math.max(0, data[offset + 1]); const blue = Math.max(0, data[offset + 2]);
  const maximum = Math.max(red, green, blue);
  if (maximum < 1e-32) return [0, 0, 0, 0];
  const exponent = Math.floor(Math.log2(maximum)) + 1;
  const scale = 256 / (2 ** exponent);
  return [Math.min(255, Math.round(red * scale)), Math.min(255, Math.round(green * scale)), Math.min(255, Math.round(blue * scale)), exponent + 128];
}

function encodeChannel(values) {
  const output = [];
  for (let index = 0; index < values.length;) {
    let run = 1;
    while (index + run < values.length && values[index + run] === values[index] && run < 127) run += 1;
    if (run >= 4) { output.push(128 + run, values[index]); index += run; continue; }
    const start = index;
    index += run;
    while (index < values.length) {
      run = 1;
      while (index + run < values.length && values[index + run] === values[index] && run < 127) run += 1;
      if (run >= 4 || index - start + run > 128) break;
      index += run;
    }
    output.push(index - start, ...values.slice(start, index));
  }
  return output;
}

export function encodeHdr(data, width, height) {
  const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'ascii');
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const channels = [[], [], [], []];
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelToRgbe(data, (y * width + x) * 4);
      for (let channel = 0; channel < 4; channel += 1) channels[channel].push(pixel[channel]);
    }
    rows.push(Buffer.from([2, 2, width >> 8, width & 255]));
    for (const channel of channels) rows.push(Buffer.from(encodeChannel(channel)));
  }
  return Buffer.concat([header, ...rows]);
}

export function resizeFloat(data, width, height, targetWidth) {
  const targetHeight = Math.max(1, Math.round(height * targetWidth / width));
  if (width === targetWidth && height === targetHeight) return { data, width, height };
  const output = new Float32Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.max(0, Math.min(height - 1, (y + .5) * height / targetHeight - .5));
    const y0 = Math.floor(sourceY); const y1 = Math.min(height - 1, y0 + 1); const fy = sourceY - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = (x + .5) * width / targetWidth - .5; const floorX = Math.floor(sourceX); const x0 = (floorX + width) % width; const x1 = (x0 + 1) % width; const fx = sourceX - floorX;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = data[(y0 * width + x0) * 4 + channel] * (1 - fx) + data[(y0 * width + x1) * 4 + channel] * fx;
        const bottom = data[(y1 * width + x0) * 4 + channel] * (1 - fx) + data[(y1 * width + x1) * 4 + channel] * fx;
        output[(y * targetWidth + x) * 4 + channel] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return { data: output, width: targetWidth, height: targetHeight };
}

export function grayscaleFloat(data) {
  const output = new Float32Array(data.length);
  for (let index = 0; index < data.length; index += 4) {
    const luminance = data[index] * .2126 + data[index + 1] * .7152 + data[index + 2] * .0722;
    output[index] = output[index + 1] = output[index + 2] = luminance;
    output[index + 3] = data[index + 3];
  }
  return output;
}

async function writeAtomically(path, bytes) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function preprocessFile(file, colorWidth) {
  const extension = extname(file).toLowerCase(); const stem = basename(file, extension);
  const source = resolve(environmentRoot, file); const colorOutput = resolve(environmentRoot, `${stem}.hdr`); const grayscaleOutput = resolve(environmentRoot, `${stem}.grayscale.hdr`);
  if (extension === '.exr' && colorOutput !== source) {
    try { await readFile(colorOutput); throw new Error(`OUTPUT_EXISTS:${colorOutput}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const sourceBytes = await readFile(source); const buffer = sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength);
  const texture = extension === '.exr' ? new EXRLoader().setDataType(FloatType).parse(buffer) : new RGBELoader().setDataType(FloatType).parse(buffer);
  const color = resizeFloat(texture.data, texture.width, texture.height, colorWidth);
  const grayscale = resizeFloat(color.data, color.width, color.height, Math.min(1024, colorWidth));
  await writeAtomically(colorOutput, encodeHdr(color.data, color.width, color.height));
  await writeAtomically(grayscaleOutput, encodeHdr(grayscaleFloat(grayscale.data), grayscale.width, grayscale.height));
  if (extension === '.exr') await unlink(source);
  console.log(`${file} -> ${basename(colorOutput)} (${color.width}x${color.height}), ${basename(grayscaleOutput)} (${grayscale.width}x${grayscale.height})`);
}

async function main() {
  if (process.argv.includes('--help')) { usage(); return; }
  const colorWidth = parseSize(process.argv.slice(2));
  const files = (await readdir(environmentRoot)).filter((file) => /\.(hdr|exr)$/i.test(file) && !/\.grayscale\.hdr$/i.test(file));
  if (!files.length) { console.log('未找到需要处理的 HDR 或 EXR 环境贴图。'); return; }
  for (const file of files.sort((left, right) => left.localeCompare(right))) await preprocessFile(file, colorWidth);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
