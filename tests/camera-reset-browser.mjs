import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const browserCandidates = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft Edge\\Application\\msedge.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
assert.ok(executablePath, '相机重置回归需要本机 Chrome、Edge 或 Chromium');

const server = await createServer({
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src/environment-presets.generated.js'] } },
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.locator('[data-model-id]').first().click();
  await page.waitForFunction(() => document.querySelector('#modelStatus')?.classList.contains('ready'), null, { timeout: 60000 });

  const number = page.locator('#radiusNumber');
  const range = page.locator('#radiusRange');
  const reset = page.locator('[data-camera-reset="radius"]');
  const baseline = await number.inputValue();
  await number.fill(await number.getAttribute('min'));
  await number.dispatchEvent('change');
  await page.waitForTimeout(500);
  await reset.click();
  await page.waitForTimeout(100);

  assert.equal(await number.inputValue(), baseline, '距离数值框应精确恢复自动取景值');
  assert.equal(await range.inputValue(), baseline, '距离滑杆应精确恢复自动取景值');
  assert.equal(await reset.isDisabled(), true, '距离恢复自动取景值后重置按钮应禁用');
  console.log('camera reset browser tests passed');
} finally {
  await browser?.close();
  await server.close();
}
