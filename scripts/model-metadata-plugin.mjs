import { promises as fs } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const MODULE_ID = 'virtual:model-metadata';
const RESOLVED_MODULE_ID = `\0${MODULE_ID}`;

async function scanGlbFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await scanGlbFiles(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.glb')) files.push(path);
  }
  return files;
}

export async function collectModelMetadata(projectRoot) {
  const modelsRoot = resolve(projectRoot, 'models');
  const metadata = {};
  for (const path of await scanGlbFiles(modelsRoot)) {
    const stats = await fs.stat(path);
    const id = relative(modelsRoot, path).split(sep).join('/');
    metadata[id] = {
      addedAt: Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0
        ? stats.birthtimeMs
        : stats.mtimeMs,
    };
  }
  return metadata;
}

export function modelMetadataPlugin() {
  let projectRoot = process.cwd();
  return {
    name: 'model-library-metadata',
    configResolved(config) {
      projectRoot = config.root;
    },
    resolveId(id) {
      if (id === MODULE_ID) return RESOLVED_MODULE_ID;
    },
    async load(id) {
      if (id !== RESOLVED_MODULE_ID) return;
      return `export default ${JSON.stringify(await collectModelMetadata(projectRoot))};`;
    },
  };
}
