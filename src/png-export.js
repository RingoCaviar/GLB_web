function canvasToBlob(canvas, mimeType = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Unable to encode export canvas'));
    }, mimeType);
  });
}

function luma(data, offset) {
  return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
}

/** A color-preserving FXAA-style edge blend for a final-size RGBA image. */
export function fxaaPixels(source, width, height) {
  const output = new Uint8ClampedArray(source);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const offset = (y * width + x) * 4;
      const center = luma(source, offset);
      const north = luma(source, offset - width * 4);
      const south = luma(source, offset + width * 4);
      const west = luma(source, offset - 4);
      const east = luma(source, offset + 4);
      const minimum = Math.min(center, north, south, west, east);
      const maximum = Math.max(center, north, south, west, east);
      const range = maximum - minimum;
      const threshold = Math.max(8, maximum * 0.125);
      if (range < threshold) continue;
      const blend = Math.min(0.38, (range - threshold) / Math.max(range, 1) * 0.38);
      for (let channel = 0; channel < 3; channel++) {
        const average = (source[offset - width * 4 + channel] + source[offset + width * 4 + channel] + source[offset - 4 + channel] + source[offset + 4 + channel]) / 4;
        output[offset + channel] = source[offset + channel] * (1 - blend) + average * blend;
      }
    }
  }
  return output;
}

export async function finalizePngExport(sourceBlob, {
  transparent,
  background,
  width,
  height,
  antiAlias = 'none',
  createBitmap,
  createCanvas,
} = {}) {
  if (transparent && width === undefined && height === undefined) return sourceBlob;
  const bitmapLoader = createBitmap ?? globalThis.createImageBitmap;
  const canvasFactory = createCanvas ?? (() => document.createElement('canvas'));
  if (!bitmapLoader) throw new Error('EXPORT_BITMAP_UNAVAILABLE');
  const bitmap = await bitmapLoader(sourceBlob);
  try {
    const outputWidth = width ?? bitmap.width;
    const outputHeight = height ?? bitmap.height;
    if (transparent && outputWidth === bitmap.width && outputHeight === bitmap.height) return sourceBlob;
    const canvas = canvasFactory();
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('EXPORT_CANVAS_UNAVAILABLE');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    if (!transparent) {
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (antiAlias === 'fxaa') {
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      image.data.set(fxaaPixels(image.data, canvas.width, canvas.height));
      context.putImageData(image, 0, 0);
    }
    return await canvasToBlob(canvas);
  } finally {
    bitmap.close?.();
  }
}
