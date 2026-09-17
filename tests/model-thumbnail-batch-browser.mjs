import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const candidates = process.platform === 'win32' ? [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
] : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
const executablePath = candidates.find(fs.existsSync);
assert.ok(executablePath, '批量模型封面回归需要 Chrome 或 Edge');

const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src/environment-presets.generated.js'] } } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let saves = 0;
  await page.route('**/__thumbnail/save', async (route) => {
    saves++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ filename: `batch-${saves}.cover.webp`, thumbnailUrl: `/batch-${saves}.webp` }) });
  });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });

  await page.locator('#sequenceBatchMode').click();
  const cards = page.locator('.recent-grid [data-model-id]');
  await cards.nth(0).click();
  await cards.nth(1).click();
  assert.equal(await page.locator('#sequenceBatchBuild').textContent(), '生成已选 (2)');
  await page.locator('#sequenceBatchBuild').click();
  assert.equal(await page.locator('#thumbnailBatchTotal').textContent(), '2');
  await page.locator('[name="thumbnailOverwrite"][value="all"]').check();
  await page.locator('#thumbnailBatchStart').click();
  await page.waitForFunction(() => document.querySelector('#thumbnailBatchCurrent')?.textContent?.includes('全部模型封面生成完成'), null, { timeout: 120000 });
  assert.equal(saves, 2, '多选的两个模型应串行生成封面');
  await page.locator('#thumbnailBatchStop').click();

  const folder = page.locator('[data-thumbnail-folder]').first();
  await folder.dispatchEvent('contextmenu', { clientX: 240, clientY: 320 });
  assert.equal(await page.locator('#generateThumbnail').textContent(), '递归生成此文件夹封面');
  await page.locator('#generateThumbnail').click();
  assert.ok(Number(await page.locator('#thumbnailBatchTotal').textContent()) > 0, '文件夹右键应收集后代模型');
  console.log('批量模型封面浏览器测试通过');
} finally {
  await browser?.close();
  await server.close();
}
