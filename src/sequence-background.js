const storageKey = 'glb-viewer:sequence-background:v1';
const pointInset = .06;
const modes = ['default', 'solid', 'gradient'];
const gradientTypes = ['linear', 'radial'];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const sortedStops = (stops) => [...stops].sort((first, second) => first.position - second.position);

function defaultSettings() {
  return {
    mode: 'default',
    solid: '#e8eaed',
    type: 'linear',
    guides: true,
    points: { start: { x: .24, y: .27 }, end: { x: .76, y: .73 } },
    stops: [{ color: '#f8faf9', position: 0 }, { color: '#a9b9b1', position: 100 }],
  };
}

function validPoint(point) {
  return [point?.x, point?.y].every((coordinate) => (
    Number.isFinite(coordinate) && coordinate >= pointInset && coordinate <= 1 - pointInset
  ));
}

function loadSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(storageKey));
    if (modes.includes(settings?.mode) && isColor(settings.solid) && gradientTypes.includes(settings.type)
      && typeof settings.guides === 'boolean' && validPoint(settings.points?.start) && validPoint(settings.points?.end)
      && Array.isArray(settings.stops) && settings.stops.length >= 2 && settings.stops.every((stop) => (
        isColor(stop?.color) && Number.isInteger(stop.position) && stop.position >= 0 && stop.position <= 100
      ))) return settings;
  } catch { /* Storage is optional. */ }
  return defaultSettings();
}

export function sequenceBackgroundPanel() {
  return `
    <section class="panel-section sequence-background" id="sequenceBackground" aria-labelledby="sequenceBackgroundHeading">
      <div class="section-heading sequence-background-heading">
        <h2 id="sequenceBackgroundHeading">图片背景</h2>
        <button class="sequence-background-text-button" type="button" id="sequenceBackgroundReset">恢复默认</button>
      </div>
      <div class="sequence-background-modes" role="group" aria-label="背景模式">
        <button type="button" data-background-mode="default" aria-pressed="true">默认</button>
        <button type="button" data-background-mode="solid" aria-pressed="false">纯色</button>
        <button type="button" data-background-mode="gradient" aria-pressed="false">渐变</button>
      </div>
      <label class="sequence-background-row" id="sequenceSolidSettings" hidden>
        <span>背景颜色</span>
        <span class="sequence-background-color color-control"><input type="color" id="sequenceSolidColor"><code aria-hidden="true"></code></span>
      </label>
      <div class="sequence-gradient-settings" id="sequenceGradientSettings" hidden>
        <label class="sequence-background-row">
          <span>渐变类型</span>
          <select id="sequenceGradientType"><option value="linear">线性</option><option value="radial">径向</option></select>
        </label>
        <div class="sequence-gradient-editor">
          <span class="sequence-gradient-label" id="sequenceGradientLabel">渐变色标</span>
          <div class="sequence-gradient-track" id="sequenceGradientTrack" role="group" aria-labelledby="sequenceGradientLabel"></div>
          <div class="sequence-gradient-stop-fields">
            <label class="sequence-background-row">
              <span>颜色</span>
              <span class="sequence-background-color color-control"><input type="color" id="sequenceGradientStopColor"><code aria-hidden="true"></code></span>
            </label>
            <label class="sequence-background-row">
              <span>位置</span>
              <span class="sequence-gradient-position"><input type="number" id="sequenceGradientStopPosition" min="0" max="100" step="1" aria-label="色标位置（百分比）"><span aria-hidden="true">%</span></span>
            </label>
          </div>
          <div class="sequence-gradient-stop-actions">
            <button class="sequence-background-text-button" type="button" id="sequenceGradientAddStop">添加色标</button>
            <button class="sequence-background-text-button" type="button" id="sequenceGradientRemoveStop">删除色标</button>
          </div>
        </div>
        <div class="sequence-background-row switch-row">
          <label for="sequenceGradientGuides">显示画布控件</label>
          <label class="switch-control"><input type="checkbox" id="sequenceGradientGuides" role="switch" aria-controls="sequenceGradientOverlay"><i aria-hidden="true"></i></label>
        </div>
      </div>
      <p class="sequence-background-hint">透明区域会显示所选背景。</p>
    </section>`;
}

