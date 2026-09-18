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
assert.ok(executablePath, '材质重置回归需要本机 Chrome、Edge 或 Chromium');

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

  const number = page.locator('[data-number="materialMetallic"]');
  const range = page.locator('#materialMetallic');
  const reset = page.locator('[data-reset="materialMetallic"]');
  const baseline = Number(await number.inputValue());
  const changed = baseline === 1 ? 0 : 1;
  await number.fill(String(changed));
  await number.dispatchEvent('change');
  assert.equal(await page.evaluate(() => document.querySelector('model-viewer').model.materials[0].pbrMetallicRoughness.metallicFactor), changed);

  await reset.click();
  assert.equal(await page.evaluate(() => document.querySelector('model-viewer').model.materials[0].pbrMetallicRoughness.metallicFactor), baseline);
  assert.equal(Number(await number.inputValue()), baseline, '金属度数值框应显示原始值');
  assert.equal(Number(await range.inputValue()), baseline, '金属度滑杆应显示原始值');

  const advanced = page.locator('#material-clearcoat').locator('xpath=ancestor::details');
  await advanced.evaluate((element) => { element.open = true; });
  const clearcoatNumber = page.locator('[data-number="material-clearcoat"]');
  const clearcoatRange = page.locator('#material-clearcoat');
  const clearcoatReset = page.locator('[data-reset="material-clearcoat"]');
  const clearcoatBaseline = Number(await clearcoatNumber.inputValue());
  const changedClearcoat = clearcoatBaseline === 1 ? 0 : 1;
  await clearcoatNumber.fill(String(changedClearcoat));
  await clearcoatNumber.dispatchEvent('change');
  assert.equal(await page.evaluate(() => document.querySelector('model-viewer').model.materials[0].clearcoatFactor), changedClearcoat);

  await clearcoatReset.click();
  assert.equal(await page.evaluate(() => document.querySelector('model-viewer').model.materials[0].clearcoatFactor), clearcoatBaseline);
  assert.equal(Number(await clearcoatNumber.inputValue()), clearcoatBaseline, '清漆数值框应显示原始基线');
  assert.equal(Number(await clearcoatRange.inputValue()), clearcoatBaseline, '清漆滑杆应显示原始基线');
  assert.equal(await clearcoatReset.isDisabled(), true, '清漆恢复原始基线后重置按钮应禁用');

  const baseColor = page.locator('#materialBaseColor');
  const baseColorReset = page.locator('[data-reset="materialBaseColor"]');
  const baseColorBaseline = (await baseColor.inputValue()).toLowerCase();
  const changedBaseColor = baseColorBaseline === '#ff0000' ? '#00ff00' : '#ff0000';
  await baseColor.fill(changedBaseColor);
  await baseColor.dispatchEvent('input');
  await baseColorReset.click();
  assert.equal((await baseColor.inputValue()).toLowerCase(), baseColorBaseline, '基础颜色控件应显示原始颜色');
  assert.equal(await baseColorReset.isDisabled(), true, '基础颜色恢复后重置按钮应禁用');

  console.log('material reset browser tests passed');
} finally {
  await browser?.close();
  await server.close();
}
