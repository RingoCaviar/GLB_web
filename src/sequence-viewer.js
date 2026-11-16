const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const frameSource = (frame) => frame?.dragUrl ?? frame?.previewUrl ?? frame?.originalUrl;
const detailSource = (frame) => frame?.dragUrl && frame.previewUrl !== frame.dragUrl ? frame.previewUrl : undefined;
const MAX_DRAG_LAG = 8;
const DRAG_PREVIEW_EDGE = 640;
const MAX_RING_BYTES = 96 * 1024 ** 2;

function loadSequencePreference(name, storage) {
  try {
    return (storage ?? globalThis.localStorage)?.getItem(`glb-viewer:sequence-${name}:v1`) === 'true';
  } catch {
    return false;
  }
}

function saveSequencePreference(name, value, storage) {
  try {
    (storage ?? globalThis.localStorage)?.setItem(`glb-viewer:sequence-${name}:v1`, String(value));
  } catch { /* optional persistence */ }
}

function dragFrameBytes(frame) {
  const { width, height } = frame;
  const hasDimensions = width > 0 && height > 0;
  if (!frame.dragUrl && (!frame.previewUrl || !hasDimensions || Math.max(width, height) > DRAG_PREVIEW_EDGE)) return Infinity;
  if (!hasDimensions) return 4 * DRAG_PREVIEW_EDGE ** 2;
  const scale = Math.min(1, DRAG_PREVIEW_EDGE / Math.max(width, height));
  return 4 * Math.ceil(width * scale) * Math.ceil(height * scale);
}

export function buildPreloadOrder(product, angleIndex = 0, frameIndex = 0,
  { radius = 3, direction = 1, includeAdjacent = true } = {}) {
  const frames = product?.angles[angleIndex]?.frames;
  if (!frames?.length) return [];
  const current = frames[frameIndex];
  const order = [current];
  for (let distance = 1; distance <= Math.min(radius, frames.length - 1); distance++) {
    order.push(frames[manualFrameIndex(frameIndex + distance * direction, frames.length)]);
    order.push(frames[manualFrameIndex(frameIndex - distance * direction, frames.length)]);
  }
  if (includeAdjacent) {
    for (const index of [angleIndex - 1, angleIndex + 1]) {
      const adjacent = product.angles[index]?.frames;
      if (adjacent?.length) order.push(adjacent.find((frame) => frame.index === current?.index)
        ?? adjacent[Math.min(frameIndex, adjacent.length - 1)]);
    }
  }
  return [...new Map(order.filter(frameSource).map((frame) => [frameSource(frame), frame])).values()];
}

export function manualFrameIndex(index, frameCount, loop = true) {
  if (frameCount <= 0) return 0;
  return loop ? ((index % frameCount) + frameCount) % frameCount : clamp(index, 0, frameCount - 1);
}

export function horizontalDragFrame(startFrame, deltaX, reverse = false, pixelsPerFrame = 18) {
  return startFrame + deltaX / pixelsPerFrame * (reverse ? 1 : -1);
}

export function blendFrameState(position, frameCount, loop = false) {
  if (frameCount <= 0) return { position: 0, current: 0, next: 0, progress: 0, display: 0 };
  const normalized = manualFrameIndex(position, frameCount, loop);
  const current = Math.floor(normalized);
  const next = manualFrameIndex(current + 1, frameCount, loop);
  const progress = next === current ? 0 : normalized - current;
  return { position: normalized, current, next, progress, display: progress >= .5 ? next : current };
}

