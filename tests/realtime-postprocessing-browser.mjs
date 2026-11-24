import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const browserCandidates = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
assert.ok(executablePath, '实时后处理回归需要本机 Chrome、Edge 或 Chromium');

const port = await new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const selected = listener.address().port;
    listener.close(() => resolve(selected));
  });
});
const server = await createServer({
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    watch: { ignored: ['**/src/environment-presets.generated.js'] },
  },
});
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

  const smaaToggle = page.locator('#realtimeSmaa');
  const ssaoToggle = page.locator('#realtimeSsao');
  assert.equal(await smaaToggle.isChecked(), true, 'SMAA 开关应默认开启');
  assert.equal(await ssaoToggle.isChecked(), true, 'SSAO 开关应默认开启');
  await smaaToggle.evaluate((input) => { input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => (
    document.querySelector('smaa-effect')?.getAttribute('blend-mode') === 'SKIP' &&
    document.querySelector('ssao-effect')?.getAttribute('blend-mode') === 'DEFAULT'
  ));
  await ssaoToggle.evaluate((input) => { input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => (
    document.querySelector('smaa-effect')?.getAttribute('blend-mode') === 'SKIP' &&
    document.querySelector('ssao-effect')?.getAttribute('blend-mode') === 'SKIP'
  ));
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#realtimeSmaa').isChecked(), false, 'SMAA 选择应在刷新后保留');
  assert.equal(await page.locator('#realtimeSsao').isChecked(), false, 'SSAO 选择应在刷新后保留');
  assert.equal(await page.locator('smaa-effect').getAttribute('blend-mode'), 'SKIP');
  assert.equal(await page.locator('ssao-effect').getAttribute('blend-mode'), 'SKIP');
  await page.locator('#realtimeSmaa').evaluate((input) => { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('#realtimeSsao').evaluate((input) => { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => (
    document.querySelector('smaa-effect')?.getAttribute('blend-mode') === 'DEFAULT' &&
    document.querySelector('ssao-effect')?.getAttribute('blend-mode') === 'DEFAULT'
  ));

  const configuration = await page.locator('#modelViewer').evaluate((viewer) => {
    const composer = viewer.querySelector('effect-composer');
    const smaa = composer?.querySelector('smaa-effect');
    const ssao = composer?.querySelector('ssao-effect');
    const colorGrade = composer?.querySelector('color-grade-effect');
    return {
      composerDefined: Boolean(customElements.get('effect-composer')),
      smaaDefined: Boolean(customElements.get('smaa-effect')),
      ssaoDefined: Boolean(customElements.get('ssao-effect')),
      colorGradeDefined: Boolean(customElements.get('color-grade-effect')),
      renderMode: composer?.getAttribute('render-mode'),
      smaaQuality: smaa?.getAttribute('quality'),
      ssaoStrength: ssao?.getAttribute('strength'),
      toneMapping: colorGrade?.getAttribute('tonemapping'),
    };
  });
  assert.deepEqual(configuration, {
    composerDefined: true,
    smaaDefined: true,
    ssaoDefined: true,
    colorGradeDefined: true,
    renderMode: 'quality',
    smaaQuality: 'ULTRA',
    ssaoStrength: '1.5',
    toneMapping: 'NEUTRAL',
  }, '实时查看器应启用高质量 SMAA 和增强型 SSAO');

  const firstModel = page.locator('[data-model-id]').first();
  assert.equal(await firstModel.count(), 1, '模型库应至少包含一个可用于后处理回归的模型');
  await firstModel.click();
  await page.waitForFunction(() => document.querySelector('#modelStatus')?.classList.contains('ready'), null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#modelViewer effect-composer')?.selection?.size > 0, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const composer = document.querySelector('#modelViewer effect-composer');
    const ssao = composer?.querySelector('ssao-effect');
    const effect = ssao?.effects?.[0];
    return Boolean(
      composer?.normalBuffer &&
      (effect?.normalBuffer || effect?.ssaoPass?.normalBuffer) &&
      effect?.radius === 0.15 &&
      effect?.samples === 32,
    );
  }, null, { timeout: 30000 });

  await page.locator('#settings-toggle-post').click();
  await page.locator('#toneMapping').selectOption('aces');
  await page.waitForFunction(() => document.querySelector('color-grade-effect')?.getAttribute('tonemapping') === 'ACES_FILMIC');
  await page.locator('#toneMapping').selectOption('agx');
  await page.waitForFunction(() => document.querySelector('color-grade-effect')?.getAttribute('tonemapping') === 'AGX');

  const pauseResult = await page.evaluate(async () => {
    const { applyRealtimeToneMapping, pauseRealtimePostprocessing } = await import('/src/realtime-postprocessing.js');
    const viewer = document.querySelector('#modelViewer');
    const composer = viewer.querySelector('effect-composer');
    const session = pauseRealtimePostprocessing(viewer);
    const detachedDuringPause = !viewer.querySelector('effect-composer') && !composer.isConnected;
    const smaaControl = document.querySelector('#realtimeSmaa');
    smaaControl.checked = false;
    smaaControl.dispatchEvent(new Event('change', { bubbles: true }));
    applyRealtimeToneMapping(viewer, 'aces');
    session.restore();
    await composer.updateComplete;
    await Promise.all([...composer.children].map((effect) => effect.updateComplete));
    return {
      detachedDuringPause,
      restoredComposer: viewer.querySelector('effect-composer') === composer,
      restoredToneMapping: composer.querySelector('color-grade-effect')?.getAttribute('tonemapping'),
      restoredSmaa: composer.querySelector('smaa-effect')?.getAttribute('blend-mode'),
      restoredSsao: composer.querySelector('ssao-effect')?.getAttribute('blend-mode'),
      savedPreference: JSON.parse(localStorage.getItem('glb-viewer:realtime-postprocessing:v1')),
    };
  });
  assert.deepEqual(pauseResult, {
    detachedDuringPause: true,
    restoredComposer: true,
      restoredToneMapping: 'ACES_FILMIC',
    restoredSmaa: 'SKIP',
    restoredSsao: 'DEFAULT',
    savedPreference: { smaa: false, ssao: true, ssaoStrength: 1.5, ssaoRadius: 0.15, ssaoSamples: 32 },
  }, '固定尺寸出图应完全卸载实时后处理，并恢复暂停期间更新的独立开关');
  await page.locator('#realtimeSmaa').evaluate((input) => { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('smaa-effect')?.getAttribute('blend-mode') === 'DEFAULT');

  const firstSource = await page.locator('#modelViewer').evaluate((viewer) => viewer.src);
  await page.locator('#openLibrary').click();
  const secondModel = page.locator('[data-model-id]').nth(1);
  assert.equal(await secondModel.count(), 1, '模型库应至少包含两个可用于切换回归的模型');
  await secondModel.click();
  await page.waitForFunction((previousSource) => {
    const viewer = document.querySelector('#modelViewer');
    return viewer?.src !== previousSource && document.querySelector('#modelStatus')?.classList.contains('ready');
  }, firstSource, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#modelViewer effect-composer')?.selection?.size > 0, null, { timeout: 30000 });
  const afterSwitch = await page.locator('#modelViewer').evaluate((viewer) => ({
    smaa: viewer.querySelector('smaa-effect')?.getAttribute('quality'),
    ssao: viewer.querySelector('ssao-effect')?.getAttribute('strength'),
    toneMapping: viewer.querySelector('color-grade-effect')?.getAttribute('tonemapping'),
    toneMappingControl: document.querySelector('#toneMapping')?.value,
  }));
  assert.deepEqual(afterSwitch, {
    smaa: 'ULTRA', ssao: '1.5', toneMapping: 'NEUTRAL', toneMappingControl: 'neutral',
  }, '切换模型后应保持实时后处理，并同步新模型的色调映射');

  assert.deepEqual(pageErrors, [], '启用实时后处理并载入模型不应产生页面异常');
  console.log('realtime postprocessing browser tests passed');
} finally {
  await browser?.close();
  await server.close();
}
