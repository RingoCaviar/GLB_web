export function exportDimensionCapability(context) {
  if (!context?.getParameter) return { available: false, maximumDimension: null };
  const textureSize = Number(context.getParameter(context.MAX_TEXTURE_SIZE));
  const renderbufferSize = Number(context.getParameter(context.MAX_RENDERBUFFER_SIZE));
  if (!Number.isFinite(textureSize) || !Number.isFinite(renderbufferSize) || textureSize < 1 || renderbufferSize < 1) {
    return { available: false, maximumDimension: null };
  }
  return {
    available: true,
    maximumDimension: Math.min(textureSize, renderbufferSize),
    textureSize,
    renderbufferSize,
  };
}

export function readExportDimensionCapability(createCanvas = () => document.createElement('canvas')) {
  const canvas = createCanvas();
  return exportDimensionCapability(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
}
