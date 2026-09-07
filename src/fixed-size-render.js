import { beginExportTextureDetail } from './render-quality.js';
import { $renderer } from '@google/model-viewer/lib/model-viewer-base.js';
import { applyViewerCameraFraming } from './camera-framing-application.js';
import { applyVerticalLensShift } from './vertical-lens-shift.js';
import {
  FixedSizeRenderError,
  hasRenderRestorationFailure,
  renderFixedSizeImage as renderFixedSizeImageCore,
} from './fixed-size-render-core.js';

export { FixedSizeRenderError, hasRenderRestorationFailure };

export function renderFixedSizeImage(viewer, options) {
  return renderFixedSizeImageCore(viewer, options, {
    beginTextureDetail: beginExportTextureDetail,
    createCameraFramingSession(target, framing) {
      return {
        async apply(dimensions) {
          await applyViewerCameraFraming(target, framing, {
            immediate: true,
            applyProjection: () => applyVerticalLensShift(target, framing.verticalShift, dimensions),
          });
        },
        async restore() {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await target.updateComplete;
          await applyViewerCameraFraming(target, framing, {
            immediate: true,
            applyProjection: () => applyVerticalLensShift(target, framing.verticalShift),
          });
        },
      };
    },
    readDrawingBuffer(viewer) {
      const context = viewer[$renderer]?.threeRenderer?.getContext?.();
      if (!context) return null;
      return { width: context.drawingBufferWidth, height: context.drawingBufferHeight };
    },
  });
}
