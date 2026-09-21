import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const [
  port = '5173',
  outputLog = '.glb-viewer-output.log',
  errorLog = '.glb-viewer-error.log',
  pidFile = '.glb-viewer.pid',
  stopRequestFile = '.glb-viewer-stop-requested',
] = process.argv.slice(2);
const projectRoot = resolve(import.meta.dirname, '..');
const viteCli = resolve(projectRoot, 'node_modules/vite/bin/vite.js');
const pidPath = resolve(projectRoot, pidFile);
const stopRequestPath = resolve(projectRoot, stopRequestFile);

function appendError(message) {
  const handle = openSync(resolve(projectRoot, errorLog), 'a');
  try {
    writeFileSync(handle, `[${new Date().toISOString()}] ${message}\r\n`, 'utf8');
  } finally {
    closeSync(handle);
  }
}

function assertPortAvailable() {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (error) => reject(error));
    probe.listen(Number(port), '0.0.0.0', () => probe.close(resolvePromise));
  });
}

function removeOwnedPid(expectedPid) {
  if (!existsSync(pidPath)) return;
  const recordedPid = readFileSync(pidPath, 'ascii').trim();
  if (recordedPid === String(expectedPid)) unlinkSync(pidPath);
}

function consumeStopRequest() {
  if (!existsSync(stopRequestPath)) return false;
  unlinkSync(stopRequestPath);
  return true;
}

// A stale request can remain when a manually started instance was stopped.
consumeStopRequest();

try {
  await assertPortAvailable();
} catch (error) {
  appendError(`计划任务未启动：端口 ${port} 已被占用（${error.code ?? error.message}）。`);
  process.exit(2);
}

const stdout = openSync(resolve(projectRoot, outputLog), 'a');
const stderr = openSync(resolve(projectRoot, errorLog), 'a');
let child;

try {
  child = spawn(process.execPath, [viteCli, '--host', '0.0.0.0', '--port', port, '--strictPort'], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
  });
} finally {
  closeSync(stdout);
  closeSync(stderr);
}

const forwardSignal = (signal) => {
  if (child && !child.killed) child.kill(signal);
};
process.once('SIGINT', () => forwardSignal('SIGINT'));
process.once('SIGTERM', () => forwardSignal('SIGTERM'));

child.once('spawn', () => {
  writeFileSync(pidPath, `${child.pid}\r\n`, 'ascii');
});

child.once('error', (error) => {
  appendError(`计划任务启动 Vite 失败：${error.message}`);
  if (child.pid) removeOwnedPid(child.pid);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  removeOwnedPid(child.pid);
  process.exitCode = consumeStopRequest() ? 0 : (code ?? (signal ? 1 : 0));
});
