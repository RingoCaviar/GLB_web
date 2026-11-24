import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { createServer } from 'vite';

const browserCandidates = process.platform === 'win32' ? [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = browserCandidates.find(existsSync);
assert.ok(executablePath, '360° 背景浏览器回归需要 Chrome、Edge 或 Chromium');

const sources = await Promise.all(['#ed3d34', '#eb8835', '#edd63b'].map((background) => sharp({
  create: { width: 8, height: 8, channels: 4, background },
}).extend({ top: 5, bottom: 5, left: 8, right: 8, background: '#00000000' }).png().toBuffer()));
const frames = sources.map((_, offset) => {
  const index = offset + 1;
  return {
    index,
    width: 24,
    height: 18,
    originalFilename: `透明样品_俯角5_000${index}.png`,
    previewUrl: `/sequence-test/preview/${index}`,
    originalUrl: `/sequence-test/original/${index}`,
  };
});
const product = {
  id: '透明样品', name: '透明样品加长版多角度展示套装&Aurora360ProfessionalEdition2026', folderPath: '', totalFrames: frames.length,
  thumbnailUrl: frames[0].previewUrl, angles: [{ angle: 5, frames }],
};

async function drag(page, target, move) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box, '可拖动控件应可见');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const { dx, dy } = move(x, y);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

