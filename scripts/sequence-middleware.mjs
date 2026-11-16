import { createReadStream, promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { DRAG_PREVIEW_MAX_SIZE, publicSequenceProducts, resolveSequenceAsset, scanSequenceLibrary, sequenceAssetVersion } from './sequence-cache.mjs';

const MAX_PENDING_PREVIEWS = 48;
const RESERVED_DRAG_REQUESTS = 4;
const MAX_CACHED_PREVIEWS = 256;
const MIB = 1024 * 1024;
const PREVIEW_SIZES = { preview: 1600, drag: DRAG_PREVIEW_MAX_SIZE, thumbnail: 320 };

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

function createPreviewQueue(concurrency, maxBytes) {
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let bytes = 0;
  let active = 0;

  function remember(key, data) {
    if (data.length > maxBytes) return;
    cache.set(key, data);
    bytes += data.length;
    while (bytes > maxBytes || cache.size > MAX_CACHED_PREVIEWS) {
      const [oldest, buffer] = cache.entries().next().value;
      cache.delete(oldest);
      bytes -= buffer.length;
    }
  }

  async function encode(job) {
    active++;
    try {
      const maxSize = PREVIEW_SIZES[job.kind];
      const data = await sharp(job.path, { failOn: 'error' })
        .rotate()
        .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true,
          kernel: job.kind === 'drag' ? 'linear' : 'lanczos3' })
        .webp({ quality: 85, effort: 2 })
        .toBuffer();
      remember(job.key, data);
      job.resolve(data);
    } catch (error) {
      job.reject(error);
    } finally {
      active--;
      pending.delete(job.key);
      drain();
    }
  }

  function drain() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      if (job.requests.size) void encode(job);
      else {
        pending.delete(job.key);
        job.resolve(null);
      }
    }
  }

  return async (kind, path, version, response) => {
    if (response.destroyed) return null;
    const key = `${kind}\0${path}\0${version}`;
    const data = cache.get(key);
    if (data) {
      cache.delete(key);
      cache.set(key, data);
      return data;
    }

    let job = pending.get(key);
    if (!job) {
      const queueLimit = kind === 'preview' ? MAX_PENDING_PREVIEWS - RESERVED_DRAG_REQUESTS : MAX_PENDING_PREVIEWS;
      if (queue.length >= queueLimit) throw new Error('PREVIEW_BUSY');
      job = { key, kind, path, requests: new Set() };
      job.promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      pending.set(key, job);
      // Serve moving frames before queued full-size previews, without extra encoders.
      const firstRegular = kind === 'drag' ? queue.findIndex((item) => item.kind !== 'drag') : -1;
      if (firstRegular === -1) queue.push(job);
      else queue.splice(firstRegular, 0, job);
    }
    const close = () => {
      job.requests.delete(response);
      // An off-screen frame can be discarded before its conversion starts.
      const waiting = queue.indexOf(job);
      if (!job.requests.size && waiting !== -1) {
        queue.splice(waiting, 1);
        pending.delete(key);
        job.resolve(null);
      }
    };
    job.requests.add(response);
    response.once('close', close);
    drain();
    try {
      return await job.promise;
    } finally {
      response.removeListener('close', close);
      job.requests.delete(response);
    }
  };
}

export function createSequenceMiddleware(projectRoot) {
  const root = resolve(projectRoot);
  // A gallery full of thumbnails cannot occupy all preview conversion slots.
  const framePreview = createPreviewQueue(2, 48 * MIB);
  const thumbnail = createPreviewQueue(1, 8 * MIB);

  return async (request, response, next) => {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/__sequence/')) return next();
    try {
      if (url.pathname === '/__sequence/library' && request.method === 'GET') {
        const scan = await scanSequenceLibrary(root);
        return json(response, 200, { products: publicSequenceProducts(scan), warnings: scan.warnings });
      }
      if (url.pathname === '/__sequence/file' && request.method === 'GET') {
        const kind = url.searchParams.get('kind');
        const path = await resolveSequenceAsset(root, kind, url.searchParams.get('id'));
        if (response.destroyed) return;
        if (kind === 'original') {
          response.setHeader('Content-Type', 'image/png');
          response.setHeader('Cache-Control', 'public, max-age=3600');
          await pipeline(createReadStream(path), response);
          return;
        }
        const version = sequenceAssetVersion(await fs.stat(path));
        const preview = await (kind === 'thumbnail' ? thumbnail : framePreview)(kind, path, version, response);
        if (!preview || response.destroyed) return;
        response.setHeader('Content-Type', 'image/webp');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Length', preview.length);
        response.end(preview);
        return;
      }
      return json(response, 404, { error: 'SEQUENCE_ROUTE_NOT_FOUND' });
    } catch (error) {
      if (response.destroyed) return;
      if (error.message === 'INVALID_ASSET_ID') return json(response, 400, { error: 'INVALID_ASSET_ID' });
      if (error.message === 'PREVIEW_BUSY') {
        response.setHeader('Retry-After', '1');
        return json(response, 503, { error: 'PREVIEW_BUSY' });
      }
      console.warn('[360°图片]', error.message);
      return json(response, 500, { error: 'SEQUENCE_REQUEST_FAILED' });
    }
  };
}

export function sequencePlugin() {
  const install = (server) => {
    server.middlewares.use(createSequenceMiddleware(server.config.root));
  };
  return { name: 'local-sequence-preview-service', configureServer: install, configurePreviewServer: install };
}
