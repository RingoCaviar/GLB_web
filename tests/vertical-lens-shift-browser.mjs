import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { preview } from 'vite';

const browserCandidates = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
assert.ok(executablePath, '浏览器像素回归需要本机 Chrome、Edge 或 Chromium');

async function meanPixelDifference(left, right, size = 256) {
  const [a, b] = await Promise.all([left, right].map((image) =>
    sharp(image).removeAlpha().resize(size, size, { fit: 'fill' }).raw().toBuffer()));
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference += Math.abs(a[index] - b[index]);
  return difference / a.length;
}

function dataUrlBuffer(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function setShift(page, percentage) {
  const input = page.locator('#verticalShiftNumber');
  await input.fill(String(percentage));
  await input.evaluate((element) => element.dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForTimeout(500);
}

const server = await preview({ preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-webgl'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.locator('#libraryGrid button').first().click();
  await page.waitForFunction(() => document.querySelector('#modelStatus')?.textContent?.trim() &&
    !document.querySelector('#modelStatus').textContent.includes('正在'));
  await page.locator('#buildingCorrection').click();

  await setShift(page, 0);
  const zeroImage = await page.locator('#modelViewer').screenshot();
  await setShift(page, 25);
  const positiveImage = await page.locator('#modelViewer').screenshot();
  await setShift(page, -25);
  const negativeImage = await page.locator('#modelViewer').screenshot();
  const zeroPixels = await sharp(zeroImage).removeAlpha().raw().toBuffer();
  const positivePixels = await sharp(positiveImage).removeAlpha().raw().toBuffer();
  let pixelDifference = 0;
  for (let index = 0; index < zeroPixels.length; index++) {
    pixelDifference += Math.abs(zeroPixels[index] - positivePixels[index]);
  }
  pixelDifference /= zeroPixels.length;
  assert.ok(pixelDifference > 3, '正 25% 偏移应改变预览像素构图');
  assert.ok(await meanPixelDifference(zeroImage, negativeImage) > 3,
    '负 25% 偏移应改变预览像素构图');

  const captureViewerPng = () => page.locator('#modelViewer').evaluate(async (viewer) => {
    const blob = await viewer.toBlob({ idealAspect: false, mimeType: 'image/png' });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  });
  await setShift(page, 0);
  const zeroPng = await captureViewerPng();
  await setShift(page, 25);
  const positivePng = await captureViewerPng();
  assert.ok(await meanPixelDifference(dataUrlBuffer(zeroPng), dataUrlBuffer(positivePng)) > 3,
    'PNG 应使用与预览相同的垂直镜头偏移状态');

  console.log('vertical lens shift browser pixel tests passed');
} finally {
  await browser?.close();
  server.httpServer.close();
}
