import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createLightingDefaultMiddleware } from '../scripts/lighting-default-middleware.mjs';

function request(method, path, body = '') {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(stream, {
    method,
    url: path,
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return stream;
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value = '') { this.body = value; },
  };
}

const root = await fs.mkdtemp(join(tmpdir(), 'glb-lighting-'));
try {
  const middleware = createLightingDefaultMiddleware(root);
  const savedResponse = response();
  await middleware(request('POST', '/__lighting-default/save', JSON.stringify({
    lighting: { preset: 'outdoor', exposure: 1.35, desaturate: false, normalStrength: 1.7 },
  })), savedResponse, () => assert.fail('save request unexpectedly passed through'));
  assert.equal(savedResponse.statusCode, 200, savedResponse.body);

  const disk = JSON.parse(await fs.readFile(join(root, 'config', 'default-lighting.json'), 'utf8'));
  assert.equal(disk.preset, 'outdoor');
  assert.equal(disk.exposure, 1.35);
  assert.equal(disk.desaturate, false);
  assert.equal(disk.normalStrength, 1.7);

  const readResponse = response();
  await middleware(request('GET', '/__lighting-default/current'), readResponse, () => assert.fail('read request unexpectedly passed through'));
  const current = JSON.parse(readResponse.body);
  assert.equal(current.writable, true);
  assert.deepEqual(current.lighting, disk);

  const remote = request('POST', '/__lighting-default/save', '{}');
  remote.socket = { remoteAddress: '203.0.113.1' };
  const remoteResponse = response();
  await middleware(remote, remoteResponse, () => assert.fail('remote request unexpectedly passed through'));
  assert.equal(remoteResponse.statusCode, 403);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log('lighting default middleware tests passed');
