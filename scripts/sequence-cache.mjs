import { promises as fs } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';

export const DRAG_PREVIEW_MAX_SIZE = 640;
const SEQUENCE_PATTERN = /^(.*?)_俯角(-?\d+(?:\.\d+)?)_(\d+)\.png$/i;
const FILE_KINDS = new Set(['original', 'preview', 'drag', 'thumbnail']);
const isGenerated = (part) => part.toLowerCase() === '.generated';

function inside(root, target) {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    if (isGenerated(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.png') files.push(path);
  }
  return files;
}

function parseSource(sourceRoot, path) {
  const id = relative(sourceRoot, path).replaceAll(sep, '/');
  const parts = id.split('/');
  const filename = parts.pop();
  const match = filename.match(SEQUENCE_PATTERN);
  if (!match || !parts.length) return null;
  const angle = Number(match[2]);
  const index = Number(match[3]);
  if (!Number.isFinite(angle) || !Number.isSafeInteger(index)) return null;
  return { id, path, productId: parts.join('/'), folderPath: parts.slice(0, -1).join('/'), name: parts.at(-1), angle, index, filename };
}

export function sequenceAssetVersion(info) {
  return `${info.mtimeMs}-${info.ctimeMs}-${info.size}`;
}

export async function scanSequenceLibrary(projectRoot) {
  const sourceRoot = resolve(projectRoot, 'image_sequence');
  const paths = await walk(sourceRoot);
  const products = new Map();
  const warnings = [];
  const frameKeys = new Set();
  const frames = [];
  for (const path of paths) {
    const frame = parseSource(sourceRoot, path);
    if (!frame) {
      warnings.push(`无法识别：${relative(sourceRoot, path).replaceAll(sep, '/')}`);
      continue;
    }
    const frameKey = `${frame.productId}\0${frame.angle}\0${frame.index}`;
    if (frameKeys.has(frameKey)) {
      warnings.push(`重复帧：${frame.productId} / ${frame.angle}° / ${frame.index}`);
      continue;
    }
    frameKeys.add(frameKey);
    frames.push(frame);
  }

  // Only the PNG headers are needed for the library; limit simultaneous open files.
  for (let start = 0; start < frames.length; start += 8) {
    const batch = await Promise.all(frames.slice(start, start + 8).map(async (frame) => {
      const info = await fs.stat(frame.path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!info?.isFile()) return null;
      const metadata = await sharp(frame.path).metadata().catch(() => null);
      return { ...frame, version: sequenceAssetVersion(info), width: metadata?.width ?? null, height: metadata?.height ?? null };
    }));
    for (const frame of batch.filter(Boolean)) {
      if (!frame.width || !frame.height) warnings.push(`无法读取：${frame.id}`);
      if (!products.has(frame.productId)) {
        products.set(frame.productId, { id: frame.productId, name: frame.name, folderPath: frame.folderPath, frames: [] });
      }
      products.get(frame.productId).frames.push(frame);
    }
  }
  return { sourceRoot, products, warnings };
}

function assetUrl(kind, frame) {
  return `/__sequence/file?kind=${kind}&id=${encodeURIComponent(frame.id)}&v=${encodeURIComponent(frame.version)}`;
}

export function publicSequenceProducts(scan) {
  return [...scan.products.values()].map((product) => {
    const angleMap = new Map();
    for (const frame of product.frames) {
      if (!angleMap.has(frame.angle)) angleMap.set(frame.angle, []);
      angleMap.get(frame.angle).push(frame);
    }
    const ordered = [...angleMap].sort(([a], [b]) => a - b);
    const angles = ordered.map(([angle, items]) => ({
      angle,
      frames: items.sort((a, b) => a.index - b.index).map((frame) => ({
        index: frame.index, previewUrl: assetUrl('preview', frame),
        ...(Math.max(frame.width, frame.height) > DRAG_PREVIEW_MAX_SIZE && { dragUrl: assetUrl('drag', frame) }),
        originalUrl: assetUrl('original', frame),
        originalFilename: frame.filename, width: frame.width, height: frame.height,
      })),
    }));
    const defaultAngle = ordered.reduce((best, item) => !best || Math.abs(item[0] - 5) < Math.abs(best[0] - 5) ? item : best, null);
    const cover = defaultAngle?.[1].find((frame) => frame.width && frame.height) ?? defaultAngle?.[1][0];
    return {
      id: product.id, type: 'image-sequence', name: product.name, folderPath: product.folderPath,
      angles, totalFrames: product.frames.length, thumbnailUrl: cover ? assetUrl('thumbnail', cover) : null,
      resolutions: [...new Map(product.frames.filter((frame) => frame.width && frame.height)
        .map((frame) => [`${frame.width}x${frame.height}`, { width: frame.width, height: frame.height }])).values()],
    };
  }).sort((a, b) => a.id.localeCompare(b.id, 'zh-CN', { numeric: true }));
}

export async function resolveSequenceAsset(projectRoot, kind, id) {
  const parts = typeof id === 'string' ? id.split('/') : [];
  if (!FILE_KINDS.has(kind) || parts.length < 2 || !SEQUENCE_PATTERN.test(parts.at(-1)) ||
      parts.some((part) => !part || part === '.' || part === '..' || /[\\:\0]/.test(part) || isGenerated(part))) {
    throw new Error('INVALID_ASSET_ID');
  }
  const sourceRoot = resolve(projectRoot, 'image_sequence');
  const source = resolve(sourceRoot, ...parts);
  if (!inside(sourceRoot, source)) throw new Error('INVALID_ASSET_ID');
  const [root, path] = await Promise.all([fs.realpath(sourceRoot), fs.realpath(source)]).catch(() => {
    throw new Error('INVALID_ASSET_ID');
  });
  const info = await fs.stat(path).catch(() => null);
  if (!info?.isFile() || !inside(root, path) || relative(root, path).split(sep).some(isGenerated)) {
    throw new Error('INVALID_ASSET_ID');
  }
  return path;
}
