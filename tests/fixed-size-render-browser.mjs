import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { createServer } from 'vite';

const browserCandidates = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
assert.ok(executablePath, '固定尺寸出图回归需要本机 Chrome、Edge 或 Chromium');

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-webgl'],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1.5,
    acceptDownloads: true,
  });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.locator('#libraryGrid button').first().click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#modelStatus')?.textContent?.trim();
    return status && !status.includes('正在');
  }, null, { timeout: 60000 });

  for (const [width, height] of [[640, 480], [641, 481]]) {
    await page.locator('#exportWidth').fill(String(width));
    await page.locator('#exportHeight').fill(String(height));
    await page.locator('#exportHeight').dispatchEvent('change');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#exportButton').click();
    const download = await downloadPromise;
    const metadata = await sharp(await download.path()).metadata();
    assert.deepEqual(
      { width: metadata.width, height: metadata.height },
      { width, height },
      `1.5× DPR 下用户应能导出 ${width}×${height} PNG`,
    );
  }

  console.log('fixed size render browser tests passed');
} finally {
  await browser?.close();
  await server.close();
}
