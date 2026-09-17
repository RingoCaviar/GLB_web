import assert from 'node:assert/strict';
import { APPEARANCE_ORIGINAL_VALUE } from '../src/appearance-variants.js';
import { prepareThumbnailAppearance } from '../src/thumbnail-appearance.js';

class FakeViewer extends EventTarget {
  constructor(variants = []) {
    super();
    this.availableVariants = variants;
    this._variantName = null;
    this.loadedMaterials = [];
    this.model = {
      materials: ['front', 'side'].map((name) => ({
        name,
        ensureLoaded: async () => this.loadedMaterials.push(`${name}:${this.variantName ?? 'original'}`),
      })),
    };
    this.updateComplete = Promise.resolve();
  }

  get variantName() { return this._variantName; }
  set variantName(value) {
    this._variantName = value;
    if (value) queueMicrotask(() => this.dispatchEvent(new Event('variant-applied')));
  }
}

{
  const viewer = new FakeViewer();
  let chose = false;
  const selected = await prepareThumbnailAppearance(viewer, async () => { chose = true; });
  assert.equal(selected, APPEARANCE_ORIGINAL_VALUE);
  assert.equal(chose, false, '无外观变体时不应要求用户选择');
  assert.deepEqual(viewer.loadedMaterials, ['front:original', 'side:original']);
}

{
  const viewer = new FakeViewer(['0.5ML', '1ML']);
  let savedAppearanceApplied = false;
  const selected = await prepareThumbnailAppearance(viewer, async (options) => {
    assert.equal(savedAppearanceApplied, true, '已保存模型外观应在用户选择变体前应用');
    assert.deepEqual(options, [APPEARANCE_ORIGINAL_VALUE, '0.5ML', '1ML']);
    return '0.5ML';
  }, {
    timeoutMs: 100,
    applySavedAppearance: () => { savedAppearanceApplied = true; },
  });
  assert.equal(selected, '0.5ML');
  assert.equal(viewer.variantName, '0.5ML');
}

{
  const viewer = new FakeViewer(['0.5ML']);
  await assert.rejects(
    prepareThumbnailAppearance(viewer),
    (error) => error.code === 'VARIANT_SELECTION_REQUIRED',
  );
}

{
  const viewer = new FakeViewer(['0.5ML']);
  await assert.rejects(
    prepareThumbnailAppearance(viewer, async () => null),
    (error) => error.code === 'THUMBNAIL_CANCELLED',
  );
}

{
  const viewer = new FakeViewer();
  viewer.model.materials[0].ensureLoaded = async () => { throw new Error('texture failed'); };
  await assert.rejects(
    prepareThumbnailAppearance(viewer),
    (error) => error.code === 'MATERIAL_LOAD_FAILED' && error.cause?.message === 'texture failed',
  );
}

{
  const viewer = new FakeViewer(['0.5ML']);
  await assert.rejects(
    prepareThumbnailAppearance(viewer, async () => 'missing', { timeoutMs: 10 }),
    (error) => error.code === 'VARIANT_UNAVAILABLE',
  );
}

{
  const viewer = new FakeViewer(['0.5ML']);
  Object.defineProperty(viewer, 'variantName', {
    get: () => viewer._variantName,
    set: (value) => { viewer._variantName = value; },
  });
  await assert.rejects(
    prepareThumbnailAppearance(viewer, async () => '0.5ML', { timeoutMs: 5 }),
    (error) => error.code === 'VARIANT_APPLY_TIMEOUT',
  );
}

console.log('缩略图材质与外观变体测试通过');
