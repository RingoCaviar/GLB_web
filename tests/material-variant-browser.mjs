import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { createServer } from 'vite';

const folder = '胰岛素注射器包装盒';
const modelId = `${folder}/${folder}_002.glb`;
const longName = '加长型号名称_ProfessionalPackagingEditionWithExtendedSpecifications2026';

async function assertLongNameFits(locator, container = locator) {
  const original = await locator.textContent();
  await locator.evaluate((element, name) => { element.textContent = name; }, longName);
  try {
    const fits = await locator.evaluate((element) => (
      element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
    ));
    const containerFits = await container.evaluate((element) => (
      element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
    ));
    assert.ok(fits && containerFits, `${locator} 应完整显示长名称`);
  } finally {
    await locator.evaluate((element, name) => { element.textContent = name; }, original);
  }
}
const browserCandidates = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
assert.ok(executablePath, '外观变体回归需要本机 Chrome、Edge 或 Chromium');

const port = await new Promise((resolve, reject) => {
  const listener = createTcpServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const { port } = listener.address();
    listener.close(() => resolve(port));
  });
});
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/src/environment-presets.generated.js'] } } });
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
  const folderCard = page.locator(`[data-thumbnail-folder="${folder}"]`);
  const recentCard = page.locator('.recent-grid .model-card').first();
  await assertLongNameFits(recentCard.locator('strong'), recentCard);
  await assertLongNameFits(folderCard.locator('strong'), folderCard);
  await folderCard.click();
  const modelCard = page.locator(`[data-model-id="${modelId}"]`);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await assertLongNameFits(modelCard.locator('strong'), modelCard);
    await assertLongNameFits(modelCard.locator('small'), modelCard);
  }
  await modelCard.click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#modelStatus')?.textContent?.trim() ?? '';
    return status && !status.includes('正在') && !status.includes('等待');
  }, null, { timeout: 60000 });

  assert.match(await page.locator('#modelStatus').getAttribute('class'), /\bready\b/, '带外观变体的模型应进入可交互状态');
  assert.equal(await page.locator('#exportButton').isEnabled(), true, '带外观变体的模型应允许导出');
  await page.locator('#settings-toggle-material').click();
  assert.equal(await page.locator('#appearanceVariants').isVisible(), true, '网页应显示外观变体选择器');
  const materialName = page.locator('.material-full-name');
  const materialPicker = page.locator('#materialSelect');
  assert.equal(await materialName.textContent(), await materialPicker.locator('option:checked').textContent());
  await page.locator('#materialTextureChannels > summary').click();
  await page.locator('.texture-name').first().waitFor({ state: 'visible' });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await assertLongNameFits(page.locator('#appearanceVariantName'), page.locator('#appearanceVariantToggle'));
    await assertLongNameFits(materialName);
    await assertLongNameFits(page.locator('.texture-name').first(), page.locator('.texture-card').first());

    await page.locator('#appearanceVariantToggle').click();
    const labels = await page.locator('[data-appearance-variant] strong').allInnerTexts();
    assert.deepEqual(labels, ['原始外观', '0.5ML', '1ML', '0.3ML']);
    const selectedOption = page.locator('[data-appearance-variant][aria-selected="true"]');
    await assertLongNameFits(selectedOption.locator('strong'), selectedOption);
    await page.locator('#appearanceVariantToggle').click();
  }

  await page.locator('#settings-toggle-lighting').click();
  await assertLongNameFits(page.locator('#environmentCurrent strong'), page.locator('#environmentPickerToggle'));
  await page.locator('#environmentPickerToggle').click();
  const environmentCard = page.locator('.environment-card').first();
  await assertLongNameFits(environmentCard.locator(':scope > span:nth-child(2)'), environmentCard);
  await page.locator('#environmentDialogClose').click();

  const generateCover = async (value) => {
    await page.locator('#openLibrary').click();
    await modelCard.click({ button: 'right' });
    await page.locator('#generateThumbnail').click();
    await page.locator('#thumbnailVariantDialog').waitFor({ state: 'visible', timeout: 10000 });
    assert.deepEqual(
      await page.locator('[data-thumbnail-variant] strong').allInnerTexts(),
      ['原始外观', '0.5ML', '1ML', '0.3ML'],
    );
    const coverOption = page.locator(`[data-thumbnail-variant="${value}"]`);
    await assertLongNameFits(coverOption.locator('strong'), coverOption);
    await coverOption.click();
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
