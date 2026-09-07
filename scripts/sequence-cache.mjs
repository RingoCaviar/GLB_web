import { promises as fs } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';

export const CACHE_VERSION = 2;
export const DEFAULT_MAX_SIZE = 1600;
const CACHE_FILENAME = '.sequence-cache.json';
const SEQUENCE_PATTERN = /^(.*?)_俯角(-?\d+(?:\.\d+)?)_(\d+)\.png$/i;

function inside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

async function walk(directory, predicate, skipGenerated = false) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    if (skipGenerated && entry.name === '.generated') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path, predicate, skipGenerated));
    else if (entry.isFile() && predicate(entry.name)) files.push(path);
  }
  return files;
}

async function readCache(cachePath) {
  try {
    const value = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    return value && typeof value.files === 'object' ? value : { version: CACHE_VERSION, files: {} };
  } catch {
    return { version: CACHE_VERSION, files: {} };
  }
}

async function writeCache(cachePath, cache) {
  await fs.mkdir(dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, cachePath).catch(async (error) => {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await fs.rm(cachePath, { force: true });
    await fs.rename(temporary, cachePath);
  });
}

async function removeEmptyDirectories(directory, keepRoot = true) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isDirectory()) await removeEmptyDirectories(join(directory, entry.name), false);
  if (!keepRoot) await fs.rmdir(directory).catch(() => {});
}

function parseSource(sourceRoot, path) {
  const id = relative(sourceRoot, path).replaceAll('\\', '/');
  const parts = id.split('/');
  const filename = parts.pop();
  const match = filename.match(SEQUENCE_PATTERN);
  if (!match || !parts.length) return null;
  return {
    id,
    path,
    outputId: id.replace(/\.png$/i, '.webp'),
    productId: parts.join('/'),
    folderPath: parts.slice(0, -1).join('/'),
    name: parts.at(-1) || match[1],
    angle: Number(match[2]),
    index: Number(match[3]),
    filename,
  };
}

export function sequencePaths(projectRoot) {
  const sourceRoot = resolve(projectRoot, 'image_sequence');
  const outputRoot = join(sourceRoot, '.generated');
  return { sourceRoot, outputRoot, cachePath: join(outputRoot, CACHE_FILENAME) };
}

export async function scanSequenceLibrary(projectRoot, { cleanup = true } = {}) {
  const { sourceRoot, outputRoot, cachePath } = sequencePaths(projectRoot);
  await fs.mkdir(sourceRoot, { recursive: true });
  const cache = await readCache(cachePath);
  const paths = await walk(sourceRoot, (name) => extname(name).toLowerCase() === '.png', true);
  const frames = [];
  const validIds = new Set();
  const warnings = [];
  const frameKeys = new Set();
  for (const path of paths) {
    const parsed = parseSource(sourceRoot, path);
    if (!parsed) { warnings.push(`无法识别：${relative(sourceRoot, path).replaceAll('\\', '/')}`); continue; }
    const frameKey = `${parsed.productId}\0${parsed.angle}\0${parsed.index}`;
    if (frameKeys.has(frameKey)) { warnings.push(`重复帧：${parsed.productId} / ${parsed.angle}° / ${parsed.index}`); continue; }
    frameKeys.add(frameKey);
    const info = await fs.stat(path);
    let metadata;
    try { metadata = await sharp(path).metadata(); }
    catch { warnings.push(`无法读取：${parsed.id}`); metadata = {}; }
    const old = cache.files[parsed.id];
    const output = join(outputRoot, parsed.outputId);
    const outputExists = await fs.stat(output).then((item) => item.isFile()).catch(() => false);
    const cacheStatus = outputExists && old?.output === parsed.outputId ? 'ready' : 'missing';
    validIds.add(parsed.id);
    frames.push({
      ...parsed,
      size: info.size,
      mtimeMs: info.mtimeMs,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      cacheStatus,
      maxSize: old?.maxSize ?? null,
    });
  }

  let cacheChanged = false;
  if (cleanup) {
    for (const [id, entry] of Object.entries(cache.files)) {
      if (validIds.has(id)) continue;
      if (typeof entry.output === 'string') await fs.rm(join(outputRoot, entry.output), { force: true }).catch(() => {});
      delete cache.files[id];
      cacheChanged = true;
    }
    const generatedFiles = await walk(outputRoot, (name) => extname(name).toLowerCase() === '.webp');
    const referenced = new Set(Object.values(cache.files).map((entry) => resolve(outputRoot, entry.output || '')));
    for (const file of generatedFiles) if (!referenced.has(resolve(file))) await fs.rm(file, { force: true }).catch(() => {});
    await removeEmptyDirectories(outputRoot);
    if (cacheChanged || generatedFiles.some((file) => !referenced.has(resolve(file)))) {
      await writeCache(cachePath, { version: CACHE_VERSION, files: cache.files });
    }
  }

  const products = new Map();
  for (const frame of frames) {
    let product = products.get(frame.productId);
    if (!product) {
      product = { id: frame.productId, name: frame.name, folderPath: frame.folderPath, frames: [] };
      products.set(frame.productId, product);
    }
    product.frames.push(frame);
  }
  return { sourceRoot, outputRoot, cachePath, cache, products, warnings };
}

