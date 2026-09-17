import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
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

const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src/environment-presets.generated.js'] } } });
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
  const generatedCovers = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/__thumbnail/save', async (route) => {
    generatedCovers.push(route.request().postDataJSON().dataUrl);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ filename: '测试.cover.webp', thumbnailUrl: '/test-cover.webp' }),
    });
  });

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

  const generateCover = async (value) => {
    await page.locator('#openLibrary').click();
    await modelCard.click({ button: 'right' });
    await page.locator('#generateThumbnail').click();
    await page.locator('#thumbnailVariantDialog').waitFor({ state: 'visible', timeout: 10000 });
    assert.deepEqual(
      await page.locator('[data-thumbnail-variant] strong').allInnerTexts(),
      ['原始外观', '0.5ML', '1ML', '0.3ML'],
    );
    await page.locator(`[data-thumbnail-variant="${value}"]`).click();
    const saved = page.waitForResponse((response) => response.url().includes('/__thumbnail/save'));
    await page.locator('#thumbnailVariantConfirm').click();
    await saved;
    await page.waitForFunction(() => document.querySelector('#message')?.textContent?.startsWith('已生成'), null, { timeout: 60000 });
  };

  await generateCover('0.5ML');
  await generateCover('__original__');
  const variantBuffer = Buffer.from(generatedCovers[0].split(',')[1], 'base64');
  const originalBuffer = Buffer.from(generatedCovers[1].split(',')[1], 'base64');
  assert.deepEqual(
    await sharp(variantBuffer).metadata().then(({ width, height, format }) => ({ width, height, format })),
    { width: 640, height: 480, format: 'webp' },
    '选定外观变体后应生成 640 × 480 WebP 模型封面',
  );
  assert.notDeepEqual(variantBuffer, originalBuffer, '选定 0.5ML 外观变体必须改变生成的封面像素');
  assert.deepEqual(pageErrors, [], '模型加载不应产生未处理的页面异常');

  console.log('material variant browser tests passed');
} finally {
  await browser?.close();
  await server.close();
}
