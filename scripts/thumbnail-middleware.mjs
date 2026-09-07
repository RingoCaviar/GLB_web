import { promises as fs } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';

export const THUMBNAIL_WIDTH = 640;
export const THUMBNAIL_HEIGHT = 480;
export const MAX_BODY_BYTES = 3 * 1024 * 1024;

function normalizeAddress(address = '') {
  return address.replace(/^::ffff:/, '').split('%')[0];
}

export function localAddresses(interfaces = networkInterfaces()) {
  const addresses = new Set(['127.0.0.1', '::1']);
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) addresses.add(normalizeAddress(entry.address));
  }
  return addresses;
}

export function isLocalRequest(request, addresses = localAddresses()) {
  return addresses.has(normalizeAddress(request.socket?.remoteAddress));
}

export function hasValidOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return request.method === 'GET';
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function isInside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

export async function resolveModelTarget(modelsRoot, modelId) {
  if (typeof modelId !== 'string' || !modelId || modelId.includes('\\') ||
      modelId.startsWith('/') || modelId.split('/').some((part) => !part || part === '.' || part === '..') ||
      extname(modelId).toLowerCase() !== '.glb') {
    throw new Error('INVALID_MODEL_ID');
  }
  const root = await fs.realpath(modelsRoot);
  const requestedModel = resolve(root, ...modelId.split('/'));
  if (!isInside(root, requestedModel)) throw new Error('INVALID_MODEL_ID');
  let modelPath;
  try {
    modelPath = await fs.realpath(requestedModel);
  } catch {
    throw new Error('INVALID_MODEL_ID');
  }
  if (!isInside(root, modelPath)) throw new Error('INVALID_MODEL_ID');
  const modelName = basename(modelPath, extname(modelPath));
  const thumbnailPath = resolve(dirname(modelPath), `${modelName}.cover.webp`);
  if (!isInside(root, thumbnailPath)) throw new Error('INVALID_MODEL_ID');
  try {
    const existing = await fs.lstat(thumbnailPath);
    if (existing.isSymbolicLink()) throw new Error('UNSAFE_THUMBNAIL_TARGET');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { root, modelPath, thumbnailPath, filename: basename(thumbnailPath) };
}

export function readWebpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const format = buffer.toString('ascii', 12, 16);
  if (format === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (format === 'VP8 ' && buffer.length >= 30 && buffer.toString('hex', 23, 26) === '9d012a') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    return {
      width: 1 + buffer[21] + ((buffer[22] & 0x3f) << 8),
      height: 1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10),
    };
  }
  return null;
}

export function decodeThumbnail(dataUrl) {
  const match = /^data:image\/webp;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? '');
  if (!match) throw new Error('INVALID_IMAGE');
  const buffer = Buffer.from(match[1], 'base64');
  const dimensions = readWebpDimensions(buffer);
  if (!dimensions || dimensions.width !== THUMBNAIL_WIDTH || dimensions.height !== THUMBNAIL_HEIGHT) {
    throw new Error('INVALID_IMAGE_SIZE');
  }
  return buffer;
}

async function readJson(request) {
  if (!String(request.headers['content-type']).toLowerCase().startsWith('application/json')) {
    throw new Error('INVALID_CONTENT_TYPE');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

async function replaceFile(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await fs.unlink(destination);
    await fs.rename(source, destination);
  }
}

export function createThumbnailMiddleware(projectRoot, suppressedHotUpdates = new Set()) {
  const modelsRoot = resolve(projectRoot, 'models');
  const addresses = localAddresses();
  return async (request, response, next) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/__thumbnail/')) return next();

    if (url.pathname === '/__thumbnail/capability' && request.method === 'GET') {
      return json(response, 200, { writable: isLocalRequest(request, addresses) && hasValidOrigin(request) });
    }

    if (url.pathname === '/__thumbnail/file' && request.method === 'GET') {
      try {
        const target = await resolveModelTarget(modelsRoot, url.searchParams.get('modelId'));
        const image = await fs.readFile(target.thumbnailPath);
        response.statusCode = 200;
        response.setHeader('Content-Type', 'image/webp');
        response.setHeader('Cache-Control', 'no-cache');
        return response.end(image);
      } catch {
        response.statusCode = 404;
        return response.end();
      }
    }

    if (url.pathname !== '/__thumbnail/save' || request.method !== 'POST') return next();
    if (!isLocalRequest(request, addresses) || !hasValidOrigin(request)) {
      return json(response, 403, { error: 'READ_ONLY_CLIENT' });
    }

    let tempPath;
    let suppressedPath;
    try {
      const body = await readJson(request);
      const target = await resolveModelTarget(modelsRoot, body.modelId);
      const image = decodeThumbnail(body.dataUrl);
      tempPath = `${target.thumbnailPath}.${process.pid}.${Date.now()}.tmp`;
      suppressedPath = resolve(target.thumbnailPath);
      suppressedHotUpdates.add(suppressedPath);
      await fs.writeFile(tempPath, image, { flag: 'wx' });
      await replaceFile(tempPath, target.thumbnailPath);
      tempPath = null;
      const version = Date.now();
      setTimeout(() => suppressedHotUpdates.delete(suppressedPath), 5000).unref?.();
      return json(response, 200, {
        filename: target.filename,
        thumbnailUrl: `/__thumbnail/file?modelId=${encodeURIComponent(body.modelId)}&v=${version}`,
        updatedAt: new Date(version).toISOString(),
      });
    } catch (error) {
      if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => {});
      if (suppressedPath) suppressedHotUpdates.delete(suppressedPath);
      const clientErrors = new Set([
        'INVALID_MODEL_ID', 'UNSAFE_THUMBNAIL_TARGET', 'INVALID_IMAGE', 'INVALID_IMAGE_SIZE',
        'INVALID_CONTENT_TYPE', 'BODY_TOO_LARGE',
      ]);
      const badRequest = clientErrors.has(error.message) || error instanceof SyntaxError;
      return json(response, badRequest ? 400 : 500, { error: error.message || 'WRITE_FAILED' });
    }
  };
}

export function thumbnailPlugin() {
  const suppressedHotUpdates = new Set();
  const install = (server) => {
    server.middlewares.use(createThumbnailMiddleware(server.config.root, suppressedHotUpdates));
  };
  return {
    name: 'local-model-thumbnail-writer',
    configureServer: install,
    configurePreviewServer: install,
    handleHotUpdate(context) {
      const file = resolve(context.file);
      if (!suppressedHotUpdates.has(file)) return;
      suppressedHotUpdates.delete(file);
      return [];
    },
  };
}
