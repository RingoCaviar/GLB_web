import { $needsRender, $scene } from '@google/model-viewer/lib/model-viewer-base.js';
import { createVerticalLensShiftAdapter } from './vertical-lens-shift-core.js';

export {
  VERTICAL_LENS_SHIFT_LIMIT,
  sanitizeVerticalLensShift,
  applyVerticalPerspectiveCorrection,
} from './vertical-lens-shift-core.js';

export const { applyVerticalLensShift, verticalLensShiftCapability } = createVerticalLensShiftAdapter({
  getScene: (viewer) => viewer?.[$scene],
  requestRender: (viewer) => viewer?.[$needsRender]?.(),
  canRequestRender: (viewer) => typeof viewer?.[$needsRender] === 'function',
});
