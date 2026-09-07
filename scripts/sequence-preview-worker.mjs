import { parentPort } from 'node:worker_threads';
import { mkdir, rename, rm, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';

sharp.concurrency(1);
sharp.cache(false);

async function replaceFile(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await unlink(destination).catch((unlinkError) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    await rename(source, destination);
  }
}

parentPort.on('message', async ({ source, output, maxSize, token }) => {
  const temporary = `${output}.${process.pid}.${token}.tmp`;
  try {
    await mkdir(dirname(output), { recursive: true });
    await sharp(source, { failOn: 'error' })
      .rotate()
      .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85, smartSubsample: true })
      .toFile(temporary);
    await replaceFile(temporary, output);
    parentPort.postMessage({ token, ok: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    parentPort.postMessage({ token, ok: false, error: error.message || 'CONVERT_FAILED' });
  }
});
