import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const browserCandidates = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = browserCandidates.find(existsSync);
assert.ok(executablePath, '参数面板浏览器回归需要 Chrome、Edge 或 Chromium');

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

const categoryIds = ['camera', 'post', 'lighting', 'material'];
const baseUrl = server.resolvedUrls.local[0];

async function loadModel(page) {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const firstModel = page.locator('[data-model-id]').first();
  const modelId = await firstModel.getAttribute('data-model-id');
  await firstModel.click();
  await page.locator('#modelStatus.ready').waitFor({ timeout: 60000 });
  return modelId;
}

async function assertReachable(locator, { minimumHeight = 0 } = {}) {
  assert.equal(await locator.isVisible(), true, String(locator) + ' 应可见');
  const box = await locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    const insideViewport = x >= 0 && y >= 0 && x + width <= innerWidth + 1 && y + height <= innerHeight + 1;
    const reachesCenter = element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    return { x, y, width, height, insideViewport, reachesCenter };
  });
  assert.ok(box.insideViewport && box.reachesCenter, String(locator) + ' 应完整可见且不被遮挡 ' + JSON.stringify(box));
  assert.ok(box.height >= minimumHeight, String(locator) + ' 触控高度应至少为 ' + minimumHeight + ' px');
}

async function assertExportAction(page) {
  const button = page.locator('#exportButton');
  await assertReachable(button, { minimumHeight: 44 });
  assert.equal(await button.isEnabled(), true, '导出 PNG 应在检查参数时可用');
  const size = page.locator('#exportFooterSummary');
  await assertReachable(size);
  assert.match(await size.textContent(), /\d+ × \d+ px/, '导出按钮旁应显示当前输出尺寸');
}

async function assertCategoryNavigation(page) {
  for (const id of categoryIds) await assertReachable(page.locator('#settings-toggle-' + id), { minimumHeight: 44 });
}

async function readPinnedExportLayout(page) {
  await assertReachable(page.locator('#exportHeading'), { minimumHeight: 44 });
  const { panel, settings, heading, categories, footer } = await page.evaluate(() => {
    const bounds = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
    return {
      panel: bounds('#modelPanel'),
      settings: bounds('#exportSettings'),
      heading: bounds('#exportHeading'),
      categories: bounds('.settings-category-navigation'),
      footer: bounds('.model-export-footer'),
    };
  });
  assert.ok(Math.abs(settings.top - panel.top) <= 1, '导出设置应置于参数面板顶部');
  assert.ok(settings.bottom <= categories.top + 1, '导出设置应位于参数分类上方');
  return { settings, heading, categories, footer };
}

async function assertMinimumFontSize(locator, size) {
  assert.ok(await locator.count() > 0, String(locator) + ' 应包含可核对的文字');
  const sizes = await locator.evaluateAll((elements) => elements.map((element) => parseFloat(getComputedStyle(element).fontSize)));
  assert.ok(sizes.every((value) => value >= size), String(locator) + ' 的字号应至少为 ' + size + ' px');
}

