export function modelsInFolder(models, folderPath) {
  const prefix = folderPath ? `${folderPath}/` : '';
  return models.filter((model) => model.folderPath === folderPath || model.folderPath.startsWith(prefix));
}

export async function runThumbnailBatch(models, worker, {
  shouldStop = () => false,
  onProgress = () => {},
} = {}) {
  const result = {
    successIds: [],
    skippedIds: [],
    unchangedIds: [],
    failedIds: [],
    pendingIds: [],
    issues: [],
    stopped: false,
  };
  for (let index = 0; index < models.length; index++) {
    if (shouldStop()) {
      result.stopped = true;
      result.pendingIds = models.slice(index).map(({ id }) => id);
      break;
    }
    const model = models[index];
    onProgress({ phase: 'started', model, index, total: models.length, result });
    try {
      const outcome = await worker(model, index);
      if (outcome?.status === 'unchanged') {
        result.unchangedIds.push(model.id);
      } else if (outcome?.status === 'skipped') {
        result.skippedIds.push(model.id);
        result.issues.push({ id: model.id, name: model.name, status: 'skipped', reason: outcome.reason });
      } else {
        result.successIds.push(model.id);
      }
    } catch (error) {
      result.failedIds.push(model.id);
      result.issues.push({ id: model.id, name: model.name, status: 'failed', reason: error.message });
    }
    onProgress({ phase: 'finished', model, index, total: models.length, result });
  }
  return result;
}
