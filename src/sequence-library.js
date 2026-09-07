const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export let sequenceProducts = [];
export let sequenceWarnings = [];
export let sequenceWritable = false;

export async function refreshSequenceLibrary() {
  const response = await fetch('/__sequence/library', { cache: 'no-store' });
  if (!response.ok) throw new Error(`SEQUENCE_LIBRARY_${response.status}`);
  const data = await response.json();
  sequenceProducts = Array.isArray(data.products) ? data.products : [];
  sequenceWarnings = Array.isArray(data.warnings) ? data.warnings : [];
  sequenceWritable = Boolean(data.writable);
  return data;
}

export function sequenceLibraryEntries(currentFolder = '') {
  const prefix = currentFolder ? `${currentFolder}/` : '';
  const folders = new Set();
  const products = [];
  for (const product of sequenceProducts) {
    const direct = product.folderPath === currentFolder;
    if (!direct && !product.folderPath.startsWith(prefix)) continue;
    const remainder = direct ? '' : product.folderPath.slice(prefix.length);
    if (remainder) folders.add(remainder.split('/')[0]);
    else products.push(product);
  }
  return { folders: [...folders].sort(collator.compare), products };
}

export function sequenceParentFolder(folderPath) {
  return folderPath.split('/').filter(Boolean).slice(0, -1).join('/');
}