export function smoothstep(value) {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

export class SequenceViewer extends EventTarget {
  constructor(root, { concurrency = 4, maxImages, storage } = {}) {
    super();
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.context = this.canvas.getContext('2d', { alpha: true });
    this.maxImages = Math.max(3, maxImages ?? 12);
    this.maxRingImages = maxImages ?? Infinity;
    this.concurrency = clamp(concurrency, 1, this.maxImages);
    this.preloadWholeRing = false;
    this.product = null;
    this.angleIndex = 0;
    this.requestedAngleIndex = 0;
    this.frameIndex = 0;
    this.renderPosition = 0;
    this.painted = null;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.images = new Map();
    this.inFlight = new Map();
    this.failed = new Set();
    this.retried = new Set();
    this.pointers = new Map();
    this.gesture = null;
    this.finishInitialLoad = null;
    this.loading = false;
    this.ready = false;
    this.playing = false;
    this.storage = storage;
    this.autoRotate = loadSequencePreference('auto-rotate', storage);
    this.reverse = loadSequencePreference('reverse', storage);
    this.requestDirection = 1;
    this.playbackComplete = false;
    this.playTimer = 0;
    this.renderFrame = 0;
    this.pendingRenderPosition = null;
    this.playStartedAt = null;
    this.playFrame = 0;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.bindEvents();
  }

  get angle() { return this.product?.angles[this.angleIndex] ?? null; }
  get requestedAngle() { return this.product?.angles[this.requestedAngleIndex] ?? null; }
  get requestedFrame() { return this.requestedAngle?.frames[this.blendState().display] ?? null; }
  get frame() { return this.ready ? this.angle?.frames[this.frameIndex] ?? null : null; }
  get total() { return this.product?.totalFrames ?? 0; }
  get frameFailed() { return this.failed.has(frameSource(this.requestedFrame)); }
  get dragging() {
    return this.gesture?.mode === 'horizontal' && this.gesture.angle === this.requestedAngleIndex;
  }
  get buffering() {
    const key = this.imageSource(this.requestedFrame);
    return this.ready && Boolean(key) && !this.images.has(key) && !this.frameFailed;
  }
  get settledDetail() {
    const frame = this.requestedFrame;
    return !this.dragging && !this.playing && this.images.has(frameSource(frame)) ? detailSource(frame) : undefined;
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { ...this.snapshot(), ...detail } }));
  }

  snapshot() {
    const progress = this.painted?.progress ?? 0;
    return {
      product: this.product,
      angle: this.angle?.angle ?? null,
      frame: this.frame,
      framePosition: this.frameIndex + 1,
      frameCount: this.angle?.frames.length ?? 0,
      framePositionFloat: this.renderPosition,
      displayFrameIndex: this.frameIndex,
      transitionProgress: progress,
      transitioning: progress > 0,
      resident: this.images.size,
      total: this.total,
      failed: this.failed.size,
      frameFailed: this.frameFailed,
      buffering: this.buffering,
      scale: this.scale,
      loading: this.loading,
      ready: this.ready,
      playing: this.playing,
      autoRotate: this.autoRotate,
      reverse: this.reverse,
      playbackComplete: this.playbackComplete,
    };
  }

  async load(product) {
    this.unload();
    this.product = product;
    this.setRequestedAngle(product.angles.reduce((best, item, index, list) =>
      Math.abs(item.angle - 5) < Math.abs(list[best].angle - 5) ? index : best, 0));
    this.angleIndex = this.requestedAngleIndex;
    if (!this.requestedAngle?.frames.length) {
      this.emit('viewererror', { error: new Error('EMPTY_SEQUENCE') });
      return;
    }
    this.loading = true;
    const firstFrame = new Promise((resolve) => { this.finishInitialLoad = resolve; });
    this.emit('change');
    this.preload();
    await firstFrame;
  }

  retryFailed() {
    if (!this.product || !this.failed.size) return;
    this.failed.clear();
    this.retried.clear();
    this.loading = !this.ready;
    this.preload();
    this.emit('progress');
  }

  unload() {
    this.playing = false;
    cancelAnimationFrame(this.playTimer);
    this.playTimer = 0;
    this.playStartedAt = null;
    this.finishInitialLoad?.();
    this.finishInitialLoad = null;
    for (const key of this.inFlight.keys()) this.cancelFrame(key);
    for (const image of this.images.values()) this.releaseImage(image);
    this.product = null;
    this.images.clear();
    this.failed.clear();
    this.retried.clear();
    this.pointers.clear();
    this.gesture = null;
    this.painted = null;
    this.loading = false;
    this.ready = false;
    this.playbackComplete = false;
    this.angleIndex = this.requestedAngleIndex = this.frameIndex = 0;
    this.preloadWholeRing = false;
    this.renderPosition = 0;
    this.requestDirection = 1;
    this.pendingRenderPosition = null;
    cancelAnimationFrame(this.renderFrame);
    this.renderFrame = 0;
    this.root.classList.remove('ready');
    this.scale = 1;
    this.offsetX = this.offsetY = 0;
    this.draw();
  }

  blendState(position = this.renderPosition, loop = !this.playing) {
    return blendFrameState(position, this.requestedAngle?.frames.length ?? 0, loop);
  }

  releaseImage(image) {
    image.onload = image.onerror = null;
    image.removeAttribute('src');
  }

  cancelFrame(key) {
    this.releaseImage(this.inFlight.get(key));
    this.inFlight.delete(key);
  }

  setRequestedAngle(index) {
    this.requestedAngleIndex = index;
    const frames = this.requestedAngle?.frames;
    this.preloadWholeRing = Boolean(frames?.length) && frames.length + 3 <= this.maxRingImages
      && frames.reduce((bytes, frame) => bytes + dragFrameBytes(frame), 0) <= MAX_RING_BYTES;
  }

  preloadKeys(detail) {
    const blend = this.blendState();
    const frames = this.requestedAngle?.frames;
    const nearby = buildPreloadOrder(this.product, this.requestedAngleIndex, blend.display, {
      direction: this.requestDirection,
      radius: this.preloadWholeRing ? Math.floor(frames.length / 2) : 3,
      includeAdjacent: !this.preloadWholeRing,
    }).map(frameSource);
    if (blend.progress > .001 && !this.reducedMotion.matches) {
      const other = blend.display === blend.current ? blend.next : blend.current;
      nearby.splice(1, 0, frameSource(frames[other]));
    }
    if (this.playing) nearby.splice(1, 0, frameSource(frames[this.nextPlayableFrame()]));
    if (detail) nearby.splice(1, 0, detail);
    // Leave space for the last painted view until its replacement can be drawn.
    const retained = new Set([this.painted?.current, this.painted?.next].filter(Boolean));
    const queue = [];
    for (const key of new Set(nearby.filter(Boolean))) {
      if (!this.preloadWholeRing && !retained.has(key) && retained.size >= this.maxImages) continue;
      retained.add(key);
      queue.push(key);
    }
    if (!this.ready && queue.every((key) => this.failed.has(key))) {
      // Keep looking for the first usable frame when the initial window is damaged.
      for (const { frames: candidates } of this.product.angles) {
        const fallback = candidates.find((frame) => frameSource(frame) && !this.failed.has(frameSource(frame)));
        if (!fallback) continue;
        queue.push(frameSource(fallback));
        break;
      }
    }
    return queue;
  }

  preload() {
    if (!this.product) return;
    const detail = this.settledDetail;
    const queue = this.preloadKeys(detail);
    const wanted = new Set(queue);
    this.trimImages(wanted);
    // A sliding drag target can outrun a conversion. Give the current ring's
    // active requests time to finish, then use the newest target for free slots.
    const dragSources = this.dragging ? this.gesture.sources : null;
    for (const key of this.inFlight.keys()) {
      if (!wanted.has(key) && !dragSources?.has(key)) this.cancelFrame(key);
    }
    const needed = queue.filter((key) => !this.images.has(key) && !this.inFlight.has(key) && !this.failed.has(key));
    const requested = frameSource(this.requestedFrame);
    if (!dragSources && requested && needed[0] === requested && this.inFlight.size === this.concurrency) {
      const lowestPriority = queue.findLast((key) => this.inFlight.has(key));
      if (lowestPriority) this.cancelFrame(lowestPriority);
    }
    for (const key of needed.slice(0, this.concurrency - this.inFlight.size)) {
      // The server prioritizes drag previews. Let existing requests drain so
      // the exact settled image can start before more background work arrives.
      if (this.preloadWholeRing && this.inFlight.has(detail)) break;
      this.loadFrame(key);
    }
    if (this.loading && !this.inFlight.size) this.finishLoading('loaderror');
  }

  finishLoading(event) {
    this.loading = false;
    this.finishInitialLoad?.();
    this.finishInitialLoad = null;
    this.emit(event);
  }

  loadFrame(key) {
    const image = new Image();
    image.decoding = 'async';
    const loaded = () => {
      if (this.inFlight.get(key) !== image) return;
      const frame = this.frame;
      const buffering = this.buffering;
      this.inFlight.delete(key);
      image.onload = image.onerror = null;
      this.images.set(key, image);
      this.retried.delete(key);
      if (!this.ready) this.showFirstImage(key);
      else this.updateDisplayedFrame();
      this.preload();
      if (frame && (frame !== this.frame || buffering !== this.buffering)) this.emit('progress');
    };
    const failed = () => {
      if (this.inFlight.get(key) !== image) return;
      this.cancelFrame(key);
      if (this.retried.delete(key)) {
        this.failed.add(key);
        const requested = key === frameSource(this.requestedFrame);
        this.emit('frameerror', { requested, failedSource: key });
      } else this.retried.add(key);
      this.preload();
      this.emit('progress');
    };
    image.onload = () => {
      if (image.decode) image.decode().then(loaded, failed);
      else loaded();
    };
    image.onerror = failed;
    this.inFlight.set(key, image);
    image.src = key;
  }

  showFirstImage(key) {
    this.angleIndex = this.product.angles.findIndex((angle) => angle.frames.some((frame) => frameSource(frame) === key));
    this.frameIndex = this.angle.frames.findIndex((frame) => frameSource(frame) === key);
    if (this.frameFailed) {
      this.setRequestedAngle(this.angleIndex);
      this.renderPosition = this.frameIndex;
    }
    this.ready = true;
    this.painted = { current: key, progress: 0 };
    this.root.classList.add('ready');
    this.draw();
    this.finishLoading('ready');
    if (this.autoRotate) this.setPlaying(true);
  }

  trimImages(wanted, discardUnwanted = this.preloadWholeRing) {
    for (const [key, image] of this.images) {
      if (!discardUnwanted && this.images.size <= this.maxImages) return;
      if (wanted.has(key) || key === this.painted?.current || key === this.painted?.next) continue;
      this.releaseImage(image);
      this.images.delete(key);
    }
  }

  resize() {
    const rect = this.root.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.context.clearRect(0, 0, width, height);
    if (!this.painted) return;
    const drawImage = (image, alpha) => {
      const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight);
      const drawWidth = image.naturalWidth * fit * this.scale;
      const drawHeight = image.naturalHeight * fit * this.scale;
      this.context.globalAlpha = alpha;
      this.context.drawImage(image, (width - drawWidth) / 2 + this.offsetX,
        (height - drawHeight) / 2 + this.offsetY, drawWidth, drawHeight);
    };
    const { current, next, progress } = this.painted;
    drawImage(this.images.get(current), 1 - progress);
    if (next) {
      this.context.globalCompositeOperation = 'lighter';
      drawImage(this.images.get(next), progress);
      this.context.globalCompositeOperation = 'source-over';
    }
    this.context.globalAlpha = 1;
  }

  imageSource(frame) {
    const detail = detailSource(frame);
    return !this.dragging && this.images.has(detail) ? detail : frameSource(frame);
  }

  nearbyDragFrame(target, frames) {
    const visibleDistance = this.angleIndex === this.requestedAngleIndex
      ? Math.min(manualFrameIndex(target - this.frameIndex, frames.length),
        manualFrameIndex(this.frameIndex - target, frames.length))
      : frames.length;
    const maxLag = Math.min(MAX_DRAG_LAG, visibleDistance - 1, Math.floor(frames.length / 2));
    for (let lag = 1; lag <= maxLag; lag++) {
      const index = manualFrameIndex(target - lag * this.requestDirection, frames.length);
      if (this.images.has(this.imageSource(frames[index]))) return index;
    }
    return -1;
  }

  updateDisplayedFrame() {
    const blend = this.blendState();
    const frames = this.requestedAngle.frames;
    let index = blend.display;
    let key = this.imageSource(frames[index]);
    if (!this.images.has(key)) {
      if (!this.dragging) return;
      index = this.nearbyDragFrame(index, frames);
      if (index === -1) return;
      key = this.imageSource(frames[index]);
    }
    const current = this.imageSource(frames[blend.current]);
    const next = this.imageSource(frames[blend.next]);
    const canBlend = index === blend.display && !this.reducedMotion.matches && blend.progress > .001
      && this.images.has(current) && this.images.has(next);
    this.angleIndex = this.requestedAngleIndex;
    this.frameIndex = index;
    const painted = canBlend ? { current, next, progress: blend.progress } : { current: key, progress: 0 };
    if (painted.current === this.painted?.current && painted.next === this.painted?.next
      && painted.progress === this.painted?.progress) return;
    this.painted = painted;
    this.draw();
  }

  setRenderPosition(position, { emit = true, loop = !this.playing, dragDirection = 0 } = {}) {
    if (!this.ready || !this.requestedAngle?.frames.length) return;
    const frame = this.frame;
    const buffering = this.buffering;
    const frameFailed = this.frameFailed;
    const length = this.requestedAngle.frames.length;
    const blend = blendFrameState(position, length, loop);
    let delta = blend.position - this.renderPosition;
    if (loop && Math.abs(delta) > length / 2) delta -= Math.sign(delta) * length;
    if (delta && !this.playing) this.requestDirection = dragDirection || Math.sign(delta);
    this.renderPosition = blend.position;
    this.updateDisplayedFrame();
    this.preload();
    if (emit && (frame !== this.frame || buffering !== this.buffering || frameFailed !== this.frameFailed)) this.emit('change');
  }

  scheduleRenderPosition(position) {
    this.pendingRenderPosition = position;
    if (this.renderFrame) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      const next = this.pendingRenderPosition;
      this.pendingRenderPosition = null;
      const dragDirection = Math.sign(next - this.gesture.lastPosition);
      this.gesture.lastPosition = next;
      this.setRenderPosition(next, { dragDirection });
    });
  }

  snapRenderPosition(shouldEmit = true) {
    const position = this.pendingRenderPosition ?? this.renderPosition;
    this.pendingRenderPosition = null;
    cancelAnimationFrame(this.renderFrame);
    this.renderFrame = 0;
    this.setRenderPosition(Math.round(position), { emit: shouldEmit });
  }

  showFrame(index) {
    if (!this.ready) return;
    this.playbackComplete = false;
    this.setRenderPosition(index);
  }

  showAngle(index) {
    if (!this.ready) return;
    const next = clamp(index, 0, this.product.angles.length - 1);
    if (next === this.requestedAngleIndex) return;
    this.stop();
    const previousFrame = this.requestedFrame?.index;
    const previousWholeRing = this.preloadWholeRing;
    this.setRequestedAngle(next);
    if (previousWholeRing && !this.preloadWholeRing) this.trimImages(new Set(), true);
    const exact = this.requestedAngle.frames.findIndex((frame) => frame.index === previousFrame);
    const position = exact >= 0 ? exact : clamp(this.renderPosition, 0, this.requestedAngle.frames.length - 1);
    this.playbackComplete = false;
    this.setRenderPosition(position, { emit: false });
    this.emit('change');
  }

  reset() {
    this.stop();
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.playbackComplete = false;
    this.draw();
    this.emit('change');
  }

  setReverse(reverse) {
    this.reverse = Boolean(reverse);
    saveSequencePreference('reverse', this.reverse, this.storage);
    this.emit('reversechange');
  }

  setAutoRotate(enabled) {
    this.autoRotate = Boolean(enabled);
    saveSequencePreference('auto-rotate', this.autoRotate, this.storage);
    if (this.ready && this.playing !== this.autoRotate) this.setPlaying(this.autoRotate);
    else this.emit('change');
  }

  setPlaying(playing) {
    if (!this.ready || this.playing === playing) return;
    if (!playing) {
      this.stop();
      return;
    }
    this.snapRenderPosition(false);
    this.playbackComplete = false;
    this.playing = true;
    this.requestDirection = 1;
    const last = this.requestedAngle.frames.length - 1;
    this.playFrame = this.renderPosition === last ? 0 : this.renderPosition;
    this.setRenderPosition(this.playFrame, { emit: false });
    this.playTimer = requestAnimationFrame((timestamp) => this.advancePlayback(timestamp));
    this.emit('playchange');
  }

  nextPlayableFrame() {
    const frames = this.requestedAngle.frames;
    let next = this.playFrame + 1;
    while (next < frames.length && this.failed.has(frameSource(frames[next]))) next++;
    return next;
  }

  advancePlayback(timestamp) {
    if (!this.playing) return;
    const frames = this.requestedAngle.frames;
    const current = frameSource(frames[this.playFrame]);
    const last = frames.length - 1;
    if (this.playFrame === last && (this.images.has(current) || this.failed.has(current))) {
      this.playbackComplete = true;
      this.stop();
      this.emit('playcomplete');
      return;
    }

    const next = Math.min(this.nextPlayableFrame(), last);
    const nextKey = frameSource(frames[next]);
    if (this.failed.has(current) || (next === last && this.failed.has(nextKey))) {
      this.playFrame = Math.min(next, last);
      this.playStartedAt = null;
      this.setRenderPosition(this.playFrame);
    } else if (this.images.has(current) && this.images.has(nextKey)) {
      this.playStartedAt ??= timestamp;
      const elapsed = timestamp - this.playStartedAt;
      if (elapsed >= 125) {
        this.playFrame = next;
        this.playStartedAt = timestamp;
        this.setRenderPosition(next);
      } else if (next === this.playFrame + 1) {
        const progress = this.reducedMotion.matches ? Number(elapsed >= 72) : smoothstep(elapsed / 72);
        this.setRenderPosition(this.playFrame + progress);
      }
    } else {
      this.playStartedAt = null;
      this.setRenderPosition(this.playFrame);
    }
    this.playTimer = requestAnimationFrame((nextTimestamp) => this.advancePlayback(nextTimestamp));
  }

  stop() {
    const wasPlaying = this.playing;
    this.playing = false;
    cancelAnimationFrame(this.playTimer);
    this.playTimer = 0;
    this.playStartedAt = null;
    if (this.ready) this.snapRenderPosition(false);
    if (wasPlaying) this.emit('playchange');
  }

  setScale(nextScale, focusX = this.canvas.clientWidth / 2, focusY = this.canvas.clientHeight / 2) {
    if (!this.ready) return;
    this.stop();
    const old = this.scale;
    this.scale = clamp(nextScale, 1, 4);
    if (this.scale === 1) this.offsetX = this.offsetY = 0;
    else {
      const factor = this.scale / old;
      this.offsetX = (this.offsetX + this.canvas.clientWidth / 2 - focusX) * factor - this.canvas.clientWidth / 2 + focusX;
      this.offsetY = (this.offsetY + this.canvas.clientHeight / 2 - focusY) * factor - this.canvas.clientHeight / 2 + focusY;
    }
    this.playbackComplete = false;
    this.draw();
    this.emit('change');
  }

  bindEvents() {
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    this.canvas.addEventListener('dblclick', () => { if (this.ready) this.reset(); });
    this.canvas.addEventListener('wheel', (event) => {
      if (!this.ready) return;
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      this.setScale(this.scale * Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.ready) return;
      this.stop();
      this.playbackComplete = false;
      this.canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.gesture = { x: event.clientX, y: event.clientY, position: this.renderPosition, lastPosition: this.renderPosition,
        angle: this.requestedAngleIndex, mode: null };
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.pointers.has(event.pointerId) || !this.gesture) return;
      const previous = this.pointers.get(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 2) {
        const points = [...this.pointers.values()];
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        if (!this.gesture.pinchDistance) this.gesture.pinchDistance = distance;
        else {
          this.setScale(this.scale * distance / this.gesture.pinchDistance);
          this.gesture.pinchDistance = distance;
        }
        return;
      }
      const dx = event.clientX - this.gesture.x;
      const dy = event.clientY - this.gesture.y;
      if (this.scale > 1) {
        this.offsetX += event.clientX - previous.x;
        this.offsetY += event.clientY - previous.y;
        this.draw();
        return;
      }
      if (!this.gesture.mode && Math.hypot(dx, dy) > 8) {
        this.gesture.mode = Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
        if (this.gesture.mode === 'horizontal') this.gesture.sources = new Set(this.requestedAngle.frames.map(frameSource));
      }
      if (this.gesture.mode === 'horizontal') {
        this.playbackComplete = false;
        this.scheduleRenderPosition(horizontalDragFrame(this.gesture.position, dx, this.reverse));
      }
      if (this.gesture.mode === 'vertical') this.showAngle(this.gesture.angle + Math.round(dy / 48));
    });
    const end = (event) => {
      this.pointers.delete(event.pointerId);
      if (!this.pointers.size) {
        const horizontal = this.gesture?.mode === 'horizontal';
        this.gesture = null;
        if (horizontal) this.snapRenderPosition();
      }
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }
}
