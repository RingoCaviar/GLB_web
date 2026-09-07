export class ModelViewerLoadingAdapter {
  constructor(viewer, { baseUrl = window.location.href } = {}) {
    this.viewer = viewer;
    this.baseUrl = baseUrl;
  }

  async load(model, { signal } = {}) {
    const expectedUrl = new URL(model.url, this.baseUrl).href;
    this.viewer.alt = `${model.name} 三维模型`;
    if (this.viewer.src === expectedUrl) {
      this.viewer.removeAttribute('src');
      await this.viewer.updateComplete;
    }
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        this.viewer.removeEventListener('load', onLoad);
        this.viewer.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve();
      };
      const onLoad = (event) => {
        const loadedUrl = new URL(event.detail?.url || '', this.baseUrl).href;
        if (loadedUrl === expectedUrl) finish();
      };
      const onError = (event) => {
        if (!event.detail?.url) return;
        const failedUrl = new URL(event.detail.url, this.baseUrl).href;
        if (failedUrl === expectedUrl) finish(event.detail.sourceError ?? new Error('MODEL_LOAD_FAILED'));
      };
      const onAbort = () => {
        const error = new Error('MODEL_LOAD_CANCELLED');
        error.name = 'AbortError';
        finish(error);
      };
      this.viewer.addEventListener('load', onLoad);
      this.viewer.addEventListener('error', onError);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.viewer.src = model.url;
    });
  }
}
