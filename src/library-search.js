function searchableText(item) {
  return [item.name, item.folderPath, item.id].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
}

export function filterLibraryItems(items, query) {
  const terms = String(query).trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.filter((item) => {
    const text = searchableText(item);
    return terms.every((term) => text.includes(term));
  });
}
