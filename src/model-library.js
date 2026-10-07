import modelMetadata from 'virtual:model-metadata';

const modelAssets = import.meta.glob('../models/**/*.glb', {
  eager: true,
  query: '?url',
  import: 'default',
});

const coverAssets = import.meta.glob([
  '../models/**/cover.{webp,png,jpg,jpeg}',
  '../models/**/*.cover.{webp,png,jpg,jpeg}',
], {
  eager: true,
  query: '?url',
  import: 'default',
});

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function relativePath(assetPath) {
  return assetPath.replace(/^\.\.\/models\//, '');
}

function withoutExtension(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function findThumbnail(assetPath) {
  const directory = assetPath.slice(0, assetPath.lastIndexOf('/') + 1);
  const baseName = withoutExtension(assetPath.slice(directory.length));
  const extensions = ['webp', 'png', 'jpg', 'jpeg'];
  for (const extension of extensions) {
    const specific = coverAssets[`${directory}${baseName}.cover.${extension}`];
    if (specific) return { url: specific, dedicated: true };
  }
  for (const extension of extensions) {
    const shared = coverAssets[`${directory}cover.${extension}`];
    if (shared) return { url: shared, dedicated: false };
  }
  return { url: null, dedicated: false };
}

export const models = Object.entries(modelAssets)
  .map(([assetPath, url]) => {
    const id = relativePath(assetPath);
    const segments = id.split('/');
    const filename = segments.pop();
    const thumbnail = findThumbnail(assetPath);
    return {
      id,
      name: withoutExtension(filename),
      folderPath: segments.join('/'),
      url,
      thumbnailUrl: thumbnail.url,
      hasDedicatedThumbnail: thumbnail.dedicated,
      addedAt: modelMetadata[id]?.addedAt ?? 0,
    };
  })
  .sort((left, right) => collator.compare(left.id, right.id));

export function folderThumbnailUrl(folderPath, availableModels = models) {
  const directory = `../models/${folderPath}/`;
  for (const extension of ['webp', 'png', 'jpg', 'jpeg']) {
    const cover = coverAssets[`${directory}cover.${extension}`];
    if (cover) return cover;
  }
  const prefix = `${folderPath}/`;
  return availableModels.find((model) =>
    model.folderPath === folderPath && model.thumbnailUrl)?.thumbnailUrl
    ?? availableModels.find((model) =>
      model.folderPath.startsWith(prefix) && model.thumbnailUrl)?.thumbnailUrl
    ?? null;
}

export function libraryEntries(currentFolder = '') {
  const prefix = currentFolder ? `${currentFolder}/` : '';
  const folders = new Set();
  const directModels = [];

  for (const model of models) {
    const isDirectModel = model.folderPath === currentFolder;
    if (!isDirectModel && !model.folderPath.startsWith(prefix)) continue;
    const remainder = isDirectModel ? '' : model.folderPath.slice(prefix.length);
    if (remainder) {
      folders.add(remainder.split('/')[0]);
    } else {
      directModels.push(model);
    }
  }

  return {
    folders: [...folders].sort(collator.compare),
    models: directModels.sort((left, right) => collator.compare(left.name, right.name)),
  };
}

export function parentFolder(folderPath) {
  const segments = folderPath.split('/').filter(Boolean);
  segments.pop();
  return segments.join('/');
}

export function recentModels(limit = 10) {
  return [...models]
    .sort((left, right) => right.addedAt - left.addedAt || collator.compare(left.id, right.id))
    .slice(0, Math.max(0, limit));
}
