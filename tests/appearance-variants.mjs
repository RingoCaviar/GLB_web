import assert from 'node:assert/strict';
import {
  APPEARANCE_ORIGINAL_VALUE,
  appearanceVariantTemplate,
  appearanceOptions,
  resetAppearanceVariant,
  selectAppearanceVariant,
} from '../src/appearance-variants.js';

assert.deepEqual(appearanceOptions([]), []);
assert.deepEqual(appearanceOptions(['医疗蓝', '经典白']), [
  { value: APPEARANCE_ORIGINAL_VALUE, label: '原始外观' },
  { value: '医疗蓝', label: '医疗蓝' },
  { value: '经典白', label: '经典白' },
]);

const viewer = { availableVariants: ['医疗蓝', '经典白'], variantName: null };
assert.equal(selectAppearanceVariant(viewer, '医疗蓝'), true);
assert.equal(viewer.variantName, '医疗蓝');
assert.equal(selectAppearanceVariant(viewer, APPEARANCE_ORIGINAL_VALUE), true);
assert.equal(viewer.variantName, null);
viewer.variantName = '医疗蓝';
resetAppearanceVariant(viewer);
assert.equal(viewer.variantName, null);
assert.equal(selectAppearanceVariant(viewer, '不存在'), false);
assert.equal(viewer.variantName, null);

const template = appearanceVariantTemplate();
assert.match(template, /id="appearanceVariants" hidden/);
assert.match(template, /id="appearanceVariantToggle"[^>]*aria-haspopup="listbox"/);
assert.match(template, /id="appearanceVariantSearch"[^>]*type="search"/);

console.log('appearance variant tests passed');
