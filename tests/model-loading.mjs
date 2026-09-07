import assert from 'node:assert/strict';
import { ModelLoadingModule } from '../src/model-loading.js';
import { ModelViewerLoadingAdapter } from '../src/model-viewer-loading-adapter.js';

function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture() {
  const load = deferred(); const calls = [];
  const module = new ModelLoadingModule({
    adapter: { load: async () => load.promise },
    cancelFixedSizeRender: async () => calls.push('cancel'),
    resetRuntime: async () => calls.push('reset'),
    prepareModel: async () => calls.push('prepare'),
  });
  return { module, load, calls };
}
const model = { id: 'a', name: 'A', url: '/a.glb' };
{
  const viewer = new EventTarget();
  viewer.src = ''; viewer.alt = ''; viewer.updateComplete = Promise.resolve();
  viewer.removeAttribute = () => { viewer.src = ''; };
  const adapter = new ModelViewerLoadingAdapter(viewer, { baseUrl: 'https://example.test/' });
  const task = adapter.load({ ...model, id: 'b', url: '/b.glb' });
  viewer.dispatchEvent(new CustomEvent('error', { detail: { sourceError: new Error('unknown source') } }));
  viewer.dispatchEvent(new CustomEvent('load', { detail: { url: '/b.glb' } }));
  await task;
}
{
  const { module, load, calls } = fixture(); const task = module.select(model);
  assert.equal(module.getSnapshot().status, 'loading'); load.resolve();
  assert.equal((await task).status, 'ready'); assert.deepEqual(calls, ['cancel', 'reset', 'prepare']);
}
{
  const { module, load } = fixture(); const task = module.select(model); load.reject(new Error('bad'));
  assert.equal((await task).status, 'load-failed');
}
{
  const pending = new Map();
  const module = new ModelLoadingModule({
    adapter: { load: (item, { signal }) => new Promise((resolve, reject) => {
      pending.set(item.id, { resolve, reject });
      signal.addEventListener('abort', () => {
        const error = new Error('cancelled'); error.name = 'AbortError'; reject(error);
      }, { once: true });
    }) },
    cancelFixedSizeRender: async () => {}, resetRuntime: async () => {}, prepareModel: async () => {},
  });
  const first = module.select(model);
  const second = module.select({ ...model, id: 'b' });
  assert.equal((await first).status, 'cancelled');
  await Promise.resolve();
  pending.get('b').resolve();
  assert.equal((await second).status, 'ready');
}
{
  const module = new ModelLoadingModule({ adapter: { load: async () => {} }, cancelFixedSizeRender: async () => { throw new Error('restore'); }, resetRuntime: async () => {}, prepareModel: async () => {} });
  assert.equal((await module.select(model)).status, 'restore-failed');
}
console.log('model loading tests passed');
