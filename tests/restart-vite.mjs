import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('restarts a recorded Vite service when taskkill requires administrator rights', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'glb restart '));
  const rootScripts = new URL('../scripts/', import.meta.url);
  const pidFile = join(root, 'service.pid');
  const stopFile = join(root, 'stop-requested');
  let original;

  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'node_modules/vite/bin'), { recursive: true });
    for (const name of ['start-vite.mjs', 'restart-vite.mjs', 'stop-vite-tree.ps1']) {
      await copyFile(new URL(name, rootScripts), join(root, 'scripts', name));
    }
    const vite = join(root, 'node_modules/vite/bin/vite.js');
    await writeFile(vite, `
      const server = require('node:http').createServer((request, response) => {
        response.end(String(process.pid));
      });
      const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
      server.listen(port, '127.0.0.1', () => console.log(server.address().port));
    `);

    const preload = join(root, 'simulate-access-denied.mjs');
    await writeFile(preload, `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';

      const run = childProcess.spawnSync;
      childProcess.spawnSync = (command, args, options) => {
        if (command === 'taskkill.exe' && process.env.GLB_RESTART_TEST_MODE !== 'normal') {
          return run(process.execPath, ['-e', 'process.stderr.write(Buffer.from([0xbe, 0xdc])); process.exit(128)'], options);
        }
        if (command === 'powershell.exe' && args.includes('-EncodedCommand')) {
          const index = args.indexOf('-EncodedCommand') + 1;
          const script = Buffer.from(args[index], 'base64').toString('utf16le');
          if (!script.includes('-Verb RunAs')) throw new Error('Expected the Windows elevation request');
          if (process.env.GLB_RESTART_TEST_MODE === 'cancel') {
            return run(process.execPath, ['-e', 'process.exit(2)'], options);
          }
          // Exercise the real stop script on a process owned by the test account.
          args[index] = Buffer.from(script.replace('-Verb RunAs', ''), 'utf16le').toString('base64');
        }
        return run(command, args, options);
      };
      syncBuiltinESMExports();
    `);

    original = spawn(process.execPath, [vite, '--port', '0'], { windowsHide: true });
    const output = createInterface({ input: original.stdout });
    const [port] = await once(output, 'line', { signal: AbortSignal.timeout(5_000) });
    output.close();
    const restart = (mode = 'elevate') => spawnSync(process.execPath, [
      '--import', pathToFileURL(preload).href, join(root, 'scripts/restart-vite.mjs'),
      port, 'stdout.log', 'stderr.log', pidFile, stopFile,
    ], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
      env: { ...process.env, GLB_RESTART_TEST_MODE: mode },
    });
    const responsePid = async () => (await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(3_000),
    })).text();

    const unknown = restart();
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /端口 .* 正被未识别进程占用/);
    assert.doesNotMatch(unknown.stdout, /正在请求管理员权限/);
    await assert.rejects(access(stopFile), { code: 'ENOENT' });

    await writeFile(pidFile, String(original.pid));
    const canceled = restart('cancel');
    assert.equal(canceled.status, 1);
    assert.match(canceled.stderr, /已取消管理员授权，服务仍在运行/);
    assert.equal(await responsePid(), String(original.pid));
    await assert.rejects(access(stopFile), { code: 'ENOENT' });

    const result = restart();
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.match(result.stdout, /正在请求管理员权限/);
    const newPid = Number(await readFile(pidFile, 'ascii'));
    assert.notEqual(newPid, original.pid);
    assert.equal(await responsePid(), String(newPid));

    const normal = restart('normal');
    assert.equal(normal.status, 0, normal.error?.message || normal.stderr);
    assert.doesNotMatch(normal.stdout, /正在请求管理员权限/);
    const ordinaryPid = Number(await readFile(pidFile, 'ascii'));
    assert.notEqual(ordinaryPid, newPid);
    assert.equal(await responsePid(), String(ordinaryPid));
  } finally {
    const recorded = Number(await readFile(pidFile, 'ascii').catch(() => ''));
    if (recorded && recorded !== original?.pid) {
      try { process.kill(recorded); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (original && original.exitCode === null && original.signalCode === null) {
      original.kill();
      await once(original, 'exit');
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
