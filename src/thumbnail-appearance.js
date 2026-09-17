import {
  APPEARANCE_ORIGINAL_VALUE,
  selectAppearanceVariant,
} from './appearance-variants.js';

function thumbnailAppearanceError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function ensureMaterialsLoaded(viewer) {
  try {
    await Promise.all((viewer.model?.materials ?? []).map((material) => material.ensureLoaded?.()));
  } catch (error) {
    throw thumbnailAppearanceError('MATERIAL_LOAD_FAILED', error);
  }
}

function waitForVariantApplied(viewer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timeout);
      viewer.removeEventListener('variant-applied', onApplied);
      error ? reject(error) : resolve();
    };
    const onApplied = () => finish();
    const timeout = setTimeout(
      () => finish(thumbnailAppearanceError('VARIANT_APPLY_TIMEOUT')),
      timeoutMs,
    );
    viewer.addEventListener('variant-applied', onApplied);
  });
}

export async function prepareThumbnailAppearance(viewer, chooseVariant, {
  timeoutMs = 3000,
  applySavedAppearance = () => {},
} = {}) {
  await ensureMaterialsLoaded(viewer);
  await applySavedAppearance();
  const variants = viewer.availableVariants ?? [];
  if (!variants.length) {
    viewer.variantName = null;
    return APPEARANCE_ORIGINAL_VALUE;
  }

  const options = [APPEARANCE_ORIGINAL_VALUE, ...variants];
  if (typeof chooseVariant !== 'function') {
    throw thumbnailAppearanceError('VARIANT_SELECTION_REQUIRED');
  }
  const selected = await chooseVariant(options);
  if (selected === null || selected === undefined) {
    throw thumbnailAppearanceError('THUMBNAIL_CANCELLED');
  }
  if (!options.includes(selected)) {
    throw thumbnailAppearanceError('VARIANT_UNAVAILABLE');
  }
  if (selected === APPEARANCE_ORIGINAL_VALUE) {
    viewer.variantName = null;
    await viewer.updateComplete;
    return selected;
  }

  const applied = waitForVariantApplied(viewer, timeoutMs);
  if (!selectAppearanceVariant(viewer, selected)) {
    throw thumbnailAppearanceError('VARIANT_UNAVAILABLE');
  }
  await applied;
  await viewer.updateComplete;
  await ensureMaterialsLoaded(viewer);
  return selected;
}
