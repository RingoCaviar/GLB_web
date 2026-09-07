import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hasValidOrigin, isLocalRequest, localAddresses } from './thumbnail-middleware.mjs';
import { DEFAULT_LIGHTING, sanitizeLighting } from '../src/render-studio.js';

const MAX_BODY_BYTES = 4096;

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
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

async function readDefault(file) {
  try {
    return sanitizeLighting(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return { ...DEFAULT_LIGHTING };
  }
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

export function createLightingDefaultMiddleware(projectRoot) {
  const file = resolve(projectRoot, 'config', 'default-lighting.json');
  const addresses = localAddresses();
  return async (request, response, next) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/__lighting-default/')) return next();

    if (url.pathname === '/__lighting-default/current' && request.method === 'GET') {
      try {
        return json(response, 200, {
          lighting: await readDefault(file),
          writable: isLocalRequest(request, addresses) && hasValidOrigin(request),
        });
      } catch (error) {
        return json(response, 500, { error: error.message || 'READ_FAILED' });
      }
    }

    if (url.pathname !== '/__lighting-default/save' || request.method !== 'POST') return next();
    if (!isLocalRequest(request, addresses) || !hasValidOrigin(request)) {
      return json(response, 403, { error: 'READ_ONLY_CLIENT' });
    }

    let temporary;
    try {
      const lighting = sanitizeLighting((await readJson(request)).lighting);
      await fs.mkdir(dirname(file), { recursive: true });
      temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(lighting, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await replaceFile(temporary, file);
      temporary = null;
      return json(response, 200, { lighting });
    } catch (error) {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
      const badRequest = ['INVALID_CONTENT_TYPE', 'BODY_TOO_LARGE'].includes(error.message) || error instanceof SyntaxError;
      return json(response, badRequest ? 400 : 500, { error: error.message || 'WRITE_FAILED' });
    }
  };
}

export function lightingDefaultPlugin() {
  const install = (server) => {
    server.middlewares.use(createLightingDefaultMiddleware(server.config.root));
  };
  return { name: 'local-lighting-default-writer', configureServer: install, configurePreviewServer: install };
}
