import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
const executablePath = candidates.find(fs.existsSync);
assert.ok(executablePath);
const port = await new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const selected = listener.address().port;
    listener.close(() => resolve(selected));
  });
});
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/src/environment-presets.generated.js'] } } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.locator('.viewer-shell').waitFor();
  for (const [width, height] of [[1440, 900], [1100, 600], [981, 500], [980, 500], [700, 400], [390, 700], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    const sizes = await page.evaluate(() => {
      const box = (selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return { shell: box('.viewer-shell'), frame: box('.viewer-frame'), header: box('.stage-header'), scrollWidth: document.documentElement.scrollWidth };
    });
    assert.ok(sizes.shell.width > 200 && sizes.shell.height > 180, '预览区不能被压缩');
    if (width > 980) assert.ok(sizes.shell.y + sizes.shell.height <= Math.max(height, 600) - 23,
      `${width}×${height}: 预览区不能越过工作区底部`);
    assert.ok(sizes.scrollWidth <= width + 1, '页面不能被横向裁切');
    assert.ok(sizes.frame.width <= sizes.shell.width + 1 && sizes.frame.height <= sizes.shell.height + 1, '取景框必须完整处于预览区');
  }
  console.log('preview resize browser tests passed');
} finally {
  await browser?.close();
  await server.close();
}