let browser;
try {
  browser = await chromium.launch({
    executablePath, headless: true, args: ['--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const projectLighting = { preset: 'neutral', exposure: 1 };
  const sharedWrites = [];
  let writable = true;
  await page.route('**/__lighting-default/current', (route) => route.fulfill({
    json: { lighting: projectLighting, writable },
  }));
  await page.route('**/__lighting-default/save', (route) => {
    const { lighting } = route.request().postDataJSON();
    sharedWrites.push(lighting);
    return route.fulfill({ json: { lighting } });
  });

  const modelId = await loadModel(page);
  const camera = page.locator('#settings-toggle-camera');
  const post = page.locator('#settings-toggle-post');
  const lighting = page.locator('#settings-toggle-lighting');
  const material = page.locator('#settings-toggle-material');
  const panelScroll = page.locator('.model-panel-scroll');

  assert.equal(await camera.getAttribute('aria-expanded'), 'true');
  for (const selector of ['#resolutionPreset', '#resolutionAspect', '#transparentToggle', '#backgroundColor']) {
    const control = page.locator(selector);
    await assertReachable(control);
    assert.equal(await control.isEnabled(), true, selector + ' 应在桌面首屏可用');
  }
  await assertExportAction(page);
  await assertCategoryNavigation(page);
  const desktopPinnedLayout = await readPinnedExportLayout(page);
  const desktopPreset = page.locator('#resolutionPreset');
  const desktopPresetBefore = await desktopPreset.boundingBox();
  await panelScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  assert.ok(await panelScroll.evaluate((element) => element.scrollTop > 0), '桌面相机参数应可独立滚动');
  assert.deepEqual(await readPinnedExportLayout(page), desktopPinnedLayout, '桌面调参滚动后导出设置、分类与导出栏应保留位置');
  assert.deepEqual(await desktopPreset.boundingBox(), desktopPresetBefore, '展开的导出控件应保持固定');
  await panelScroll.evaluate((element) => { element.scrollTop = 0; });
  const cameraNumber = page.getByRole('spinbutton', { name: /垂直.*(FOV|视野|视角)/i }).and(page.locator('#fovNumber'));
  assert.equal(await cameraNumber.count(), 1, '相机精确输入框应有可访问名称');

  await post.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings-toggle-lighting',
    'Tab 应跨过折叠的后处理参数');
  await post.press('Enter');
  assert.equal(await post.getAttribute('aria-expanded'), 'true');
  assert.equal(await camera.getAttribute('aria-expanded'), 'false');
  const smaa = page.getByRole('switch', { name: /SMAA/ });
  await assertReachable(smaa);
  assert.equal(await smaa.evaluate((element) => element === document.activeElement), true,
    '键盘展开后应直接进入当前分类的控件');
  await assertExportAction(page);
  await page.keyboard.press('Escape');
  assert.equal(await post.getAttribute('aria-expanded'), 'false', 'Esc 应折叠当前参数');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings-toggle-post', 'Esc 应恢复参数触发按钮的焦点');
  await camera.press('Enter');
  assert.equal(await cameraNumber.evaluate((element) => element === document.activeElement), true);
  await page.locator('#openLibrary').press('Escape');
  assert.equal(await camera.getAttribute('aria-expanded'), 'true', '参数区外的 Esc 不应改变当前参数');

  const defaultFov = await cameraNumber.inputValue();
  const changedFov = String(Number(defaultFov) + 5);
  await cameraNumber.fill(changedFov);
  await cameraNumber.press('Tab');
  await page.locator('#resetCamera').click();
  const undoCamera = page.locator('#undoCameraReset');
  await undoCamera.waitFor();
  assert.equal(await cameraNumber.inputValue(), defaultFov, '重置视角应恢复默认视野');
  await undoCamera.click();
  assert.equal(await cameraNumber.inputValue(), changedFov, '撤销重置应恢复之前的视野');

  await panelScroll.evaluate((element) => { element.scrollTop = 0; });
  const quality = page.locator('#exportQuality');
  await page.locator('#exportAdvanced > summary').click();
  await quality.selectOption('high');
  const transparent = page.locator('#transparentToggle');
  await transparent.check();
  const qualitySummary = page.locator('#exportQualitySummary');
  assert.match(await qualitySummary.textContent(), /标准采样/, '摘要应说明透明 PNG 的实际采样');
  assert.equal(await quality.inputValue(), 'high', '启用透明背景时应保留用户的质量偏好');
  await page.locator('#resolutionPreset').selectOption('custom');
  await page.locator('#exportWidth').fill('320');
  await page.locator('#exportHeight').fill('240');
  await page.locator('#exportHeight').press('Tab');
  await lighting.click();
  await assertExportAction(page);
  assert.match(await page.locator('#exportFooterSummary').textContent(), /320 × 240 px/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exportButton').click()]);
  assert.match(download.suggestedFilename(), /_320x240_.*\.png$/);
  const transparentExportStatus = await page.locator('#exportStatus').textContent();
  assert.match(transparentExportStatus, /320 × 240 PNG。 标准采样/, '下载回执应与摘要中的实际采样一致');
  await transparent.uncheck();
  assert.match(await qualitySummary.textContent(), /高质量|FXAA/, '关闭透明时应恢复高质量采样');
  assert.equal(await quality.inputValue(), 'high');

  await page.locator('#environmentPickerToggle').click();
  const neutral = page.locator('[data-environment-preset="neutral"]');
  await neutral.waitFor();
  assert.equal(await neutral.locator('img').count(), 0, '中性环境应使用文字占位而不请求预览图');
  assert.match(await neutral.innerText(), /无 HDRI/);
  await neutral.click();
  await page.locator('#environmentDialog').waitFor({ state: 'hidden' });
  const currentEnvironment = page.locator('#environmentCurrent');
  assert.equal(await currentEnvironment.locator('img').count(), 0, '当前中性环境也不应显示图片');
  assert.match(await currentEnvironment.innerText(), /无 HDRI/);
  await assertMinimumFontSize(page.locator('#environmentStatus, #environmentCurrent strong, [data-adjusted-count="lighting"], [data-adjusted-count="rotation"]'), 12);

  const save = page.getByRole('button', { name: '设为项目默认光照' });
  const saveScope = page.locator('#projectLightingScope');
  assert.match(await saveScope.textContent(), /所有访问者.*模型光照优先/, '项目默认光照应说明影响范围和模型光照的优先级');
  const exposure = page.locator('[data-number="studioExposure"]');
  await exposure.fill('1.4');
  await exposure.press('Tab');
  await page.waitForFunction((modelId) => {
    const value = JSON.parse(localStorage.getItem('glb-viewer:studio:v1:' + modelId));
    return value?.lighting?.exposure === 1.4;
  }, modelId);
  assert.equal(sharedWrites.length, 0, '调整当前模型不得自动写入项目默认光照');

  await page.locator('#resetLighting').click();
  assert.equal(Number(await exposure.inputValue()), projectLighting.exposure, '环境与光照重置应恢复项目默认曝光');
  await page.locator('#undoLightingReset').click();
  assert.equal(Number(await exposure.inputValue()), 1.4, '撤销环境与光照重置应恢复之前的曝光');

  const confirmation = page.locator('#projectLightingConfirmation');
  await save.click();
  assert.equal(await confirmation.isVisible(), true, '共享光照写入前应显示确认');
  assert.equal(sharedWrites.length, 0, '打开确认时不得写入共享光照');
  await page.locator('#cancelDefaultLighting').click();
  assert.equal(await confirmation.isVisible(), false);
  assert.equal(await save.evaluate((element) => element === document.activeElement), true, '取消后应归还触发按钮焦点');
  assert.equal(sharedWrites.length, 0, '取消确认不得更新项目默认光照');
  await save.click();
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/__lighting-default/save')),
    page.locator('#confirmDefaultLighting').click(),
  ]);
  await page.waitForFunction(() => document.querySelector('#projectLightingStatus').classList.contains('success'));
  assert.deepEqual(sharedWrites.map(({ exposure }) => exposure), [1.4], '只有显式确认才应提交项目默认光照');

  await material.click();
  await assertMinimumFontSize(page.locator('[data-adjusted-count^="material-"]'), 12);
  const roughness = page.locator('[data-number="materialRoughness"]');
  const originalRoughness = Number(await roughness.inputValue());
  const changedRoughness = originalRoughness === 0.25 ? 0.75 : 0.25;
  await roughness.fill(String(changedRoughness));
  await roughness.press('Tab');
  await page.locator('#resetMaterial').click();
  assert.equal(Number(await roughness.inputValue()), originalRoughness);
  await page.locator('#undoMaterialReset').click();
  assert.equal(Number(await roughness.inputValue()), changedRoughness, '撤销当前材质重置应恢复之前的粗糙度');

  writable = false;
  await loadModel(page);
  await lighting.click();
  assert.equal(await save.isDisabled(), true, '局域网客户端不应能设置项目默认光照');
  assert.match(await saveScope.textContent(), /仅运行服务的电脑/, '禁用时应说明权限原因');
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  const mobileScroll = mobile.locator('.model-panel-scroll');
  const mobileCamera = mobile.locator('#settings-toggle-camera');
  const mobileFov = mobile.locator('#fovNumber');
  const preview = mobile.locator('.viewer-shell');
  const mobileExportSettings = mobile.locator('#exportSettings');
  for (const viewport of [{ width: 390, height: 700 }, { width: 320, height: 568 }, { width: 667, height: 375 }]) {
    await mobile.setViewportSize(viewport);
    await loadModel(mobile);
    await assertCategoryNavigation(mobile);
    await assertExportAction(mobile);
    assert.equal(await mobileExportSettings.getAttribute('open'), null, '小屏出图表单初始应折叠');
    const mobilePinnedLayout = await readPinnedExportLayout(mobile);
    assert.equal(await mobileCamera.getAttribute('aria-expanded'), 'true');
    await assertReachable(mobileFov, { minimumHeight: 44 });

    const tip = mobile.locator('#gestureTip');
    assert.match(await tip.innerText(), /单指拖动旋转.*双指捏合缩放/);
    assert.doesNotMatch(await tip.innerText(), /左键|右键/);
    const previewBefore = await preview.boundingBox();
    const tipBox = await tip.boundingBox();
    assert.ok(tipBox && previewBefore && tipBox.y >= previewBefore.y + previewBefore.height - 1,
      '触屏操作提示应在画布之外');

    await mobileScroll.evaluate((element) => { element.scrollTop = 550; });
    assert.ok(await mobileScroll.evaluate((element) => element.scrollTop > 0));
    assert.deepEqual(await preview.boundingBox(), previewBefore, '窄屏滚动参数时预览应留在同一位置');
    assert.deepEqual(await readPinnedExportLayout(mobile), mobilePinnedLayout, '窄屏滚动参数时导出设置应保持固定');
    await assertCategoryNavigation(mobile);
    await assertExportAction(mobile);
    await mobileCamera.tap();
    assert.equal(await mobileCamera.getAttribute('aria-expanded'), 'true', '点击被滚出视区的当前分类应定位到控件');
    await assertReachable(mobileFov, { minimumHeight: 44 });

    if (viewport.width === 390) {
      await mobile.locator('#exportHeading').tap();
      await mobile.locator('#resolutionPreset').selectOption('custom');
      await mobile.locator('#transparentToggle').check();
      const width = mobile.locator('#exportWidth');
      await width.scrollIntoViewIfNeeded();
      await assertReachable(width, { minimumHeight: 44 });
      await assertCategoryNavigation(mobile);
      await assertExportAction(mobile);
      const expandedPinnedLayout = await readPinnedExportLayout(mobile);
      const widthBefore = await width.boundingBox();
      await mobileScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      assert.ok(await mobileScroll.evaluate((element) => element.scrollTop > 0), '展开导出设置后参数应仍可独立滚动');
      assert.deepEqual(await readPinnedExportLayout(mobile), expandedPinnedLayout, '展开的导出设置应继续固定');
      assert.deepEqual(await width.boundingBox(), widthBefore, '参数滚动应保留导出设置的控件位置');
      await mobileCamera.tap();
      assert.equal(await mobileCamera.getAttribute('aria-expanded'), 'true', '自定义尺寸和透明设置展开后仍可进入相机参数');
      await assertReachable(mobileFov, { minimumHeight: 44 });
      await mobile.locator('#transparentToggle').uncheck();
      await mobile.locator('#resolutionPreset').selectOption('4096');
    }

    if (viewport.width === 320) {
      await mobile.locator('#exportHeading').tap();
      const mobilePreset = mobile.locator('#resolutionPreset');
      const mobilePresetBefore = await mobilePreset.boundingBox();
      await mobile.locator('#exportAdvanced > summary').tap();
      const shortestPinnedLayout = await readPinnedExportLayout(mobile);
      const textureQuality = mobile.locator('#textureDetailMode');
      await textureQuality.scrollIntoViewIfNeeded();
      await assertReachable(textureQuality, { minimumHeight: 44 });
      assert.notDeepEqual(await mobilePreset.boundingBox(), mobilePresetBefore, '短屏应可在导出设置内滚动到高级控件');
      assert.deepEqual(await readPinnedExportLayout(mobile), shortestPinnedLayout, '滚动出图表单时标题、分类与导出栏应保持固定');
      await assertCategoryNavigation(mobile);
      await assertExportAction(mobile);

      const status = mobile.locator('#exportStatus');
      const wrapped = await status.evaluate((element, message) => {
        element.textContent = message;
        return element.getBoundingClientRect().height > parseFloat(getComputedStyle(element).lineHeight);
      }, transparentExportStatus);
      assert.ok(wrapped, '短屏回执应换行，以覆盖参数可用空间不足的情况');
      const mobileLighting = mobile.locator('#settings-toggle-lighting');
      await mobileLighting.tap();
      assert.equal(await mobileLighting.getAttribute('aria-expanded'), 'true');
      assert.equal(await mobileExportSettings.getAttribute('open'), null, '短屏选择参数时应折叠过高的导出设置');
      const environmentPicker = mobile.locator('#environmentPickerToggle');
      await assertReachable(environmentPicker, { minimumHeight: 44 });
      const picker = await environmentPicker.boundingBox();
      const scrollport = await mobileScroll.boundingBox();
      assert.ok(picker && scrollport && picker.y >= scrollport.y && picker.y + picker.height <= scrollport.y + scrollport.height + 1,
        '折叠导出设置后，灯光首项控件应完整进入参数视区');
      await readPinnedExportLayout(mobile);
      await assertExportAction(mobile);
    }
  }

  console.log('parameter panel browser tests passed');
} finally {
  await browser?.close();
  await server.close();
}