const port = await new Promise((resolve, reject) => {
  const listener = createTcpServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const port = listener.address().port;
    listener.close(() => resolve(port));
  });
});
const server = await createServer({
  server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/src/environment-presets.generated.js'] } },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  await page.route('**/__sequence/library', (route) => route.fulfill({ json: { products: [product], warnings: [] } }));
  await page.route('**/sequence-test/**', (route) => {
    const index = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    return route.fulfill({ contentType: 'image/png', body: sources[index - 1] });
  });
  await page.goto(server.resolvedUrls.local[0]);

  const viewer = page.locator('#sequenceViewer');
  const canvas = viewer.locator('canvas');
  const mode = (name) => page.locator(`#sequenceBackground [data-background-mode="${name}"]`);
  const backgroundImage = () => viewer.evaluate((element) => getComputedStyle(element).backgroundImage);
  const selectProduct = async () => {
    await page.getByRole('button', { name: '360° 图片' }).click();
    await page.locator('[data-sequence-id]').click();
    await page.locator('#sequenceViewer.ready').waitFor();
  };
  const assertProductNameFits = async (selector) => {
    const name = page.locator(selector);
    assert.equal(await name.textContent(), product.name);
    const fits = await name.evaluate((element) => (
      element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
    ));
    assert.ok(fits, `${selector} 应完整显示长产品名`);
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '360° 图片' }).click();
  const productCard = page.locator('[data-sequence-id]');
  await productCard.waitFor();
  await assertProductNameFits('.sequence-card strong');
  assert.ok(await productCard.evaluate((card) => card.scrollHeight <= card.clientHeight), '产品卡片应容纳完整的多行标题');
  const cardName = productCard.locator('strong');
  await cardName.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const nameBounds = await cardName.boundingBox();
  const gridBounds = await page.locator('#libraryGrid').boundingBox();
  assert.ok(nameBounds.y >= gridBounds.y && nameBounds.y + nameBounds.height <= gridBounds.y + gridBounds.height,
    '产品库滚动后应能看到完整标题');
  await productCard.click();
  await page.locator('#modelStatus.ready').waitFor();
  await assertProductNameFits('#sequenceProductName');
  await assertProductNameFits('#modelStatus');
  const statusBounds = await page.locator('#modelStatus').boundingBox();
  assert.ok(statusBounds.x + statusBounds.width <= 390, '长产品名应留在窄屏状态栏内');
  await page.setViewportSize({ width: 1440, height: 900 });
  await assertProductNameFits('#sequenceProductName');
  const defaultBackground = await backgroundImage();
  assert.match(defaultBackground, /^radial-gradient\(/);

  await mode('solid').click();
  await page.locator('#sequenceSolidColor').fill('#2468b0');
  assert.equal(await backgroundImage(), 'none');
  const image = sharp(await canvas.screenshot()).removeAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const pixelAt = (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
  const middleY = Math.floor(info.height / 2);
  assert.deepEqual(pixelAt(20, middleY), [36, 104, 176], '纯色应透过帧图的透明区域显示');
  assert.ok(pixelAt(Math.floor(info.width / 2), middleY)[0] > 230, '背景应位于产品图层下方');

  await mode('gradient').click();
  assert.match(await backgroundImage(), /^linear-gradient\(/);
  const track = page.locator('#sequenceGradientTrack');
  const stops = track.locator('[data-gradient-stop]');
  const initialStops = await stops.count();
  await page.locator('#sequenceGradientAddStop').click();
  assert.equal(await stops.count(), initialStops + 1);
  await page.locator('#sequenceGradientStopColor').fill('#32a86d');
  const position = page.locator('#sequenceGradientStopPosition');
  await position.fill('32');
  await position.press('Tab');
  assert.match(await backgroundImage(), /rgb\(50, 168, 109\)/);
  assert.match(await track.evaluate((element) => getComputedStyle(element, '::before').backgroundImage), /rgb\(50, 168, 109\) 32%/);
  await drag(page, track.locator('[data-gradient-stop][aria-pressed="true"]'), () => ({ dx: 45, dy: 0 }));
  assert.ok(Number(await position.inputValue()) > 32, '拖动色标应更新其位置');
  const trackBounds = await track.boundingBox();
  await track.click({ position: { x: trackBounds.width * .7, y: trackBounds.height * .2 } });
  assert.equal(await stops.count(), initialStops + 2);
  await page.locator('#sequenceGradientRemoveStop').click();
  assert.equal(await stops.count(), initialStops + 1);

  const type = page.locator('#sequenceGradientType');
  await type.selectOption('radial');
  const previousGradient = await backgroundImage();
  assert.match(previousGradient, /^radial-gradient\(/);
  const frame = page.locator('#sequenceFilename');
  const currentFrame = await frame.textContent();
  const overlay = page.locator('#sequenceGradientOverlay');
  const start = overlay.locator('[data-gradient-point="start"]');
  const viewerBounds = await viewer.boundingBox();
  await drag(page, start, (x) => ({ dx: x - viewerBounds.x < viewerBounds.width / 2 ? 45 : -45, dy: 20 }));
  assert.equal(await frame.textContent(), currentFrame, '移动渐变手柄时应保持当前帧');
  const editedGradient = await backgroundImage();
  assert.notEqual(editedGradient, previousGradient, '移动渐变手柄应更新背景');

  const guides = page.locator('#sequenceGradientGuides');
  await guides.uncheck();
  assert.equal(await guides.isChecked(), false);
  assert.equal(await overlay.isVisible(), false);
  assert.equal(await backgroundImage(), editedGradient, '隐藏手柄应保留渐变');
  await drag(page, canvas, () => ({ dx: -18, dy: 0 }));
  await page.waitForFunction((name) => document.querySelector('#sequenceFilename').textContent !== name, currentFrame);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#sequenceDownload').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), await frame.textContent());
  const selected = frames.findIndex((item) => item.originalFilename === download.suggestedFilename());
  assert.ok(selected >= 0);
  assert.deepEqual(await readFile(await download.path()), sources[selected], '下载应保留原始透明 PNG');

  await page.reload();
  await selectProduct();
  await page.waitForFunction((gradient) => getComputedStyle(document.querySelector('#sequenceViewer')).backgroundImage === gradient, editedGradient);
  assert.equal(await guides.isChecked(), false, '刷新应保留画布控件的显示偏好');
  await guides.check();
  await overlay.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '3D 模型', exact: true }).click();
  await overlay.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '360° 图片' }).click();
  await overlay.waitFor({ state: 'visible' });
  await page.locator('#sequenceBackgroundReset').click();
  assert.equal(await backgroundImage(), defaultBackground);
  console.log('360° 背景浏览器测试通过');
} finally {
  await browser?.close();
  await server.close();
}
