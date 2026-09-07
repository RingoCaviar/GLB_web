import { closeSync, openSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const [
  port = '5173',
  outputLog = '.glb-viewer-output.log',
  errorLog = '.glb-viewer-error.log',
  pidFile = '.glb-viewer.pid',
] = process.argv.slice(2);
const projectRoot = resolve(import.meta.dirname, '..');
const viteCli = resolve(projectRoot, 'node_modules/vite/bin/vite.js');
const stdout = openSync(resolve(projectRoot, outputLog), 'w');
const stderr = openSync(resolve(projectRoot, errorLog), 'w');

try {
  const child = spawn(process.execPath, [viteCli, '--host', '0.0.0.0', '--port', port, '--strictPort'], {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
  });
  child.unref();
  writeFileSync(resolve(projectRoot, pidFile), `${child.pid}\r\n`, 'ascii');
} finally {
  closeSync(stdout);
  closeSync(stderr);
}
