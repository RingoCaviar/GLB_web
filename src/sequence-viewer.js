const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function buildPreloadOrder(product, angleIndex = 0, frameIndex = 0) {
  if (!product?.angles?.length) return [];
  const currentAngle = product.angles[angleIndex];
  const currentFrames = currentAngle.frames;
  const order = [currentFrames[frameIndex]];
  for (let distance = 1; distance <= 3; distance++) {
    order.push(currentFrames[(frameIndex + distance) % currentFrames.length]);
    order.push(currentFrames[(frameIndex - distance + currentFrames.length) % currentFrames.length]);
  }
  order.push(...currentFrames);
  for (const angle of product.angles) if (angle !== currentAngle) order.push(...angle.frames);
  return [...new Map(order.filter(Boolean).map((frame) => [frame.previewUrl, frame])).values()];
}

export function nextPlaybackFrame(frameIndex, frameCount) {
  if (frameCount <= 0) return { index: 0, complete: true };
  if (frameIndex < frameCount - 1) return { index: frameIndex + 1, complete: false };
  return { index: frameIndex, complete: true };
}

export function manualFrameIndex(index, frameCount, loop) {
  if (frameCount <= 0) return 0;
  return loop ? ((index % frameCount) + frameCount) % frameCount : clamp(index, 0, frameCount - 1);
}

export function horizontalDragFrame(startFrame, deltaX, reverse = false, pixelsPerFrame = 18) {
  const frameDelta = deltaX / pixelsPerFrame * (reverse ? 1 : -1);
  return startFrame + frameDelta;
}

export function blendFrameState(position, frameCount, loop = false) {
  if (frameCount <= 0) return { position: 0, current: 0, next: 0, progress: 0, display: 0 };
  const normalized = loop
    ? ((position % frameCount) + frameCount) % frameCount
    : clamp(position, 0, frameCount - 1);
  const current = Math.floor(normalized);
  const next = loop ? (current + 1) % frameCount : Math.min(current + 1, frameCount - 1);
  const progress = next === current ? 0 : normalized - current;
  const display = progress >= .5 ? next : current;
  return { position: normalized, current, next, progress, display };
}

