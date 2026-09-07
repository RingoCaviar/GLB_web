import { readFile, rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [
  port = '5173',
  outputLog = '.glb-viewer-output.log',
  errorLog = '.glb-viewer-error.log',
  pidFile = '.glb-viewer.pid',
] = process.argv.slice(2);
const projectRoot = resolve(import.meta.dirname, '..');
const pidPath = resolve(projectRoot, pidFile);
const startHelper = resolve(projectRoot, 'scripts/start-vite.mjs');
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

function listeningPid() {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('无法检查服务端口，请确认 netstat.exe 可用。');
  for (const line of result.stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[3] !== 'LISTENING') continue;
    const localAddress = columns[1];
    if (localAddress.endsWith(`:${port}`)) return Number(columns[4]);
  }
  return null;
}

async function recordedPid() {
  try {
    const value = Number((await readFile(pidPath, 'ascii')).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function waitForPort(expectedPid = null, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const listener = listeningPid();
    if (expectedPid === null ? listener === null : listener === expectedPid) return true;
    await wait(80);
  }
  return false;
}

function printAddresses() {
  console.log(`\n本机访问：http://localhost:${port}/`);
  for (const entries of Object.values(networkInterfaces())) {
    for (const address of entries ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`局域网访问：http://${address.address}:${port}/`);
      }
    }
  }
}

const listener = listeningPid();
const recorded = await recordedPid();
if (listener !== null) {
  if (recorded !== listener) {
    throw new Error(`端口 ${port} 正被未识别进程占用（PID ${listener}），为避免误杀已取消重启。`);
  }
  console.log(`正在停止当前服务（PID ${listener}）……`);
  const stopped = spawnSync('taskkill.exe', ['/PID', String(listener), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (stopped.status !== 0 && listeningPid() !== null) {
    throw new Error(`无法停止当前服务：${stopped.stderr.trim() || stopped.stdout.trim()}`);
  }
  if (!await waitForPort()) throw new Error(`旧服务未能释放端口 ${port}。`);
} else {
  console.log('当前服务未运行，将直接启动新服务……');
}

await rm(pidPath, { force: true });
console.log('正在检查 360° 预览资源并重新启动服务……');
const started = spawnSync(process.execPath, [startHelper, port, outputLog, errorLog, pidFile], {
  cwd: projectRoot,
  encoding: 'utf8',
  windowsHide: true,
});
if (started.status !== 0) {
  throw new Error(started.stderr.trim() || started.stdout.trim() || '启动辅助程序执行失败。');
}

const nextPid = await recordedPid();
if (!nextPid || !await waitForPort(nextPid)) {
  let details = '';
  try { details = (await readFile(resolve(projectRoot, errorLog), 'utf8')).trim(); } catch { /* no log */ }
  throw new Error(details || `新服务未能在端口 ${port} 上启动。`);
}

console.log(`服务重启成功（PID ${nextPid}）。`);
printAddresses();
