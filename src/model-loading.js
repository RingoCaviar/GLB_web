export const ModelLoadResult = Object.freeze({
  READY: 'ready',
  CANCELLED: 'cancelled',
  LOAD_FAILED: 'load-failed',
  RESTORE_FAILED: 'restore-failed',
});

export class ModelLoadingModule {
  #revision = 0;
  #snapshot = { status: 'idle', model: null, error: null };
  #loadController = null;

  constructor({ adapter, cancelFixedSizeRender, resetRuntime, prepareModel }) {
    this.adapter = adapter;
    this.cancelFixedSizeRender = cancelFixedSizeRender;
    this.resetRuntime = resetRuntime;
    this.prepareModel = prepareModel;
  }

  getSnapshot() {
    return { ...this.#snapshot };
  }

  async select(model) {
    if (!model) return { status: ModelLoadResult.CANCELLED };
    if (this.#snapshot.status === ModelLoadResult.READY && this.#snapshot.model?.id === model.id) {
      return { status: ModelLoadResult.READY, model };
    }
    this.#loadController?.abort(new Error('MODEL_CHANGED'));
    const revision = ++this.#revision;
    const loadController = new AbortController();
    this.#loadController = loadController;
    this.#snapshot = { status: 'loading', model, error: null };
    try {
      await this.cancelFixedSizeRender();
      if (revision !== this.#revision) return { status: ModelLoadResult.CANCELLED, model };
      await this.resetRuntime();
      if (revision !== this.#revision) return { status: ModelLoadResult.CANCELLED, model };
    } catch (error) {
      if (revision !== this.#revision) return { status: ModelLoadResult.CANCELLED, model };
      this.#snapshot = { status: ModelLoadResult.RESTORE_FAILED, model, error };
      return this.getSnapshot();
    }

    try {
      await this.adapter.load(model, { signal: loadController.signal });
      if (revision !== this.#revision) return { status: ModelLoadResult.CANCELLED, model };
    } catch (error) {
      if (revision !== this.#revision || error?.name === 'AbortError') return { status: ModelLoadResult.CANCELLED, model };
      this.#snapshot = { status: ModelLoadResult.LOAD_FAILED, model, error };
      return this.getSnapshot();
    }

    try {
      await this.prepareModel(model);
      if (revision !== this.#revision) return { status: ModelLoadResult.CANCELLED, model };
      this.#snapshot = { status: ModelLoadResult.READY, model, error: null };
      return this.getSnapshot();
    } catch (error) {
      if (revision !== this.#revision) return { status: ModelLoadResult.CANCELLED, model };
      this.#snapshot = { status: ModelLoadResult.RESTORE_FAILED, model, error };
      return this.getSnapshot();
    }
  }
}
