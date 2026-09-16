import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const modelId = '胰岛素注射器包装盒/注射器包装盒_002.glb';
const browserCandidates = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
assert.ok(executablePath, '外观变体回归需要本机 Chrome、Edge 或 Chromium');

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-webgl'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  const modelCard = page.locator(`[data-model-id="${modelId}"]`);
  assert.equal(await modelCard.count(), 1, '模型库应显示带外观变体的测试模型');
  await modelCard.click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#modelStatus')?.textContent?.trim() ?? '';
    return status && !status.includes('正在') && !status.includes('等待');
  }, null, { timeout: 60000 });

  assert.match(await page.locator('#modelStatus').getAttribute('class'), /\bready\b/, '带外观变体的模型应进入可交互状态');
  assert.equal(await page.locator('#exportButton').isEnabled(), true, '带外观变体的模型应允许导出');
  assert.equal(await page.locator('#appearanceVariants').isVisible(), true, '网页应显示外观变体选择器');

  await page.locator('#appearanceVariantToggle').click();
  const labels = await page.locator('[data-appearance-variant] strong').allInnerTexts();
  assert.deepEqual(labels, ['原始外观', '0.5ML', '1ML', '0.3ML']);
  assert.deepEqual(pageErrors, [], '模型加载不应产生未处理的页面异常');

  console.log('material variant browser tests passed');
} finally {
  await browser?.close();
  await server.close();
}
