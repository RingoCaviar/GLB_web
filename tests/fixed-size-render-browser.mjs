import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
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

const port = await new Promise((resolve, reject) => {
  const listener = createTcpServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const { port } = listener.address();
    listener.close(() => resolve(port));
  });
});
const server = await createServer({
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
});
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
  await page.locator('[data-model-id]').first().click();
  await page.waitForFunction(() => document.querySelector('#modelStatus')?.classList.contains('ready'), null, { timeout: 60000 });

  const preset = page.locator('#resolutionPreset');
  const aspect = page.locator('#resolutionAspect');
  const widthInput = page.locator('#exportWidth');
  const heightInput = page.locator('#exportHeight');
  const exportButton = page.locator('#exportButton');
  const frameLabel = page.locator('#frameLabel');
  const result = page.locator('#exportStatus');
  const transparent = page.getByRole('switch', { name: '透明背景' });
  const transparentLabel = page.locator('label[for="transparentToggle"]');
  const backgroundColor = page.locator('#backgroundColor');

  assert.equal(await preset.isVisible(), true, '首次打开模型即可选择分辨率');
  assert.equal(await aspect.isVisible(), true, '首次打开模型即可选择比例');
  assert.equal(await widthInput.isVisible(), false, '使用预设时应只显示输出尺寸');
  assert.match(await page.locator('#exportFooterSummary').textContent(), /4096 × 4096 px/);
  assert.equal(await page.locator('#exportAdvanced').getAttribute('open'), null, '高级出图选项应默认折叠');
  assert.match(await page.locator('#exportQualitySummary').textContent(), /高质量/, '首次使用应默认高质量导出');
  await transparentLabel.click();
  assert.equal(await transparent.isChecked(), true);
  assert.match(await frameLabel.textContent(), /透明背景/, '取景框应标明透明出图');
  assert.equal(await backgroundColor.isDisabled(), true, '透明出图时实色背景控件应禁用');
  await transparentLabel.click();
  assert.equal(await transparent.isChecked(), false);
  assert.equal(await backgroundColor.isEnabled(), true);
  await preset.selectOption('custom');

  async function setDimensions(width, height) {
    await widthInput.fill(String(width));
    await heightInput.fill(String(height));
    await heightInput.press('Tab');
  }

  async function assertDownloadSize(download, width, height) {
    const { format, width: pngWidth, height: pngHeight } = await sharp(await download.path()).metadata();
    assert.deepEqual({ format, pngWidth, pngHeight }, { format: 'png', pngWidth: width, pngHeight: height },
      `1.5× DPR 下用户应能导出 ${width}×${height} PNG`);
    assert.ok(download.suggestedFilename().includes(`_${width}x${height}_`), '文件名应使用实际渲染尺寸');
  }

  await widthInput.fill('63');
  await widthInput.press('Tab');
  assert.equal(await widthInput.inputValue(), '64', '低于尺寸下限的值应调整到 64 px');
  assert.match(await page.locator('#exportDimensionFeedback').textContent(), /64/, '调整尺寸时应显示反馈');

  for (const [width, height] of [[640, 480], [641, 481]]) {
    await setDimensions(width, height);
    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
    await assertDownloadSize(download, width, height);
    assert.match(await result.textContent(), /FXAA 抗锯齿/, '默认的实色 PNG 应应用 FXAA');
  }

  assert.equal(await aspect.inputValue(), 'custom');
  await preset.selectOption('4096');
  assert.equal(await aspect.inputValue(), '1:1');
  assert.equal(await widthInput.inputValue(), '4096');
  assert.equal(await heightInput.inputValue(), '4096');
  assert.match(await frameLabel.textContent(), /4096 × 4096 · 1:1/, '切回 4K 时，取景框必须同时使用预设尺寸和有效比例');

  await preset.selectOption('custom');
  await setDimensions(640, 480);
  const [download, settingsRemainEditable] = await Promise.all([
    page.waitForEvent('download'),
    exportButton.evaluate((button) => {
      // 置于同一事件循环，在渲染完成前改变下一次导出的尺寸。
      button.click();
      const width = document.querySelector('#exportWidth');
      width.value = '672';
      width.dispatchEvent(new Event('input', { bubbles: true }));
      return button.disabled && !width.disabled && !width.readOnly;
    }),
  ]);
  assert.equal(settingsRemainEditable, true, '渲染中应允许为下一次出图编辑参数');
  assert.match(await frameLabel.textContent(), /672 × 480/, '取景框应显示下一次出图的尺寸');
  await assertDownloadSize(download, 640, 480);
  assert.match(await result.textContent(), /已导出 640 × 480 PNG/, '完成提示应报告当前下载的尺寸');

  await transparentLabel.click();
  const [transparentDownload] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  await assertDownloadSize(transparentDownload, 672, 480);
  const corner = await sharp(await transparentDownload.path())
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .ensureAlpha()
    .raw()
    .toBuffer();
  assert.equal(corner[3], 0, '预览棋盘格对应透明 PNG，图片背景应保留透明像素');

  console.log('fixed size render browser tests passed');
} finally {
  await browser?.close();
  await server.close();
}
