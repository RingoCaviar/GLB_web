import { readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [
  portArgument = '5173',
  outputLog = '.glb-viewer-output.log',
  errorLog = '.glb-viewer-error.log',
  pidFile = '.glb-viewer.pid',
  stopRequestFile = '.glb-viewer-stop-requested',
] = process.argv.slice(2);
const port = Number(portArgument);
if (!/^\d{1,5}$/.test(portArgument) || port < 1 || port > 65535) {
  throw new Error('服务端口必须是 1 到 65535 之间的整数。');
}
const projectRoot = resolve(import.meta.dirname, '..');
const pidPath = resolve(projectRoot, pidFile);
const stopRequestPath = resolve(projectRoot, stopRequestFile);
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

function stopAsAdministrator(pid) {
  const helper = resolve(projectRoot, 'scripts/stop-vite-tree.ps1').replaceAll("'", "''");
  const script = `
    try {
      $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f '${helper}'), '-Port', '${port}', '-TargetPid', '${pid}')
      $child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
      exit $child.ExitCode
    } catch {
      if ($_.Exception.GetBaseException().NativeErrorCode -eq 1223) { exit 2 }
      exit 1
    }
  `;
  console.log('普通权限无法停止当前服务，正在请求管理员权限……');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { stdio: 'ignore', windowsHide: true });
  return result.status;
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
  // The scheduled runner consumes this after Vite exits so Windows does not retry it.
  await writeFile(stopRequestPath, 'stop\r\n', 'ascii');
  const stopped = spawnSync('taskkill.exe', ['/PID', String(listener), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (stopped.status !== 0 && listeningPid() === listener) {
    const elevated = stopAsAdministrator(listener);
    if (elevated !== 0 && listeningPid() === listener) {
      await rm(stopRequestPath, { force: true });
      if (elevated === 2) throw new Error('已取消管理员授权，服务仍在运行。');
      if (elevated === 3) throw new Error(`无法确认 PID ${listener} 属于当前项目，已取消重启。`);
      throw new Error(`无法停止服务（PID ${listener}），请确认管理员授权并重试。`);
    }
  }
  if (!await waitForPort()) throw new Error(`旧服务未能释放端口 ${port}。`);
} else {
  console.log('当前服务未运行，将直接启动新服务……');
}

await rm(pidPath, { force: true });
console.log('正在启动服务……');
const started = spawnSync(process.execPath, [startHelper, String(port), outputLog, errorLog, pidFile], {
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
