export const APPEARANCE_ORIGINAL_VALUE = '__original__';

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

export function appearanceOptions(availableVariants = []) {
  if (!availableVariants.length) return [];
  return [
    { value: APPEARANCE_ORIGINAL_VALUE, label: '原始外观' },
    ...availableVariants.map((name) => ({ value: name, label: name })),
  ];
}

export function appearanceOptionMeta(value) {
  return value === APPEARANCE_ORIGINAL_VALUE ? 'GLB 原始材质' : '模型内嵌变体';
}

export function selectAppearanceVariant(viewer, value) {
  if (value === APPEARANCE_ORIGINAL_VALUE) {
    viewer.variantName = null;
    return true;
  }
  if (!viewer.availableVariants?.includes(value)) return false;
  viewer.variantName = value;
  return true;
}

export function resetAppearanceVariant(viewer) {
  viewer.variantName = null;
}

export function appearanceVariantTemplate() {
  return `<section class="appearance-variant-section" id="appearanceVariants" hidden>
    <div class="appearance-variant-label"><strong>外观</strong><small id="appearanceVariantCount"></small></div>
    <button class="appearance-variant-toggle" id="appearanceVariantToggle" type="button" aria-haspopup="listbox" aria-expanded="false">
      <span class="appearance-variant-thumbnail" id="appearanceVariantThumbnail"><i>3D</i></span>
      <span><strong id="appearanceVariantName">原始外观</strong><small id="appearanceVariantMeta">模型内嵌外观</small></span><i aria-hidden="true">⌄</i>
    </button>
    <div class="appearance-variant-popover" id="appearanceVariantPopover" hidden>
      <label>搜索外观<input id="appearanceVariantSearch" type="search" placeholder="输入名称" autocomplete="off"></label>
      <div class="appearance-variant-options" id="appearanceVariantOptions" role="listbox"></div>
    </div>
  </section>`;
}

export class AppearanceVariantSelector {
  constructor(viewer, root, { onChange = () => {} } = {}) {
    this.viewer = viewer;
    this.root = root;
    this.onChange = onChange;
    this.options = [];
    this.currentValue = APPEARANCE_ORIGINAL_VALUE;
    this.thumbnails = new Map();
    this.root.querySelector('#appearanceVariantToggle').addEventListener('click', () => this.togglePopover());
    this.root.querySelector('#appearanceVariantSearch').addEventListener('input', (event) => this.renderOptions(event.target.value));
    this.root.querySelector('#appearanceVariantOptions').addEventListener('click', (event) => {
      const button = event.target.closest('[data-appearance-variant]');
      if (button) this.select(button.dataset.appearanceVariant);
    });
    document.addEventListener('click', (event) => {
      if (!this.root.hidden && !this.root.contains(event.target)) this.closePopover();
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') this.closePopover(); });
  }

  loadModel(model) {
    resetAppearanceVariant(this.viewer);
    this.options = appearanceOptions(this.viewer.availableVariants ?? []);
    this.currentValue = APPEARANCE_ORIGINAL_VALUE;
    this.thumbnails = new Map([[APPEARANCE_ORIGINAL_VALUE, model?.thumbnailUrl ?? null]]);
    this.root.hidden = this.options.length === 0;
    if (this.root.hidden) return;
    this.root.querySelector('#appearanceVariantCount').textContent = `同一模型 · ${this.options.length - 1} 个变体`;
    this.renderOptions();
    this.updateCurrentDisplay();
  }

  unloadModel() {
    resetAppearanceVariant(this.viewer);
    this.options = [];
    this.currentValue = APPEARANCE_ORIGINAL_VALUE;
    this.thumbnails.clear();
    this.root.hidden = true;
    this.closePopover();
  }

  togglePopover() {
    const popover = this.root.querySelector('#appearanceVariantPopover');
    popover.hidden = !popover.hidden;
    this.root.querySelector('#appearanceVariantToggle').setAttribute('aria-expanded', String(!popover.hidden));
    if (!popover.hidden) this.root.querySelector('#appearanceVariantSearch').focus();
  }

  closePopover() {
    this.root.querySelector('#appearanceVariantPopover').hidden = true;
    this.root.querySelector('#appearanceVariantToggle').setAttribute('aria-expanded', 'false');
  }

  renderOptions(query = '') {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    const visible = this.options.filter(({ label }) => label.toLocaleLowerCase('zh-CN').includes(normalized));
    this.root.querySelector('#appearanceVariantOptions').innerHTML = visible.map(({ value, label }) => `
      <button type="button" role="option" data-appearance-variant="${escapeHtml(value)}" aria-selected="${value === this.currentValue}">
        <span class="appearance-option-thumbnail">${this.thumbnailMarkup(value)}</span>
        <span><strong>${escapeHtml(label)}</strong><small>${appearanceOptionMeta(value)}</small></span>
        <i aria-hidden="true">✓</i>
      </button>`).join('') || '<p class="appearance-variant-empty">没有匹配的外观</p>';
  }

  async select(value) {
    if (value === this.currentValue) { this.closePopover(); return; }
    const applied = new Promise((resolve) => this.viewer.addEventListener('variant-applied', resolve, { once: true }));
    if (!selectAppearanceVariant(this.viewer, value)) return;
    this.currentValue = value;
    this.closePopover();
    this.updateCurrentDisplay();
    await Promise.race([applied, new Promise((resolve) => setTimeout(resolve, 3000))]);
    await this.viewer.updateComplete;
    try {
      this.thumbnails.set(value, this.viewer.toDataURL('image/webp', 0.72));
      this.updateCurrentDisplay();
    } catch { /* retain the model cover when capture is unavailable */ }
    this.renderOptions(this.root.querySelector('#appearanceVariantSearch').value);
    this.onChange(value === APPEARANCE_ORIGINAL_VALUE ? null : value);
  }

  updateCurrentDisplay() {
    const option = this.options.find(({ value }) => value === this.currentValue);
    this.root.querySelector('#appearanceVariantName').textContent = option?.label ?? '原始外观';
    this.root.querySelector('#appearanceVariantMeta').textContent = appearanceOptionMeta(this.currentValue);
    this.root.querySelector('#appearanceVariantThumbnail').innerHTML = this.thumbnailMarkup(this.currentValue);
  }

  thumbnailMarkup(value) {
    const thumbnail = this.thumbnails.get(value);
    return thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="">` : '<i>3D</i>';
  }
}
