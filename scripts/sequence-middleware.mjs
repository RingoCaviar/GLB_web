import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { buildSequenceProducts, publicSequenceProducts, resolveSequenceAsset, scanSequenceLibrary } from './sequence-cache.mjs';
import { hasValidOrigin, isLocalRequest, localAddresses } from './thumbnail-middleware.mjs';

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  if (!String(request.headers['content-type']).toLowerCase().startsWith('application/json')) throw new Error('INVALID_CONTENT_TYPE');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createSequenceMiddleware(projectRoot) {
  const root = resolve(projectRoot);
  const addresses = localAddresses();
  let activeJob = null;
  return async (request, response, next) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/__sequence/')) return next();
    try {
      if (url.pathname === '/__sequence/library' && request.method === 'GET') {
        const scan = await scanSequenceLibrary(root);
        return json(response, 200, { products: publicSequenceProducts(scan), warnings: scan.warnings,
          writable: isLocalRequest(request, addresses) && hasValidOrigin(request) });
      }
      if (url.pathname === '/__sequence/file' && request.method === 'GET') {
        const kind = url.searchParams.get('kind');
        const path = await resolveSequenceAsset(root, kind, url.searchParams.get('id'));
        response.statusCode = 200;
        response.setHeader('Content-Type', kind === 'preview' ? 'image/webp' : 'image/png');
        response.setHeader('Cache-Control', kind === 'preview' ? 'no-cache' : 'public, max-age=3600');
        return fs.readFile(path).then((data) => response.end(data));
      }
      if (url.pathname === '/__sequence/job' && request.method === 'GET') {
        return json(response, 200, activeJob ?? { status: 'idle' });
      }
      if (url.pathname === '/__sequence/job' && request.method === 'POST') {
        if (!isLocalRequest(request, addresses) || !hasValidOrigin(request)) return json(response, 403, { error: 'READ_ONLY_CLIENT' });
        if (activeJob?.status === 'running') return json(response, 409, { error: 'JOB_RUNNING', job: activeJob });
        const body = await readJson(request);
        if (!Array.isArray(body.productIds) || body.productIds.some((id) => typeof id !== 'string')) throw new Error('INVALID_PRODUCT_ID');
        activeJob = { id: `${Date.now()}-${process.pid}`, status: 'running', total: 0, completed: 0, succeeded: 0, failed: 0,
          currentProduct: null, errors: [], startedAt: new Date().toISOString() };
        const job = activeJob;
        buildSequenceProducts(root, [...new Set(body.productIds)], Number(body.maxSize), (progress) => Object.assign(job, progress))
          .then((result) => Object.assign(job, result, { status: result.failed ? 'completed_with_errors' : 'completed', finishedAt: new Date().toISOString() }))
          .catch((error) => Object.assign(job, { status: 'failed', error: error.message || 'BUILD_FAILED', finishedAt: new Date().toISOString() }));
        return json(response, 202, job);
      }
      return next();
    } catch (error) {
      const badRequest = new Set(['INVALID_CONTENT_TYPE', 'BODY_TOO_LARGE', 'INVALID_PRODUCT_ID', 'INVALID_MAX_SIZE', 'INVALID_ASSET_ID', 'CACHE_NOT_READY']).has(error.message) || error instanceof SyntaxError;
      return json(response, badRequest ? 400 : 500, { error: error.message || 'SEQUENCE_REQUEST_FAILED' });
    }
  };
}

export function sequencePlugin() {
  const install = (server) => {
    server.middlewares.use(createSequenceMiddleware(server.config.root));
  };
  return { name: 'local-sequence-preview-service', configureServer: install, configurePreviewServer: install };
}
