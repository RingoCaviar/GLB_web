import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSequenceProducts, DEFAULT_MAX_SIZE, scanSequenceLibrary } from './sequence-cache.mjs';

export async function generateSequencePreviews(projectRoot = resolve(import.meta.dirname, '..'), maxSize = DEFAULT_MAX_SIZE) {
  const scan = await scanSequenceLibrary(projectRoot);
  const productIds = [...scan.products.keys()];
  if (!productIds.length) return { total: 0, generated: 0, cached: 0, removed: 0 };
  const result = await buildSequenceProducts(projectRoot, productIds, maxSize);
  return { total: result.total, generated: result.succeeded, cached: 0, removed: 0, failed: result.failed };
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const result = await generateSequencePreviews();
    console.log(`[360°图片] ${result.total} 张：生成 ${result.generated}，失败 ${result.failed ?? 0}`);
  } catch (error) {
    console.error(`[360°图片] 预览图生成失败：${error.message}`);
    process.exitCode = 1;
  }
}