export function publicSequenceProducts(scan) {
  return [...scan.products.values()].map((product) => {
    const cacheStatus = product.frames.some((frame) => frame.cacheStatus === 'missing') ? 'missing' : 'ready';
    const angleMap = new Map();
    for (const frame of product.frames) {
      if (!angleMap.has(frame.angle)) angleMap.set(frame.angle, []);
      angleMap.get(frame.angle).push({
        index: frame.index,
        previewUrl: cacheStatus === 'ready' ? `/__sequence/file?kind=preview&id=${encodeURIComponent(frame.id)}` : null,
        originalUrl: `/__sequence/file?kind=original&id=${encodeURIComponent(frame.id)}`,
        originalFilename: frame.filename,
        width: frame.width,
        height: frame.height,
      });
    }
    const angles = [...angleMap].sort(([a], [b]) => a - b).map(([angle, items]) => ({
      angle, frames: items.sort((a, b) => a.index - b.index),
    }));
    const defaultAngle = angles.reduce((best, item) => !best || Math.abs(item.angle - 5) < Math.abs(best.angle - 5) ? item : best, null);
    return {
      id: product.id, type: 'image-sequence', name: product.name, folderPath: product.folderPath,
      angles, totalFrames: product.frames.length, cacheStatus,
      maxSize: product.frames.find((frame) => frame.maxSize)?.maxSize ?? null,
      thumbnailUrl: cacheStatus === 'ready' ? defaultAngle?.frames[0]?.previewUrl ?? null : null,
      resolutions: [...new Map(product.frames.filter((frame) => frame.width && frame.height)
        .map((frame) => [`${frame.width}x${frame.height}`, { width: frame.width, height: frame.height }])).values()],
    };
  }).sort((a, b) => a.id.localeCompare(b.id, 'zh-CN', { numeric: true }));
}

function runWorkerPool(tasks, concurrency, onResult) {
  return new Promise((resolvePool) => {
    if (!tasks.length) return resolvePool();
    let cursor = 0;
    let finished = 0;
    const workers = [];
    const dispatch = (worker) => {
      if (cursor >= tasks.length) return;
      const task = tasks[cursor++];
      worker.postMessage({ ...task, token: cursor });
      worker.current = task;
    };
    const finish = async (worker, result) => {
      const task = worker.current;
      worker.current = null;
      await onResult(task, result);
      finished++;
      if (finished === tasks.length) {
        await Promise.all(workers.map((item) => item.terminate()));
        resolvePool();
      } else dispatch(worker);
    };
    for (let index = 0; index < Math.min(concurrency, tasks.length); index++) {
      const worker = new Worker(new URL('./sequence-preview-worker.mjs', import.meta.url));
      workers.push(worker);
      worker.on('message', (result) => finish(worker, result));
      worker.on('error', (error) => { if (worker.current) finish(worker, { ok: false, error: error.message }); });
      dispatch(worker);
    }
  });
}

export async function buildSequenceProducts(projectRoot, productIds, maxSize, onProgress = () => {}) {
  if (!Number.isInteger(maxSize) || maxSize < 64 || maxSize > 8192) throw new Error('INVALID_MAX_SIZE');
  const scan = await scanSequenceLibrary(projectRoot);
  const selected = productIds.map((id) => scan.products.get(id));
  if (!productIds.length || selected.some((item) => !item)) throw new Error('INVALID_PRODUCT_ID');
  const tasks = selected.flatMap((product) => product.frames.map((frame) => ({
    frame, productId: product.id, source: frame.path, output: join(scan.outputRoot, frame.outputId), maxSize,
  })));
  const result = { total: tasks.length, completed: 0, succeeded: 0, failed: 0, currentProduct: null, errors: [] };
  const cache = await readCache(scan.cachePath);
  const concurrency = Math.max(1, Math.min(8, availableParallelism() - 1));
  onProgress({ ...result, errors: [] });
  await runWorkerPool(tasks, concurrency, async (task, workerResult) => {
    result.completed++;
    result.currentProduct = task.productId;
    if (workerResult.ok) {
      result.succeeded++;
      cache.files[task.frame.id] = {
        size: task.frame.size, mtimeMs: task.frame.mtimeMs, output: task.frame.outputId,
        maxSize, version: CACHE_VERSION,
      };
    } else {
      result.failed++;
      result.errors.push({ id: task.frame.id, error: workerResult.error });
      delete cache.files[task.frame.id];
    }
    onProgress({ ...result, errors: [...result.errors] });
  });
  await writeCache(scan.cachePath, { version: CACHE_VERSION, files: cache.files });
  return result;
}

export async function resolveSequenceAsset(projectRoot, kind, id) {
  if (!['original', 'preview'].includes(kind) || typeof id !== 'string' || id.includes('\\') || id.startsWith('/') ||
      id.split('/').some((part) => !part || part === '.' || part === '..') || extname(id).toLowerCase() !== '.png') {
    throw new Error('INVALID_ASSET_ID');
  }
  const { sourceRoot, outputRoot, cachePath } = sequencePaths(projectRoot);
  const source = resolve(sourceRoot, ...id.split('/'));
  if (!inside(sourceRoot, source)) throw new Error('INVALID_ASSET_ID');
  const sourceReal = await fs.realpath(source).catch(() => { throw new Error('INVALID_ASSET_ID'); });
  if (!inside(await fs.realpath(sourceRoot), sourceReal)) throw new Error('INVALID_ASSET_ID');
  let target = sourceReal;
  let root = sourceRoot;
  if (kind === 'preview') {
    const cache = await readCache(cachePath);
    const entry = cache.files[id];
    if (!entry || typeof entry.output !== 'string') throw new Error('CACHE_NOT_READY');
    target = resolve(outputRoot, entry.output);
    root = outputRoot;
    if (!inside(outputRoot, target)) throw new Error('INVALID_ASSET_ID');
  }
  const real = await fs.realpath(target);
  if (!inside(root, real)) throw new Error('INVALID_ASSET_ID');
  return real;
}