export function smoothstep(value) {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

export class SequenceViewer extends EventTarget {
  constructor(root, { concurrency = 6 } = {}) {
    super();
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.context = this.canvas.getContext('2d', { alpha: true });
    this.concurrency = concurrency;
    this.product = null;
    this.angleIndex = 0;
    this.frameIndex = 0;
    this.renderPosition = 0;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.images = new Map();
    this.inFlight = new Map();
    this.loadedKeys = new Set();
    this.failed = new Set();
    this.pointers = new Map();
    this.gesture = null;
    this.loadToken = 0;
    this.loading = false;
    this.ready = false;
    this.playing = false;
    this.loop = false;
    this.reverse = true;
    this.playbackComplete = false;
    this.playTimer = 0;
    this.renderFrame = 0;
    this.pendingRenderPosition = null;
    this.playStartedAt = null;
    this.playStartFrame = 0;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.bindEvents();
  }

  get angle() { return this.product?.angles[this.angleIndex] ?? null; }
  get frame() { return this.angle?.frames[this.frameIndex] ?? null; }
  get total() { return this.product?.totalFrames ?? 0; }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { ...this.snapshot(), ...detail } }));
  }

  snapshot() {
    return {
      product: this.product,
      angle: this.angle?.angle ?? null,
      frame: this.frame,
      framePosition: this.frameIndex + 1,
      frameCount: this.angle?.frames.length ?? 0,
      framePositionFloat: this.renderPosition,
      displayFrameIndex: this.frameIndex,
      transitionProgress: this.blendState().progress,
      transitioning: this.blendState().progress > 0,
      loaded: this.loadedKeys.size,
      total: this.total,
      failed: this.failed.size,
      scale: this.scale,
      loading: this.loading,
      ready: this.ready,
      playing: this.playing,
      loop: this.loop,
      reverse: this.reverse,
      playbackComplete: this.playbackComplete,
    };
  }

  async load(product) {
    const retainedLoop = this.loop;
    const retainedReverse = this.reverse;
    this.unload();
    this.loop = retainedLoop;
    this.reverse = retainedReverse;
    this.product = product;
    this.angleIndex = product.angles.reduce((best, item, index, list) =>
      Math.abs(item.angle - 5) < Math.abs(list[best].angle - 5) ? index : best, 0);
    this.frameIndex = 0;
    this.renderPosition = 0;
    this.loading = true;
    const token = this.loadToken;
    this.emit('change');
    await this.loadAll(token);
  }

  async loadAll(token, frames = buildPreloadOrder(this.product, this.angleIndex, this.frameIndex)) {
    if (!frames.length) {
      this.loading = false;
      this.emit('viewererror', { error: new Error('EMPTY_SEQUENCE') });
      return;
    }
    const queue = [...frames];
    const worker = async () => {
      while (queue.length && token === this.loadToken) {
        const frame = queue.shift();
        if (this.images.has(this.frameKey(frame))) continue;
        try { await this.loadFrame(frame, token); } catch { /* collect failures and finish the queue */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
    if (token !== this.loadToken) return;
    this.loading = false;
    this.ready = this.failed.size === 0 && this.loadedKeys.size === this.total;
    this.root.classList.toggle('ready', this.ready);
    this.emit(this.ready ? 'ready' : 'loaderror');
  }

  async retryFailed() {
    if (!this.product || this.loading || !this.failed.size) return;
    const failedFrames = this.product.angles.flatMap((angle) => angle.frames)
      .filter((frame) => this.failed.has(this.frameKey(frame)));
    this.failed.clear();
    this.loading = true;
    this.emit('progress');
    await this.loadAll(this.loadToken, failedFrames);
  }

  unload() {
    this.loadToken++;
    this.stop();
    for (const { image } of this.inFlight.values()) image.src = '';
    for (const image of this.images.values()) image.src = '';
    this.product = null;
    this.images.clear();
    this.inFlight.clear();
    this.loadedKeys.clear();
    this.failed.clear();
    this.pointers.clear();
    this.gesture = null;
    this.loading = false;
    this.ready = false;
    this.playbackComplete = false;
    this.renderPosition = 0;
    this.pendingRenderPosition = null;
    cancelAnimationFrame(this.renderFrame);
    this.renderFrame = 0;
    this.root.classList.remove('ready', 'has-preview');
    this.reset(false);
    this.draw();
  }

  frameKey(frame) { return frame?.previewUrl; }

  blendState(position = this.renderPosition) {
    return blendFrameState(position, this.angle?.frames.length ?? 0, this.loop);
  }

  loadFrame(frame, token = this.loadToken, retry = true) {
    if (!frame) return Promise.reject(new Error('EMPTY_SEQUENCE'));
    const key = this.frameKey(frame);
    if (this.images.has(key)) return Promise.resolve(this.images.get(key));
    if (this.inFlight.has(key)) return this.inFlight.get(key).promise;
    const image = new Image();
    image.decoding = 'async';
    const promise = new Promise((resolve, reject) => {
      image.onload = () => {
        this.inFlight.delete(key);
        if (token !== this.loadToken) return resolve(image);
        this.images.set(key, image);
        this.loadedKeys.add(key);
        this.failed.delete(key);
        this.emit('progress');
        if (frame === this.frame) {
          this.root.classList.add('has-preview');
          this.draw();
        }
        resolve(image);
      };
      image.onerror = () => {
        this.inFlight.delete(key);
        if (token !== this.loadToken) return reject(new Error('LOAD_CANCELLED'));
        if (retry) {
          setTimeout(() => this.loadFrame(frame, token, false).then(resolve, reject), 180);
          return;
        }
        this.failed.add(key);
        this.emit('frameerror', { frame });
        reject(new Error(`FRAME_LOAD_FAILED:${frame.originalFilename}`));
      };
      image.src = frame.previewUrl;
    });
    this.inFlight.set(key, { image, promise });
    return promise;
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
    if (!this.angle?.frames.length) return;
    const blend = this.blendState();
    const currentImage = this.images.get(this.frameKey(this.angle.frames[blend.current]));
    if (!currentImage) return;
    const drawImage = (image, alpha = 1) => {
      const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight);
      const drawWidth = image.naturalWidth * fit * this.scale;
      const drawHeight = image.naturalHeight * fit * this.scale;
      this.context.globalAlpha = alpha;
      this.context.drawImage(image, (width - drawWidth) / 2 + this.offsetX,
        (height - drawHeight) / 2 + this.offsetY, drawWidth, drawHeight);
    };
    if (this.reducedMotion.matches) {
      const displayImage = this.images.get(this.frameKey(this.angle.frames[blend.display]));
      if (displayImage) drawImage(displayImage, 1);
      this.context.globalAlpha = 1;
      return;
    }
    const progress = blend.progress;
    drawImage(currentImage, 1);
    if (progress > .001 && blend.next !== blend.current) {
      const nextImage = this.images.get(this.frameKey(this.angle.frames[blend.next]));
      if (nextImage) drawImage(nextImage, progress);
    }
    this.context.globalAlpha = 1;
  }

  setRenderPosition(position, { emit = true, loop = this.loop } = {}) {
    if (!this.ready || !this.angle?.frames.length) return;
    const length = this.angle.frames.length;
    const blend = blendFrameState(position, length, loop);
    const previousFrameIndex = this.frameIndex;
    this.renderPosition = blend.position;
    this.frameIndex = blend.display;
    this.draw();
    if (emit && previousFrameIndex !== this.frameIndex) this.emit('change');
  }

  scheduleRenderPosition(position) {
    this.pendingRenderPosition = position;
    if (this.renderFrame) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      const next = this.pendingRenderPosition;
      this.pendingRenderPosition = null;
      this.setRenderPosition(next);
    });
  }

  snapRenderPosition(shouldEmit = true) {
    const pending = this.pendingRenderPosition;
    if (pending !== null) {
      this.pendingRenderPosition = null;
      cancelAnimationFrame(this.renderFrame);
      this.renderFrame = 0;
      this.setRenderPosition(pending, { emit: false });
    }
    this.setRenderPosition(Math.round(this.renderPosition), { emit: shouldEmit });
  }

  showFrame(index, { playback = false } = {}) {
    if (!this.ready || !this.angle?.frames.length) return;
    const next = playback ? clamp(index, 0, this.angle.frames.length - 1) : manualFrameIndex(index, this.angle.frames.length, this.loop);
    this.setRenderPosition(next, { loop: playback ? false : this.loop });
    if (!playback) this.playbackComplete = false;
  }

  showAngle(index) {
    if (!this.ready) return;
    const next = clamp(index, 0, this.product.angles.length - 1);
    if (next === this.angleIndex) return;
    this.stop();
    const previousFrame = this.frame?.index;
    this.angleIndex = next;
    const exact = this.angle.frames.findIndex((frame) => frame.index === previousFrame);
    this.frameIndex = exact >= 0 ? exact : clamp(this.frameIndex, 0, this.angle.frames.length - 1);
    this.renderPosition = this.frameIndex;
    this.playbackComplete = false;
    this.draw();
    this.emit('change');
  }

  reset(shouldEmit = true) {
    this.stop();
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.playbackComplete = false;
    this.renderPosition = this.frameIndex;
    this.draw();
    if (shouldEmit) this.emit('change');
  }

  setLoop(loop) {
    this.loop = Boolean(loop);
    if (this.loop) this.playbackComplete = false;
    this.emit('loopchange');
  }

  setReverse(reverse) {
    this.reverse = Boolean(reverse);
    this.emit('reversechange');
  }

  setPlaying(playing) {
    if (!this.product || !this.ready || this.failed.size || this.playing === playing) return;
    if (playing && this.frameIndex === this.angle.frames.length - 1) {
      this.frameIndex = 0;
      this.setRenderPosition(0);
    }
    if (playing) this.playbackComplete = false;
    this.playing = playing;
    if (playing) {
      this.snapRenderPosition(false);
      this.playStartFrame = this.frameIndex;
      this.playStartedAt = null;
      this.playTimer = requestAnimationFrame((timestamp) => this.advancePlayback(timestamp));
    } else {
      cancelAnimationFrame(this.playTimer);
      this.playTimer = 0;
      this.snapRenderPosition(false);
    }
    this.emit('playchange');
  }

  advancePlayback(timestamp) {
    if (!this.playing) return;
    if (this.playStartedAt === null) this.playStartedAt = timestamp;
    const elapsed = timestamp - this.playStartedAt;
    const segment = Math.floor(elapsed / 125);
    const current = this.playStartFrame + segment;
    const last = this.angle.frames.length - 1;
    if (current >= last) {
      this.setRenderPosition(last, { loop: false });
      this.playbackComplete = true;
      this.stop();
      this.emit('playcomplete');
      return;
    }
    const segmentElapsed = elapsed - segment * 125;
    const progress = this.reducedMotion.matches ? (segmentElapsed >= 72 ? 1 : 0) : smoothstep(segmentElapsed / 72);
    this.setRenderPosition(current + progress, { loop: false });
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
      this.gesture = { x: event.clientX, y: event.clientY, position: this.renderPosition, angle: this.angleIndex, mode: null };
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
      if (!this.gesture.mode && Math.hypot(dx, dy) > 8) this.gesture.mode = Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
      if (this.gesture.mode === 'horizontal') {
        this.playbackComplete = false;
        this.scheduleRenderPosition(horizontalDragFrame(this.gesture.position, dx, this.reverse));
      }
      if (this.gesture.mode === 'vertical') this.showAngle(this.gesture.angle + Math.round(dy / 48));
    });
    const end = (event) => {
      this.pointers.delete(event.pointerId);
      if (!this.pointers.size) {
        if (this.gesture?.mode === 'horizontal') this.snapRenderPosition();
        this.gesture = null;
      }
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }
}
