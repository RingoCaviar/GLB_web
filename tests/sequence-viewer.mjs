import assert from 'node:assert/strict';
import { SequenceViewer } from '../src/sequence-viewer.js';

function fixture(id, frameCount, angleCount = 1) {
  return {
    id,
    totalFrames: frameCount * angleCount,
    angles: Array.from({ length: angleCount }, (_, ring) => ({
      angle: 5 + ring * 5,
      frames: Array.from({ length: frameCount }, (_, index) => ({
        index: index + 1,
        previewUrl: `${id}/${ring}/${index + 1}.webp`,
        originalUrl: `${id}/${ring}/${index + 1}.png`,
        originalFilename: `${id}_俯角${5 + ring * 5}_${index + 1}.png`,
      })),
    })),
  };
}

function makeHarness() {
  const requested = [];
  const pending = new Map();
  const animation = new Map();
  const painted = [];
  let nextAnimation = 0;
  let pointerX = 0;
  class FakeImage {
    naturalWidth = 1600;
    naturalHeight = 800;

    set src(url) {
      if (pending.get(this.url) === this) pending.delete(this.url);
      this.url = url;
      if (url) {
        requested.push(url);
        pending.set(url, this);
      }
    }

    get src() { return this.url; }
    decode() { return Promise.resolve(); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  }
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 600,
    clientHeight: 400,
    style: {},
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 400 }; },
    getContext() {
      return {
        globalAlpha: 1,
        clearRect() { painted.length = 0; },
        drawImage(image) { painted.push(image.url); },
        setTransform() {},
      };
    },
  });
  const root = {
    querySelector: () => canvas,
    getBoundingClientRect: () => canvas.getBoundingClientRect(),
    classList: { add() {}, remove() {}, toggle() {} },
  };
  const replacement = {
    Image: FakeImage,
    window: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: (fn) => { animation.set(++nextAnimation, fn); return nextAnimation; },
    cancelAnimationFrame: (id) => animation.delete(id),
  };
  const original = new Map(Object.keys(replacement).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacement)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  return {
    root, requested, pending, painted,
    restore() {
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
    tick(timestamp = 0) {
      for (const [id, callback] of [...animation]) {
        if (animation.delete(id)) callback(timestamp);
      }
    },
    pointer(type, dx = 0) {
      pointerX = type === 'pointerdown' ? 300 : pointerX + dx;
      canvas.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, clientX: pointerX, clientY: 100, button: 0 }));
    },
    async respond(url, success = true) {
      const image = pending.get(url);
      assert.ok(image, `${url} was not requested`);
      pending.delete(url);
      image[success ? 'onload' : 'onerror']?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    async finishNearby() {
      let count = 0;
      while (pending.size) {
        assert.ok(++count <= 32, 'Loading a local window should not fetch the complete product');
        await this.respond(pending.keys().next().value);
      }
    },
  };
}