export function sequenceGradientOverlay() {
  return `
    <div class="sequence-gradient-overlay" id="sequenceGradientOverlay" role="group" aria-label="画布渐变控件" hidden>
      <div class="sequence-gradient-line" aria-hidden="true"></div>
      <button type="button" data-gradient-point="start" aria-label="渐变起点" aria-description="拖动或使用方向键移动" title="拖动渐变起点"></button>
      <button type="button" data-gradient-point="end" aria-label="渐变终点" aria-description="拖动或使用方向键移动" title="拖动渐变终点"></button>
    </div>`;
}

function colorAtPosition(stops, position) {
  const nextIndex = stops.findIndex((stop) => stop.position > position);
  if (nextIndex === -1) return stops.at(-1).color;
  if (nextIndex === 0) return stops[0].color;
  const before = stops[nextIndex - 1];
  const after = stops[nextIndex];
  const fraction = (position - before.position) / (after.position - before.position);
  const channels = [1, 3, 5].map((offset) => {
    const first = Number.parseInt(before.color.slice(offset, offset + 2), 16);
    const last = Number.parseInt(after.color.slice(offset, offset + 2), 16);
    return Math.round(first + fraction * (last - first)).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

function gradientGeometry(points, width, height) {
  const start = { x: points.start.x * width, y: points.start.y * height };
  const dx = points.end.x * width - start.x;
  const dy = points.end.y * height - start.y;
  const distance = Math.hypot(dx, dy);
  const unitX = distance ? dx / distance : 1;
  const unitY = distance ? dy / distance : 0;
  // CSS positions linear stops from the start of a line centered on the viewport.
  // Project the draggable start onto that line to align the colors with the handles.
  const cssLineLength = Math.abs(unitX) * width + Math.abs(unitY) * height;
  const startOffset = cssLineLength / 2 + (start.x - width / 2) * unitX + (start.y - height / 2) * unitY;
  return { start, distance, startOffset, angle: Math.atan2(unitY, unitX) };
}

function bindDrag(button, onStart, onMove, onFinish) {
  let drag;
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    onStart();
    button.setPointerCapture(drag.id);
  });
  button.addEventListener('pointermove', (event) => {
    if (event.pointerId !== drag?.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    onMove(dx, dy);
  });
  button.addEventListener('lostpointercapture', (event) => {
    if (event.pointerId !== drag?.id) return;
    const { moved } = drag;
    drag = undefined;
    if (moved) onFinish();
  });
}

export class SequenceBackground {
  constructor(viewer, panel, overlay) {
    this.viewer = viewer;
    this.overlay = overlay;
    this.line = overlay.querySelector('.sequence-gradient-line');
    this.points = [...overlay.querySelectorAll('[data-gradient-point]')];
    this.modeButtons = [...panel.querySelectorAll('[data-background-mode]')];
    this.reset = panel.querySelector('#sequenceBackgroundReset');
    this.solidSettings = panel.querySelector('#sequenceSolidSettings');
    this.solidColor = panel.querySelector('#sequenceSolidColor');
    this.gradientSettings = panel.querySelector('#sequenceGradientSettings');
    this.type = panel.querySelector('#sequenceGradientType');
    this.track = panel.querySelector('#sequenceGradientTrack');
    this.stopColor = panel.querySelector('#sequenceGradientStopColor');
    this.stopPosition = panel.querySelector('#sequenceGradientStopPosition');
    this.add = panel.querySelector('#sequenceGradientAddStop');
    this.remove = panel.querySelector('#sequenceGradientRemoveStop');
    this.guides = panel.querySelector('#sequenceGradientGuides');
    this.stopButtons = new Map();
    this.settings = loadSettings();
    this.selectedStop = this.settings.stops[0];
    this.ready = false;
    this.bindEvents();
    this.render();
    new ResizeObserver(() => this.paint()).observe(viewer);
  }

  setReady(ready) {
    if (ready === this.ready) return;
    this.ready = ready;
    this.updateGuideVisibility();
  }

  updateGuideVisibility() {
    this.overlay.hidden = !this.ready || this.settings.mode !== 'gradient' || !this.settings.guides;
  }

  save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(this.settings));
    } catch { /* Storage is optional. */ }
  }

  update() {
    this.render();
    this.save();
  }

  render() {
    const { mode, solid, type, guides, stops } = this.settings;
    for (const button of this.modeButtons) button.setAttribute('aria-pressed', String(button.dataset.backgroundMode === mode));
    this.solidSettings.hidden = mode !== 'solid';
    this.gradientSettings.hidden = mode !== 'gradient';
    this.solidColor.value = solid;
    this.solidColor.nextElementSibling.textContent = solid.toUpperCase();
    this.type.value = type;
    this.guides.checked = guides;
    this.remove.disabled = stops.length <= 2;
    this.stopColor.value = this.selectedStop.color;
    this.stopColor.nextElementSibling.textContent = this.selectedStop.color.toUpperCase();
    this.stopPosition.value = this.selectedStop.position;

    for (const [stop, button] of this.stopButtons) {
      if (stops.includes(stop)) continue;
      button.remove();
      this.stopButtons.delete(stop);
    }
    for (const stop of stops) {
      const button = this.stopButtons.get(stop) ?? this.createStopButton(stop);
      const label = `色标 ${stop.position}% · ${stop.color.toUpperCase()}`;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(stop === this.selectedStop));
      button.title = label;
      button.style.setProperty('--stop-position', `${stop.position}%`);
      button.style.setProperty('--stop-color', stop.color);
    }
    this.updateGuideVisibility();
    this.paint();
  }

  paint() {
    const { mode, solid, type, points } = this.settings;
    if (mode !== 'gradient') {
      this.viewer.style.background = mode === 'solid' ? solid : '';
      return;
    }

    const stops = sortedStops(this.settings.stops);
    const swatches = stops.map(({ color, position }) => `${color} ${position}%`).join(', ');
    this.track.style.setProperty('--gradient-preview', `linear-gradient(90deg in srgb, ${swatches})`);
    const { width, height } = this.viewer.getBoundingClientRect();
    if (!width || !height) return;
    const { start, distance, startOffset, angle } = gradientGeometry(points, width, height);
    const length = Math.max(distance, 1);
    const gradientStops = stops.map(({ color, position }) => (
      `${color} ${(type === 'linear' ? startOffset : 0) + position * length / 100}px`
    )).join(', ');
    this.viewer.style.background = type === 'linear'
      ? `linear-gradient(${angle + Math.PI / 2}rad in srgb, ${gradientStops})`
      : `radial-gradient(circle ${length}px at ${start.x}px ${start.y}px in srgb, ${gradientStops})`;

    const positionGuide = (element, point) => {
      element.style.setProperty('--point-x', `${point.x * 100}%`);
      element.style.setProperty('--point-y', `${point.y * 100}%`);
    };
    positionGuide(this.line, points.start);
    this.line.style.setProperty('--line-length', `${distance}px`);
    this.line.style.setProperty('--line-angle', `${angle}rad`);
    for (const button of this.points) {
      const point = button.dataset.gradientPoint;
      positionGuide(button, points[point]);
      button.style.setProperty('--point-color', point === 'start' ? stops[0].color : stops.at(-1).color);
    }
  }

  addStop(position) {
    const stops = sortedStops(this.settings.stops);
    if (position === undefined) {
      const positions = [0, ...stops.map((stop) => stop.position), 100];
      let largestGap = -1;
      for (let index = 1; index < positions.length; index++) {
        const gap = positions[index] - positions[index - 1];
        if (gap <= largestGap) continue;
        largestGap = gap;
        position = Math.round(positions[index - 1] + gap / 2);
      }
    }
    this.selectedStop = { position, color: colorAtPosition(stops, position) };
    this.settings.stops.push(this.selectedStop);
    this.update();
    this.stopButtons.get(this.selectedStop).focus();
  }

  removeStop() {
    if (this.settings.stops.length <= 2) return;
    const stops = sortedStops(this.settings.stops);
    const index = stops.indexOf(this.selectedStop);
    stops.splice(index, 1);
    this.settings.stops = stops;
    this.selectedStop = stops[Math.min(index, stops.length - 1)];
    this.update();
    this.stopButtons.get(this.selectedStop).focus();
  }

  createStopButton(stop) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-gradient-stop', '');
    button.setAttribute('aria-description', '拖动或使用方向键调整位置');
    this.track.append(button);
    this.stopButtons.set(stop, button);

    const select = () => {
      this.selectedStop = stop;
      this.render();
    };
    button.addEventListener('click', select);
    let startPosition;
    bindDrag(button, () => {
      button.focus({ preventScroll: true });
      startPosition = stop.position;
      select();
    }, (dx) => {
      const width = this.track.clientWidth;
      if (!width) return;
      stop.position = clamp(Math.round(startPosition + 100 * dx / width), 0, 100);
      this.render();
    }, () => this.save());
    button.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 10 : 1;
      const positions = { ArrowLeft: stop.position - step, ArrowRight: stop.position + step, Home: 0, End: 100 };
      if (event.key === 'Delete') {
        event.preventDefault();
        this.selectedStop = stop;
        if (this.settings.stops.length > 2) this.removeStop();
        else this.render();
      } else if (Object.hasOwn(positions, event.key)) {
        event.preventDefault();
        this.selectedStop = stop;
        stop.position = clamp(positions[event.key], 0, 100);
        this.update();
      }
    });
    return button;
  }

  bindEvents() {
    for (const button of this.modeButtons) {
      button.addEventListener('click', () => {
        this.settings.mode = button.dataset.backgroundMode;
        this.update();
      });
    }
    this.reset.addEventListener('click', () => {
      this.settings = defaultSettings();
      this.selectedStop = this.settings.stops[0];
      this.update();
    });
    this.solidColor.addEventListener('input', () => {
      this.settings.solid = this.solidColor.value;
      this.update();
    });
    this.type.addEventListener('change', () => {
      this.settings.type = this.type.value;
      this.update();
    });
    this.track.addEventListener('click', (event) => {
      if (event.target !== this.track) return;
      const { left, width } = this.track.getBoundingClientRect();
      this.addStop(clamp(Math.round(100 * (event.clientX - left) / width), 0, 100));
    });
    this.stopColor.addEventListener('input', () => {
      this.selectedStop.color = this.stopColor.value;
      this.update();
    });
    this.stopPosition.addEventListener('change', () => {
      const position = this.stopPosition.valueAsNumber;
      if (Number.isFinite(position)) this.selectedStop.position = clamp(Math.round(position), 0, 100);
      this.update();
    });
    this.add.addEventListener('click', () => this.addStop());
    this.remove.addEventListener('click', () => this.removeStop());
    this.guides.addEventListener('change', () => {
      this.settings.guides = this.guides.checked;
      this.update();
    });

    for (const button of this.points) {
      const name = button.dataset.gradientPoint;
      const otherName = name === 'start' ? 'end' : 'start';
      const move = (origin, dx, dy) => {
        const { clientWidth: width, clientHeight: height } = this.overlay;
        if (!width || !height) return;
        const x = clamp(origin.x + dx / width, pointInset, 1 - pointInset);
        const y = clamp(origin.y + dy / height, pointInset, 1 - pointInset);
        const other = this.settings.points[otherName];
        if (Math.hypot(x - other.x, y - other.y) < pointInset) return;
        this.settings.points[name] = { x, y };
        this.paint();
      };
      let origin;
      bindDrag(button, () => { origin = this.settings.points[name]; }, (dx, dy) => move(origin, dx, dy), () => this.save());
      button.addEventListener('keydown', (event) => {
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!Object.hasOwn(direction, event.key)) return;
        event.preventDefault();
        const [dx, dy] = direction[event.key];
        const step = event.shiftKey ? 16 : 2;
        move(this.settings.points[name], dx * step, dy * step);
        this.save();
      });
    }
  }
}