export async function checkSequenceViewer() {
  const harness = makeHarness();
  const { root, requested, pending, painted } = harness;
  const viewer = new SequenceViewer(root, { concurrency: 3, maxImages: 8 });
  try {
    const product = fixture('first', 120, 3);
    let loadFinished = false;
    viewer.load(product).then(() => { loadFinished = true; });
    assert.equal(viewer.snapshot().ready, false);
    assert.equal(requested[0], 'first/0/1.webp');
    assert.ok(pending.size <= 3);
    await harness.respond('first/0/1.webp');
    assert.equal(viewer.snapshot().ready, true, 'The first decoded image should unlock rotation');
    assert.equal(loadFinished, true, 'Initial load must finish without waiting for prefetched frames');
    assert.equal(viewer.snapshot().frame.originalFilename, 'first_俯角5_1.png');
    assert.deepEqual(painted, ['first/0/1.webp']);
    assert.ok(requested.includes('first/0/120.webp'), 'The initial window should preload across the seam');

    await harness.finishNearby();
    assert.ok(requested.length < 20, 'Opening a product should load only its local window');
    assert.ok(viewer.snapshot().resident <= 8);
    harness.pointer('pointerdown');
    harness.pointer('pointermove', -9);
    harness.tick();
    assert.equal(viewer.snapshot().transitioning, true);
    assert.equal(viewer.snapshot().transitionProgress, 0.5);
    assert.deepEqual(painted, ['first/0/120.webp', 'first/0/1.webp']);
    harness.pointer('pointermove', -9);
    harness.tick();
    harness.pointer('pointerup');
    assert.equal(viewer.snapshot().frame.index, 120, 'Dragging backward crosses from the first to the last frame');
    harness.pointer('pointerdown');
    harness.pointer('pointermove', 18);
    harness.tick();
    harness.pointer('pointerup');
    assert.equal(viewer.snapshot().frame.index, 1, 'Dragging forward crosses from the last to the first frame');

    viewer.showFrame(51);
    assert.equal(viewer.snapshot().buffering, true);
    assert.equal(viewer.snapshot().frame.originalFilename, 'first_俯角5_1.png');
    assert.ok(painted.includes('first/0/1.webp'), 'The last visible image should survive a slow seek');
    await harness.respond('first/0/52.webp');
    assert.equal(viewer.snapshot().frame.index, 52);
    assert.equal(viewer.snapshot().buffering, false);
    assert.ok(viewer.snapshot().resident <= 8);

    viewer.showAngle(1);
    assert.equal(viewer.snapshot().angle, 5);
    assert.equal(viewer.snapshot().buffering, true);
    await harness.respond('first/1/52.webp', false);
    await harness.respond('first/1/52.webp', false);
    assert.equal(viewer.snapshot().ready, true);
    assert.equal(viewer.snapshot().frameFailed, true);
    assert.equal(viewer.snapshot().frame.originalUrl, 'first/0/52.png');
    viewer.retryFailed();
    await harness.respond('first/1/52.webp');
    assert.equal(viewer.snapshot().angle, 10);
    assert.equal(viewer.snapshot().frameFailed, false);
    assert.equal(viewer.snapshot().frame.originalUrl, 'first/1/52.png');

    viewer.showFrame(90);
    const stale = pending.get('first/1/91.webp')?.onload;
    assert.equal(typeof stale, 'function');
    const next = viewer.load(fixture('second', 4));
    stale();
    assert.equal(viewer.snapshot().ready, false);
    await harness.respond('second/0/1.webp');
    await next;
    await harness.finishNearby();
    assert.equal(viewer.snapshot().frame.originalUrl, 'second/0/1.png');
    assert.ok(painted.every((url) => url.startsWith('second/')));

    viewer.setPlaying(true);
    harness.tick(0);
    for (let timestamp = 125; timestamp <= 625; timestamp += 125) harness.tick(timestamp);
    assert.equal(viewer.snapshot().frame.index, 4, 'Auto rotation stops on the final frame');
    assert.equal(viewer.snapshot().playing, false);
    assert.equal(viewer.snapshot().playbackComplete, true);
    viewer.unload();
    assert.equal(viewer.snapshot().resident, 0);
    assert.equal(pending.size, 0);

    const dragProduct = fixture('drag', 36);
    for (const frame of dragProduct.angles[0].frames) frame.dragUrl = `drag/0/${frame.index}-small.webp`;
    const start = viewer.load(dragProduct);
    await harness.respond('drag/0/1-small.webp');
    await start;
    await harness.finishNearby();
    assert.deepEqual(painted, ['drag/0/1.webp'], 'The still view should sharpen after the first lightweight frame');

    harness.pointer('pointerdown');
    harness.pointer('pointermove', -72);
    harness.tick();
    assert.equal(viewer.snapshot().frame.index, 34, 'An already decoded frame should move the view toward a missing drag target across the seam');
    assert.deepEqual(painted, ['drag/0/34-small.webp']);
    harness.pointer('pointermove', -126);
    harness.tick();
    assert.ok(pending.has('drag/0/33-small.webp'), 'A fast drag should let an active frame finish even after it leaves the preload window');
    await harness.respond('drag/0/33-small.webp');
    assert.equal(viewer.snapshot().frame.index, 33);
    assert.ok(!pending.has('drag/0/33.webp'), 'A drag should use the lightweight preview until release');
    harness.pointer('pointerup');
    assert.equal(viewer.snapshot().frame.index, 33, 'Keep the visible frame until the exact release position is decoded');
    await harness.finishNearby();
    assert.deepEqual(painted, ['drag/0/26.webp']);
    assert.equal(viewer.snapshot().frame.originalUrl, 'drag/0/26.png');
  } finally {
    viewer.unload();
    harness.restore();
  }
}
