/*
 * app.js
 * The main program: connects the toolbar, panels, canvas, layers, frames,
 * playback, brushes and undo.
 *
 * How a project is stored:
 *   - doc.frames: the list of frames, in order.
 *   - doc.layers: the stack of layers (index 0 = bottom). Every frame shares
 *     the same layers.
 *   - Each layer keeps one drawing ("cel") per frame, in layer.cels. A cel is
 *     only created once you draw on it, so empty layers cost no memory.
 *   - A layer marked "same on every frame" keeps a single cel (key "static")
 *     that shows on all frames, which is handy for backgrounds.
 */
(function () {
  'use strict';

  // Drawing size in pixels (16:9, the shape of most videos).
  const DOC_W = 1280, DOC_H = 720;
  const SIZE_MAX = 200;
  const MAX_LAYERS = 20;
  const MAX_FRAMES = 500;

  // Layer blend modes: [browser name, name shown to you]
  const BLEND_MODES = [
    ['source-over', 'Normal'],
    ['multiply', 'Multiply (darken)'],
    ['screen', 'Screen (lighten)'],
    ['overlay', 'Overlay (contrast)'],
    ['lighter', 'Add (glow)'],
    ['color', 'Color (recolor)'],
  ];

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const DPR = Math.max(1, window.devicePixelRatio || 1);

  // Small wrapper around browser storage. It may be unavailable (private mode), so never rely on it.
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ }
    },
  };

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function copyCanvas(src) {
    const c = makeCanvas(DOC_W, DOC_H);
    if (src) c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  // A short message that pops up at the bottom of the screen.
  const toastEl = $('#toast');
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  // ---------------------------------------------------------------------------
  // The project ("document")
  // ---------------------------------------------------------------------------
  const doc = { layers: [], frames: [], active: null, frame: null, fps: 12 };
  let layerCounter = 0, layerIds = 0, frameIds = 0;

  function newLayer(name) {
    layerCounter++;
    return {
      id: 'l' + (++layerIds),
      name: name || 'Layer ' + layerCounter,
      cels: new Map(),
      static: false,
      visible: true,
      locked: false,
      opacity: 1,
      blend: 'source-over',
    };
  }
  const newFrame = () => ({ id: 'f' + (++frameIds) });

  const activeLayer = () => doc.active;
  const layerIndex = (layer) => doc.layers.indexOf(layer);
  const frameIndex = (frame) => doc.frames.indexOf(frame || doc.frame);
  function putLayer(layer, index) { doc.layers.splice(index, 0, layer); }
  function takeLayer(layer) {
    const i = layerIndex(layer);
    if (i >= 0) doc.layers.splice(i, 1);
    return i;
  }

  const celKey = (layer, frame) => (layer.static ? 'static' : frame.id);
  const celOf = (layer, frame) => layer.cels.get(celKey(layer, frame)) || null;
  function ensureCel(layer, frame) {
    const key = celKey(layer, frame);
    let c = layer.cels.get(key);
    if (!c) { c = makeCanvas(DOC_W, DOC_H); layer.cels.set(key, c); }
    return c;
  }

  // Start with one layer and one frame.
  {
    const layer = newLayer();
    const frame = newFrame();
    doc.layers.push(layer);
    doc.frames.push(frame);
    doc.active = layer;
    doc.frame = frame;
  }

  /**
   * Draw a whole frame (all visible layers) into a 2D context.
   * opts: { w, h, transparent (no white paper), skipStatic, override: {layer, canvas} }
   */
  function drawFrame(ctx, frame, opts) {
    opts = opts || {};
    const W = opts.w || DOC_W, H = opts.h || DOC_H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (opts.transparent) ctx.clearRect(0, 0, W, H);
    else { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
    for (const layer of doc.layers) {
      if (!layer.visible || (opts.skipStatic && layer.static)) continue;
      const src = opts.override && opts.override.layer === layer ? opts.override.canvas : celOf(layer, frame);
      if (!src) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blend;
      ctx.drawImage(src, 0, 0, W, H);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  const display = $('#canvas');
  display.width = DOC_W;
  display.height = DOC_H;
  const dctx = display.getContext('2d');

  // The stroke being drawn goes here first, then gets blended onto the layer.
  const buffer = makeCanvas(DOC_W, DOC_H), bctx = buffer.getContext('2d');
  // Used to preview the stroke on its layer while you're still drawing.
  const scratch = makeCanvas(DOC_W, DOC_H), sctx = scratch.getContext('2d');

  // ---------------------------------------------------------------------------
  // Settings (remembered between visits)
  // ---------------------------------------------------------------------------
  const saved = store.get('ap.settings.v1', {}) || {};
  const state = {
    tool: 'brush',
    prevTool: 'brush',
    brushType: Brushes.TYPES[saved.brushType] ? saved.brushType : 'pen',
    color: Color.normalizeHex(saved.color) || '#1F2328',
    pressure: saved.pressure !== false,
    brushes: {},
    eraser: Object.assign({ size: 30, softness: 0, smoothing: 20 }, saved.eraser || {}),
    blend: Object.assign({ mode: 'smudge', size: 40, strength: 50, smoothing: 20 }, saved.blend || {}),
    onion: Object.assign({ enabled: true, prev: 1, next: 0, opacity: 35 }, saved.onion || {}),
  };
  Brushes.ORDER.forEach((t) => {
    state.brushes[t] = Object.assign({}, Brushes.TYPES[t].defaults, (saved.brushes || {})[t] || {});
  });
  doc.fps = clamp(saved.fps || 12, 1, 30);
  function saveSettings() {
    store.set('ap.settings.v1', {
      brushType: state.brushType, color: state.color, pressure: state.pressure,
      brushes: state.brushes, eraser: state.eraser, blend: state.blend,
      onion: state.onion, fps: doc.fps,
    });
  }
  let recent = store.get('ap.recentColors.v1', []);
  if (!Array.isArray(recent)) recent = [];
  recent = recent.map(Color.normalizeHex).filter(Boolean).slice(0, 10);

  function currentSettings() {
    if (state.tool === 'eraser') return state.eraser;
    if (state.tool === 'blend') return state.blend;
    return state.brushes[state.brushType];
  }

  // The size sliders use a curve so small sizes are easy to choose precisely.
  const sliderToSize = (v) => Math.max(1, Math.round(1 + (SIZE_MAX - 1) * Math.pow(v / 100, 2)));
  const sizeToSlider = (s) => Math.round(Math.sqrt((clamp(s, 1, SIZE_MAX) - 1) / (SIZE_MAX - 1)) * 100);

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------
  const history = new UndoHistory(50);
  history.onChange = () => {
    $('#btn-undo').disabled = !history.canUndo;
    $('#btn-redo').disabled = !history.canRedo;
  };

  const busy = () => !!(stroke || blendStroke);

  function undo() { if (!busy()) { stopPlay(); afterHistory(history.undo()); } }
  function redo() { if (!busy()) { stopPlay(); afterHistory(history.redo()); } }

  // After undo/redo: go to the frame that changed, and refresh everything.
  let stripSignature = '';
  function afterHistory(step) {
    if (!step) return;
    if (step.frame && doc.frames.includes(step.frame)) doc.frame = step.frame;
    if (!doc.frames.includes(doc.frame)) doc.frame = doc.frames[0];
    if (!doc.layers.includes(doc.active)) doc.active = doc.layers[0];
    if (doc.frames.map((f) => f.id).join() !== stripSignature) buildStrip();
    else if (step.frame && !step.allFrames) markThumb(step.frame);
    else markAllThumbs();
    goFrame(doc.frame);
    layersChanged();
  }

  // Checks before changing a layer's pixels.
  function canEdit(layer) {
    if (layer.locked) { toast(`"${layer.name}" is locked. Unlock it in the Layers panel to draw on it.`); return false; }
    if (!layer.visible) { toast(`"${layer.name}" is hidden. Show it in the Layers panel to draw on it.`); return false; }
    return true;
  }

  function pushPixelStep(label, layer, cel, rect, before, after) {
    const ctx = cel.getContext('2d');
    history.push({
      label,
      frame: doc.frame,
      allFrames: layer.static,
      undo() { ctx.putImageData(before, rect.x, rect.y); },
      redo() { ctx.putImageData(after, rect.x, rect.y); },
    });
    if (layer.static) markAllThumbs(); else markThumb(doc.frame);
    refreshLayersPanel();
  }

  function clearLayer() {
    if (busy()) return;
    stopPlay();
    const layer = activeLayer();
    if (!canEdit(layer)) return;
    const cel = celOf(layer, doc.frame);
    if (!cel) { toast(`"${layer.name}" is already empty on this frame.`); return; }
    const ctx = cel.getContext('2d');
    const rect = { x: 0, y: 0, w: DOC_W, h: DOC_H };
    const before = ctx.getImageData(0, 0, DOC_W, DOC_H);
    ctx.clearRect(0, 0, DOC_W, DOC_H);
    const after = ctx.getImageData(0, 0, DOC_W, DOC_H);
    pushPixelStep('Clear', layer, cel, rect, before, after);
    requestRender();
  }

  // ---------------------------------------------------------------------------
  // Drawing what you see
  // ---------------------------------------------------------------------------
  let renderQueued = false;
  let onionDirty = true;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }
  function render() {
    renderQueued = false;
    if (stroke && stroke.needsTick) stroke.tick();

    let override = null;
    if (stroke) {
      // Show the layer as it will look once this stroke is finished.
      const layer = activeLayer();
      const cel = celOf(layer, doc.frame);
      sctx.globalCompositeOperation = 'source-over';
      sctx.globalAlpha = 1;
      sctx.clearRect(0, 0, DOC_W, DOC_H);
      if (cel) sctx.drawImage(cel, 0, 0);
      sctx.globalAlpha = stroke.opacity;
      sctx.globalCompositeOperation = stroke.composite;
      sctx.drawImage(buffer, 0, 0);
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = 'source-over';
      override = { layer, canvas: scratch };
    }
    drawFrame(dctx, doc.frame, { override });
    if (onionDirty) drawOnion();

    if (stroke && stroke.needsTick) requestRender(); // keep the airbrush spraying
  }

  // Onion skin: nearby frames drawn faintly in color on a see-through canvas
  // that sits on top of the drawing. It's drawn at half size to stay fast.
  const onionCanvas = $('#onion');
  onionCanvas.width = DOC_W / 2;
  onionCanvas.height = DOC_H / 2;
  const octx = onionCanvas.getContext('2d');
  const tint = makeCanvas(DOC_W / 2, DOC_H / 2), tctx = tint.getContext('2d');
  function drawOnion() {
    onionDirty = false;
    octx.globalAlpha = 1;
    octx.clearRect(0, 0, onionCanvas.width, onionCanvas.height);
    const o = state.onion;
    if (!o.enabled || playing) return;
    const idx = frameIndex();
    const W = tint.width, H = tint.height;
    const ghost = (frame, color, alpha) => {
      drawFrame(tctx, frame, { w: W, h: H, transparent: true, skipStatic: true });
      tctx.globalCompositeOperation = 'source-atop';
      tctx.fillStyle = color;
      tctx.fillRect(0, 0, W, H);
      tctx.globalCompositeOperation = 'source-over';
      octx.globalAlpha = alpha;
      octx.drawImage(tint, 0, 0);
    };
    const base = o.opacity / 100;
    for (let d = o.prev; d >= 1; d--) {
      const f = doc.frames[idx - d];
      if (f) ghost(f, '#e5484d', base * (1 - (d - 1) / (o.prev + 1)));
    }
    for (let d = o.next; d >= 1; d--) {
      const f = doc.frames[idx + d];
      if (f) ghost(f, '#30a46c', base * (1 - (d - 1) / (o.next + 1)));
    }
    octx.globalAlpha = 1;
  }
  function refreshOnion() { onionDirty = true; requestRender(); }

  // ---------------------------------------------------------------------------
  // Mouse / touch / stylus input
  // ---------------------------------------------------------------------------
  let activePointer = null; // only one finger/pen draws at a time
  let stroke = null;        // brush or eraser stroke in progress
  let blendStroke = null;   // Blend tool stroke in progress
  let strokeTarget = null;  // { layer, cel } being drawn on
  let smooth = null;
  let lastRaw = null;
  let strokeSmoothing = 0;

  function toDoc(e, rect) {
    const r = rect || display.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (DOC_W / r.width),
      y: (e.clientY - r.top) * (DOC_H / r.height),
      // Only a stylus reports real pressure. Mouse and finger count as full pressure.
      pressure: e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 1,
    };
  }

  // Smoothing: the drawn point follows the real point with a little lag,
  // which irons out shaky hands.
  function feed(p) {
    const k = 1 - strokeSmoothing * 0.88;
    smooth.x += (p.x - smooth.x) * k;
    smooth.y += (p.y - smooth.y) * k;
    smooth.pressure += (p.pressure - smooth.pressure) * Math.min(1, k * 1.5);
    (stroke || blendStroke).moveTo({ x: smooth.x, y: smooth.y, pressure: smooth.pressure });
  }

  display.addEventListener('pointerdown', (e) => {
    if (activePointer !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (playing) { stopPlay(); return; }
    const p = toDoc(e);

    if (state.tool === 'eyedropper') {
      activePointer = e.pointerId;
      try { display.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      pickColor(p);
      return;
    }

    const layer = activeLayer();
    if (!canEdit(layer)) return;
    activePointer = e.pointerId;
    try { display.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }

    const st = currentSettings();
    strokeSmoothing = st.smoothing / 100;
    smooth = { x: p.x, y: p.y, pressure: p.pressure };
    lastRaw = p;

    if (state.tool === 'blend') {
      const cel = celOf(layer, doc.frame);
      if (!cel) { activePointer = null; toast('There is nothing to blend on this layer and frame yet.'); return; }
      strokeTarget = { layer, cel };
      blendStroke = BlendTool.createBlendStroke({
        ctx: cel.getContext('2d'), mode: st.mode, size: st.size, strength: st.strength / 100, pressure: state.pressure,
      });
      blendStroke.begin({ x: p.x, y: p.y, pressure: p.pressure });
      blendStroke.flush();
      requestRender();
      return;
    }

    const isEraser = state.tool === 'eraser';
    strokeTarget = { layer, cel: null };
    stroke = Brushes.createStroke({
      type: isEraser ? 'eraser' : state.brushType,
      ctx: bctx,
      color: state.color,
      size: st.size,
      opacity: isEraser ? 1 : st.opacity / 100,
      softness: isEraser ? st.softness / 100 : 0,
      pressure: state.pressure,
    });
    stroke.begin({ x: p.x, y: p.y, pressure: p.pressure });
    if (!isEraser) addRecent(state.color);
    requestRender();
  });

  display.addEventListener('pointermove', (e) => {
    updateCursor(e);
    if (e.pointerId !== activePointer) return;
    if (state.tool === 'eyedropper') { pickColor(toDoc(e)); return; }
    if (!busy()) return;
    const rect = display.getBoundingClientRect();
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = list.length ? list : [e];
    for (const ev of events) {
      const p = toDoc(ev, rect);
      lastRaw = p;
      feed(p);
    }
    if (blendStroke) blendStroke.flush();
    requestRender();
  });

  function endPointer(e) {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    if (state.tool === 'eyedropper') {
      addRecent(state.color);
      setTool(state.prevTool || 'brush');
      return;
    }
    if (!busy()) return;
    // Let the smoothed line catch up to where you actually stopped.
    if (lastRaw && strokeSmoothing > 0) {
      for (let i = 0; i < 40 && Math.hypot(lastRaw.x - smooth.x, lastRaw.y - smooth.y) > 0.5; i++) feed(lastRaw);
    }
    if (blendStroke) commitBlend();
    else { stroke.end(); commitStroke(); }
  }
  display.addEventListener('pointerup', endPointer);
  display.addEventListener('pointercancel', endPointer);
  display.addEventListener('lostpointercapture', endPointer);
  display.addEventListener('pointerleave', () => { if (activePointer === null) cursorEl.style.display = 'none'; });
  display.addEventListener('contextmenu', (e) => e.preventDefault());

  // Blend the finished stroke onto the layer, and save an undo step
  // holding just the changed area (much smaller than the whole picture).
  function commitStroke() {
    const s = stroke;
    stroke = null;
    const rect = s.bounds();
    const { layer } = strokeTarget;
    strokeTarget = null;
    // An eraser stroke on an empty spot changes nothing.
    if (rect && !(s.composite === 'destination-out' && !celOf(layer, doc.frame))) {
      const cel = ensureCel(layer, doc.frame);
      const ctx = cel.getContext('2d');
      const before = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      ctx.save();
      ctx.globalAlpha = s.opacity;
      ctx.globalCompositeOperation = s.composite;
      ctx.drawImage(buffer, 0, 0);
      ctx.restore();
      const after = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      pushPixelStep('Stroke', layer, cel, rect, before, after);
    }
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, DOC_W, DOC_H);
    requestRender();
  }

  function commitBlend() {
    const res = blendStroke.end();
    const { layer, cel } = strokeTarget;
    blendStroke = null;
    strokeTarget = null;
    if (res) {
      const { rect, before } = res;
      const after = cel.getContext('2d').getImageData(rect.x, rect.y, rect.w, rect.h);
      pushPixelStep('Blend', layer, cel, rect, before, after);
    }
    requestRender();
  }

  function pickColor(p) {
    const x = clamp(Math.floor(p.x), 0, DOC_W - 1);
    const y = clamp(Math.floor(p.y), 0, DOC_H - 1);
    const d = dctx.getImageData(x, y, 1, 1).data;
    picker.setHex(Color.rgbToHex(d[0], d[1], d[2]));
  }

  // The circle that shows your brush size under the mouse or stylus.
  const cursorEl = $('#cursor');
  function updateCursor(e) {
    if (e.pointerType === 'touch' || state.tool === 'eyedropper' || playing) {
      cursorEl.style.display = 'none';
      return;
    }
    const r = display.getBoundingClientRect();
    const d = Math.max(4, currentSettings().size * (r.width / DOC_W));
    cursorEl.style.display = 'block';
    cursorEl.style.width = cursorEl.style.height = d + 'px';
    cursorEl.style.left = (e.clientX - r.left) + 'px';
    cursorEl.style.top = (e.clientY - r.top) + 'px';
  }

  // Keep the canvas as big as possible while keeping its shape.
  const stage = $('#stage');
  function fit() {
    const pad = stage.clientWidth < 640 ? 8 : 16;
    const scale = Math.min((stage.clientWidth - pad * 2) / DOC_W, (stage.clientHeight - pad * 2) / DOC_H);
    display.style.width = Math.max(50, Math.floor(DOC_W * scale)) + 'px';
    display.style.height = Math.max(28, Math.floor(DOC_H * scale)) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
  window.addEventListener('resize', () => { fit(); closePanels(); });

  // Stop the page from zooming or scrolling while drawing on touch screens.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (e.target.closest('#stage')) e.preventDefault(); }, { passive: false });

  // ---------------------------------------------------------------------------
  // Frames: the strip of thumbnails at the bottom
  // ---------------------------------------------------------------------------
  const strip = $('#frame-strip');
  const cells = new Map(); // frame -> { btn, canvas }
  const dirtyThumbs = new Set();
  let thumbsQueued = false;

  function markThumb(frame) { dirtyThumbs.add(frame); requestThumbs(); }
  function markAllThumbs() { doc.frames.forEach((f) => dirtyThumbs.add(f)); requestThumbs(); }
  function requestThumbs() {
    if (thumbsQueued) return;
    thumbsQueued = true;
    requestAnimationFrame(() => {
      thumbsQueued = false;
      for (const f of dirtyThumbs) {
        const cell = cells.get(f);
        if (cell) drawFrame(cell.canvas.getContext('2d'), f, { w: cell.canvas.width, h: cell.canvas.height });
      }
      dirtyThumbs.clear();
    });
  }

  function buildStrip() {
    strip.innerHTML = '';
    cells.clear();
    doc.frames.forEach((f, i) => {
      const btn = document.createElement('button');
      btn.className = 'frame-cell';
      btn.title = `Frame ${i + 1}`;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(88 * DPR);
      canvas.height = Math.round(50 * DPR);
      const label = document.createElement('span');
      label.textContent = i + 1;
      btn.append(canvas, label);
      btn.addEventListener('click', () => { stopPlay(); goFrame(f); });
      strip.appendChild(btn);
      cells.set(f, { btn, canvas });
    });
    stripSignature = doc.frames.map((f) => f.id).join();
    markAllThumbs();
    updateFrameUI();
  }

  function updateFrameUI() {
    const i = frameIndex();
    $('#frame-counter').textContent = `${i + 1} / ${doc.frames.length}`;
    $('#f-del').disabled = doc.frames.length <= 1;
    cells.forEach((cell, f) => cell.btn.classList.toggle('active', f === doc.frame));
    // Keep the current frame scrolled into view.
    const cell = cells.get(doc.frame);
    if (cell) {
      const b = cell.btn;
      if (b.offsetLeft < strip.scrollLeft) strip.scrollLeft = b.offsetLeft - 8;
      else if (b.offsetLeft + b.offsetWidth > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = b.offsetLeft + b.offsetWidth - strip.clientWidth + 8;
      }
    }
  }

  function goFrame(frame) {
    if (!frame || busy()) return;
    doc.frame = frame;
    updateFrameUI();
    onionDirty = true;
    requestRender();
    if (!playing) refreshLayersPanel();
  }
  function stepFrame(dir) {
    if (busy()) return;
    stopPlay();
    const n = doc.frames.length;
    goFrame(doc.frames[(frameIndex() + dir + n) % n]);
  }

  // Take a frame out of the project, along with its drawings (kept for undo).
  function detachFrame(frame) {
    const index = doc.frames.indexOf(frame);
    const saved = [];
    for (const layer of doc.layers) {
      const cel = layer.cels.get(frame.id);
      if (cel) { saved.push([layer, cel]); layer.cels.delete(frame.id); }
    }
    doc.frames.splice(index, 1);
    return saved;
  }
  function attachFrame(frame, index, saved) {
    doc.frames.splice(index, 0, frame);
    for (const [layer, cel] of saved) layer.cels.set(frame.id, cel);
  }

  function framesChanged() {
    buildStrip();
    goFrame(doc.frame);
    layersChanged();
  }

  function insertFrameStep(label, frame, saved) {
    if (doc.frames.length >= MAX_FRAMES) { toast(`You've reached the limit of ${MAX_FRAMES} frames.`); return; }
    const prev = doc.frame;
    const index = frameIndex() + 1;
    attachFrame(frame, index, saved);
    doc.frame = frame;
    let kept = saved;
    history.push({
      label,
      undo() { kept = detachFrame(frame); doc.frame = prev; },
      redo() { attachFrame(frame, index, kept); doc.frame = frame; },
    });
    framesChanged();
  }

  $('#f-add').addEventListener('click', () => {
    if (busy()) return;
    stopPlay();
    insertFrameStep('New frame', newFrame(), []);
  });

  $('#f-dup').addEventListener('click', () => {
    if (busy()) return;
    stopPlay();
    const frame = newFrame();
    const copies = [];
    for (const layer of doc.layers) {
      const cel = layer.cels.get(doc.frame.id);
      if (cel) copies.push([layer, copyCanvas(cel)]);
    }
    insertFrameStep('Duplicate frame', frame, copies);
  });

  $('#f-del').addEventListener('click', () => {
    if (busy()) return;
    stopPlay();
    if (doc.frames.length <= 1) { toast('You need at least one frame.'); return; }
    const frame = doc.frame;
    const index = frameIndex();
    let saved = detachFrame(frame);
    const neighbour = () => doc.frames[Math.min(index, doc.frames.length - 1)];
    doc.frame = neighbour();
    history.push({
      label: 'Delete frame',
      undo() { attachFrame(frame, index, saved); doc.frame = frame; },
      redo() { saved = detachFrame(frame); doc.frame = neighbour(); },
    });
    framesChanged();
    toast(`Deleted frame ${index + 1}. Press Undo to bring it back.`);
  });

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------
  let playing = false;
  let lastTick = 0, elapsed = 0;

  function startPlay() {
    if (playing || busy()) return;
    if (doc.frames.length < 2) { toast('Add more frames to play an animation.'); return; }
    closePanels();
    playing = true;
    elapsed = 0;
    lastTick = performance.now();
    cursorEl.style.display = 'none';
    updatePlayButton();
    refreshOnion();
    requestAnimationFrame(playTick);
  }
  function playTick(t) {
    if (!playing) return;
    elapsed = Math.min(elapsed + (t - lastTick), 1000);
    lastTick = t;
    const dur = 1000 / doc.fps;
    if (elapsed >= dur) {
      const steps = Math.floor(elapsed / dur);
      elapsed -= steps * dur;
      goFrame(doc.frames[(frameIndex() + steps) % doc.frames.length]);
    }
    requestAnimationFrame(playTick);
  }
  function stopPlay() {
    if (!playing) return;
    playing = false;
    updatePlayButton();
    refreshOnion();
    refreshLayersPanel();
  }
  function togglePlay() { if (playing) stopPlay(); else startPlay(); }
  function updatePlayButton() {
    $('#play-label').textContent = playing ? 'Stop' : 'Play';
    $('#play-icon').innerHTML = playing ? '<rect x="6" y="6" width="12" height="12" rx="1.5"/>' : '<path d="M7 4.5v15l12-7.5z"/>';
    $('#btn-play').classList.toggle('active', playing);
  }
  $('#btn-play').addEventListener('click', togglePlay);

  $('#fps').addEventListener('input', (e) => {
    doc.fps = +e.target.value;
    $('#fps-out').textContent = doc.fps + ' fps';
    saveSettings();
  });

  // Onion skin controls
  $('#btn-onion').addEventListener('click', () => {
    state.onion.enabled = !state.onion.enabled;
    saveSettings();
    syncUI();
    refreshOnion();
  });
  function onionInput(id, key) {
    $('#' + id).addEventListener('input', (e) => {
      state.onion[key] = +e.target.value;
      if (key !== 'opacity' || state.onion.enabled) state.onion.enabled = true;
      saveSettings();
      syncUI();
      refreshOnion();
    });
  }
  onionInput('o-prev', 'prev');
  onionInput('o-next', 'next');
  onionInput('o-opacity', 'opacity');

  // ---------------------------------------------------------------------------
  // Layers panel
  // ---------------------------------------------------------------------------
  const ICONS = {
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24"><path d="m3 3 18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
  };

  const layerList = $('#layer-list');
  const layersPanel = $('#panel-layers');
  const blendSelect = $('#l-blend');
  BLEND_MODES.forEach(([value, label]) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    blendSelect.appendChild(o);
  });

  // Called whenever layers change: redraw the canvas, thumbnails and panel.
  function layersChanged() {
    markAllThumbs();
    refreshOnion();
    refreshLayersPanel();
  }

  function refreshLayersPanel() {
    $('#layers-label').textContent = doc.layers.length > 1 ? `Layers (${doc.layers.length})` : 'Layers';
    if (layersPanel.hidden) return;
    buildLayerList();
  }

  function buildLayerList() {
    layerList.innerHTML = '';
    // Show the top layer first, like most art apps.
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      const li = document.createElement('li');
      li.className = 'layer-row' + (layer === doc.active ? ' active' : '') + (layer.visible ? '' : ' hidden-layer');

      const thumb = document.createElement('canvas');
      thumb.className = 'thumb';
      thumb.width = Math.round(64 * DPR); thumb.height = Math.round(36 * DPR);
      const cel = celOf(layer, doc.frame);
      if (cel) thumb.getContext('2d').drawImage(cel, 0, 0, thumb.width, thumb.height);

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = layer.name;
      const extra = [];
      if (layer.static) extra.push('All frames');
      if (layer.blend !== 'source-over') extra.push(BLEND_MODES.find((m) => m[0] === layer.blend)[1].split(' ')[0]);
      if (layer.opacity < 1) extra.push(Math.round(layer.opacity * 100) + '%');
      if (extra.length) {
        const badge = document.createElement('span');
        badge.className = 'layer-badge';
        badge.textContent = ' ' + extra.join(' · ');
        name.appendChild(badge);
      }

      const eye = document.createElement('button');
      eye.className = 'icon-toggle';
      eye.title = layer.visible ? 'Hide this layer' : 'Show this layer';
      eye.innerHTML = layer.visible ? ICONS.eye : ICONS.eyeOff;
      eye.addEventListener('click', (ev) => {
        ev.stopPropagation();
        layer.visible = !layer.visible;
        layersChanged();
      });

      const lock = document.createElement('button');
      lock.className = 'icon-toggle' + (layer.locked ? ' on' : '');
      lock.title = layer.locked ? 'Unlock this layer' : 'Lock this layer (prevents drawing on it)';
      lock.innerHTML = layer.locked ? ICONS.lock : ICONS.unlock;
      lock.addEventListener('click', (ev) => {
        ev.stopPropagation();
        layer.locked = !layer.locked;
        refreshLayersPanel();
      });

      li.append(thumb, name, eye, lock);
      li.addEventListener('click', () => {
        if (doc.active !== layer) { doc.active = layer; refreshLayersPanel(); }
      });
      name.addEventListener('dblclick', () => startRename(layer));
      layerList.appendChild(li);
    }

    const idx = layerIndex(doc.active);
    $('#layer-count').textContent = `${doc.layers.length} of ${MAX_LAYERS}`;
    $('#l-add').disabled = doc.layers.length >= MAX_LAYERS;
    $('#l-dup').disabled = doc.layers.length >= MAX_LAYERS;
    $('#l-del').disabled = doc.layers.length <= 1;
    $('#l-merge').disabled = idx <= 0;
    $('#l-up').disabled = idx >= doc.layers.length - 1;
    $('#l-down').disabled = idx <= 0;
    $('#l-opacity').value = Math.round(doc.active.opacity * 100);
    $('#l-opacity-out').textContent = Math.round(doc.active.opacity * 100) + '%';
    $('#l-static').checked = doc.active.static;
    blendSelect.value = doc.active.blend;
  }

  // Undo step for adding a layer (used by "New layer" and "Duplicate").
  function addLayerStep(label, layer, index) {
    const prevActive = doc.active;
    putLayer(layer, index);
    doc.active = layer;
    history.push({
      label,
      undo() { takeLayer(layer); doc.active = prevActive; },
      redo() { putLayer(layer, index); doc.active = layer; },
    });
    layersChanged();
  }

  $('#l-add').addEventListener('click', () => {
    if (busy() || doc.layers.length >= MAX_LAYERS) return;
    addLayerStep('New layer', newLayer(), layerIndex(doc.active) + 1);
  });

  $('#l-dup').addEventListener('click', () => {
    if (busy() || doc.layers.length >= MAX_LAYERS) return;
    const src = doc.active;
    const copy = newLayer(src.name + ' copy');
    layerCounter--; // a copy doesn't use up a "Layer N" number
    src.cels.forEach((cel, key) => copy.cels.set(key, copyCanvas(cel)));
    copy.static = src.static;
    copy.opacity = src.opacity;
    copy.blend = src.blend;
    copy.visible = src.visible;
    addLayerStep('Duplicate layer', copy, layerIndex(src) + 1);
  });

  $('#l-del').addEventListener('click', () => {
    if (busy()) return;
    if (doc.layers.length <= 1) { toast('You need at least one layer.'); return; }
    const layer = doc.active;
    const index = takeLayer(layer);
    const below = () => doc.layers[Math.max(0, index - 1)];
    doc.active = below();
    history.push({
      label: 'Delete layer',
      undo() { putLayer(layer, index); doc.active = layer; },
      redo() { takeLayer(layer); doc.active = below(); },
    });
    layersChanged();
    toast(`Deleted "${layer.name}" (on all frames). Press Undo to bring it back.`);
  });

  $('#l-merge').addEventListener('click', () => {
    if (busy()) return;
    const upper = doc.active;
    const index = layerIndex(upper);
    if (index <= 0) return;
    const lower = doc.layers[index - 1];
    if (lower.locked || upper.locked) { toast('Unlock both layers before merging them.'); return; }
    if (lower.static !== upper.static) {
      toast('Both layers need the same "Same on every frame" setting to merge.');
      return;
    }
    // Merge on every frame. The lower layer gets new drawings; the old ones are kept for undo.
    const beforeCels = new Map(lower.cels);
    const afterCels = new Map(lower.cels);
    if (upper.visible) {
      upper.cels.forEach((cel, key) => {
        const merged = copyCanvas(lower.cels.get(key));
        const ctx = merged.getContext('2d');
        ctx.globalAlpha = upper.opacity;
        ctx.globalCompositeOperation = upper.blend;
        ctx.drawImage(cel, 0, 0);
        afterCels.set(key, merged);
      });
    }
    lower.cels = afterCels;
    takeLayer(upper);
    doc.active = lower;
    history.push({
      label: 'Merge down',
      undo() { lower.cels = beforeCels; putLayer(upper, index); doc.active = upper; },
      redo() { lower.cels = afterCels; takeLayer(upper); doc.active = lower; },
    });
    layersChanged();
  });

  function moveLayer(dir) {
    if (busy()) return;
    const layer = doc.active;
    const from = layerIndex(layer), to = from + dir;
    if (to < 0 || to >= doc.layers.length) return;
    // Swaps the layer between its two positions (used for move, undo and redo).
    const swap = () => {
      const i = layerIndex(layer), j = i === from ? to : from;
      [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]];
      doc.active = layer;
    };
    swap();
    history.push({ label: 'Move layer', undo: swap, redo: swap });
    layersChanged();
  }
  $('#l-up').addEventListener('click', () => moveLayer(1));
  $('#l-down').addEventListener('click', () => moveLayer(-1));

  // A small helper for undoable layer settings (opacity, blend mode, name).
  function setLayerProp(layer, key, oldValue, newValue, label) {
    if (oldValue === newValue) return;
    layer[key] = newValue;
    history.push({
      label,
      undo() { layer[key] = oldValue; doc.active = layer; },
      redo() { layer[key] = newValue; doc.active = layer; },
    });
    layersChanged();
  }

  // Opacity: preview while dragging, save one undo step when you let go.
  let opacityStart = null;
  $('#l-opacity').addEventListener('input', (e) => {
    const layer = doc.active;
    if (!opacityStart || opacityStart.layer !== layer) opacityStart = { layer, value: layer.opacity };
    layer.opacity = +e.target.value / 100;
    $('#l-opacity-out').textContent = e.target.value + '%';
    requestRender();
  });
  $('#l-opacity').addEventListener('change', () => {
    if (!opacityStart) return;
    const { layer, value } = opacityStart;
    opacityStart = null;
    const now = layer.opacity;
    layer.opacity = value;
    setLayerProp(layer, 'opacity', value, now, 'Layer opacity');
    if (value === now) layersChanged();
  });

  blendSelect.addEventListener('change', () => {
    const layer = doc.active;
    setLayerProp(layer, 'blend', layer.blend, blendSelect.value, 'Blend mode');
  });

  // "Same on every frame": ON uses this frame's drawing for all frames.
  // OFF puts that shared drawing onto this frame; other frames go back to their own drawings.
  $('#l-static').addEventListener('change', (e) => {
    const layer = doc.active;
    const on = e.target.checked;
    if (busy() || layer.static === on) return;
    stopPlay();
    const beforeCels = new Map(layer.cels);
    const afterCels = new Map(layer.cels);
    const frameNo = frameIndex() + 1;
    if (on) {
      afterCels.set('static', copyCanvas(layer.cels.get(doc.frame.id)));
    } else {
      const shared = afterCels.get('static');
      afterCels.delete('static');
      if (shared) afterCels.set(doc.frame.id, shared);
    }
    const apply = (isStatic, cels) => { layer.static = isStatic; layer.cels = cels; doc.active = layer; };
    apply(on, afterCels);
    history.push({
      label: 'Same on every frame',
      undo() { apply(!on, beforeCels); },
      redo() { apply(on, afterCels); },
    });
    layersChanged();
    toast(on
      ? `"${layer.name}" now shows the same drawing on every frame.`
      : `"${layer.name}" now changes from frame to frame. Its drawing was kept on frame ${frameNo}.`);
  });

  function startRename(layer) {
    if (busy()) return;
    doc.active = layer;
    buildLayerList();
    const row = layerList.querySelector('.layer-row.active');
    const label = row.querySelector('.layer-name');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'layer-name-input';
    input.value = layer.name;
    input.maxLength = 40;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (keep && name && name !== layer.name) setLayerProp(layer, 'name', layer.name, name, 'Rename layer');
      else buildLayerList();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }
  $('#l-rename').addEventListener('click', () => startRename(doc.active));

  // ---------------------------------------------------------------------------
  // Toolbar and other panels
  // ---------------------------------------------------------------------------
  function setTool(t) {
    if (t === 'eyedropper' && state.tool !== 'eyedropper') state.prevTool = state.tool;
    state.tool = t;
    syncUI();
  }
  $$('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-clear').addEventListener('click', clearLayer);

  function closePanels() {
    if (document.activeElement && document.activeElement.classList.contains('layer-name-input')) {
      document.activeElement.blur();
    }
    $$('.panel').forEach((p) => { p.hidden = true; });
    $$('.btn.open').forEach((b) => b.classList.remove('open'));
  }
  function openPanel(panel, anchor) {
    closePanels();
    panel.hidden = false;
    anchor.classList.add('open');
    if (panel.id === 'panel-layers') buildLayerList();
    if (panel.id === 'panel-brush') drawBrushPreviews();
    if (panel.id === 'panel-color') picker.markPrevious();
    const r = anchor.getBoundingClientRect();
    const left = clamp(r.left, 8, Math.max(8, window.innerWidth - panel.offsetWidth - 8));
    panel.style.left = left + 'px';
    if (anchor.closest('.timeline')) {
      // Panels for the timeline open upward.
      panel.style.top = '';
      panel.style.bottom = (window.innerHeight - r.top + 6) + 'px';
      panel.style.maxHeight = (r.top - 14) + 'px';
    } else {
      const tb = $('.toolbar').getBoundingClientRect();
      panel.style.bottom = '';
      panel.style.top = (tb.bottom + 6) + 'px';
      panel.style.maxHeight = (window.innerHeight - tb.bottom - 14) + 'px';
    }
  }
  $$('[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById(btn.dataset.panel);
      if (panel.hidden) openPanel(panel, btn); else closePanels();
    });
  });
  // Tapping anywhere outside a panel closes it.
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.panel') || e.target.closest('[data-panel]')) return;
    closePanels();
  }, true);

  // Brush type buttons, each with a little preview stroke.
  const brushGrid = $('#brush-types');
  Brushes.ORDER.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'brush-type';
    b.dataset.type = t;
    b.innerHTML = `<canvas></canvas><span>${Brushes.TYPES[t].label}</span>`;
    b.addEventListener('click', () => {
      state.brushType = t;
      if (state.tool !== 'brush') state.tool = 'brush';
      saveSettings();
      syncUI();
    });
    brushGrid.appendChild(b);
  });
  function drawBrushPreviews() {
    $$('.brush-type').forEach((b) => {
      const t = b.dataset.type;
      Brushes.drawPreview(b.querySelector('canvas'), t, state.color, state.brushes[t].opacity / 100);
    });
  }

  // Blend tool mode buttons
  $$('#blend-modes button').forEach((b) => b.addEventListener('click', () => {
    state.blend.mode = b.dataset.mode;
    saveSettings();
    syncUI();
  }));

  // Sliders
  function onInput(id, fn) {
    $('#' + id).addEventListener('input', (e) => { fn(e.target); saveSettings(); syncUI(); });
  }
  onInput('quick-size', (el) => { currentSettings().size = sliderToSize(+el.value); });
  onInput('b-size', (el) => { state.brushes[state.brushType].size = sliderToSize(+el.value); });
  onInput('b-opacity', (el) => { state.brushes[state.brushType].opacity = +el.value; });
  onInput('b-smoothing', (el) => { state.brushes[state.brushType].smoothing = +el.value; });
  onInput('b-pressure', (el) => { state.pressure = el.checked; });
  onInput('e-size', (el) => { state.eraser.size = sliderToSize(+el.value); });
  onInput('e-softness', (el) => { state.eraser.softness = +el.value; });
  onInput('e-smoothing', (el) => { state.eraser.smoothing = +el.value; });
  onInput('x-size', (el) => { state.blend.size = sliderToSize(+el.value); });
  onInput('x-strength', (el) => { state.blend.strength = +el.value; });
  onInput('x-smoothing', (el) => { state.blend.smoothing = +el.value; });
  onInput('x-pressure', (el) => { state.pressure = el.checked; });
  $('#b-opacity').addEventListener('change', () => { if (!$('#panel-brush').hidden) drawBrushPreviews(); });

  // Color wheel
  const picker = new ColorPicker($('#color-picker'), {
    onChange(hex) {
      state.color = hex;
      saveSettings();
      $('#color-swatch').style.background = hex;
    },
    onEyedropper() {
      closePanels();
      setTool('eyedropper');
    },
  });
  picker.setHex(state.color, true);
  picker.setRecent(recent);

  function addRecent(hex) {
    if (recent[0] === hex) return;
    recent = [hex].concat(recent.filter((c) => c !== hex)).slice(0, 10);
    store.set('ap.recentColors.v1', recent);
    picker.setRecent(recent);
  }

  // Make every button, slider and label match the current settings.
  function syncUI() {
    $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
    $$('.brush-type').forEach((b) => b.classList.toggle('active', b.dataset.type === state.brushType));
    $$('#blend-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.blend.mode));

    const tool = state.tool;
    const label = tool === 'eraser' ? 'Eraser' : tool === 'blend' ? 'Blend' : Brushes.TYPES[state.brushType].label;
    $('#settings-label').textContent = label;
    $('#brush-section').hidden = tool === 'eraser' || tool === 'blend';
    $('#eraser-section').hidden = tool !== 'eraser';
    $('#blend-section').hidden = tool !== 'blend';

    const cur = currentSettings();
    $('#quick-size').value = sizeToSlider(cur.size);
    $('#quick-size-out').textContent = cur.size;

    const b = state.brushes[state.brushType];
    $('#b-size').value = sizeToSlider(b.size);
    $('#b-size-out').textContent = b.size;
    $('#b-opacity').value = b.opacity;
    $('#b-opacity-out').textContent = b.opacity + '%';
    $('#b-smoothing').value = b.smoothing;
    $('#b-smoothing-out').textContent = b.smoothing + '%';
    $('#b-pressure').checked = state.pressure;

    $('#e-size').value = sizeToSlider(state.eraser.size);
    $('#e-size-out').textContent = state.eraser.size;
    $('#e-softness').value = state.eraser.softness;
    $('#e-softness-out').textContent = state.eraser.softness + '%';
    $('#e-smoothing').value = state.eraser.smoothing;
    $('#e-smoothing-out').textContent = state.eraser.smoothing + '%';

    $('#x-size').value = sizeToSlider(state.blend.size);
    $('#x-size-out').textContent = state.blend.size;
    $('#x-strength').value = state.blend.strength;
    $('#x-strength-out').textContent = state.blend.strength + '%';
    $('#x-smoothing').value = state.blend.smoothing;
    $('#x-smoothing-out').textContent = state.blend.smoothing + '%';
    $('#x-pressure').checked = state.pressure;

    $('#fps').value = doc.fps;
    $('#fps-out').textContent = doc.fps + ' fps';
    $('#btn-onion').classList.toggle('active', state.onion.enabled);
    $('#o-prev').value = state.onion.prev;
    $('#o-prev-out').textContent = state.onion.prev;
    $('#o-next').value = state.onion.next;
    $('#o-next-out').textContent = state.onion.next;
    $('#o-opacity').value = state.onion.opacity;
    $('#o-opacity-out').textContent = state.onion.opacity + '%';

    $('#color-swatch').style.background = state.color;
    display.classList.toggle('picking', tool === 'eyedropper');
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target.matches && e.target.matches('input[type=text], select')) return; // typing in a box
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    if (k === ' ') {
      e.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      togglePlay();
    } else if (k === ',' || k === 'arrowleft') { e.preventDefault(); stepFrame(-1); }
    else if (k === '.' || k === 'arrowright') { e.preventDefault(); stepFrame(1); }
    else if (k === 'b') setTool('brush');
    else if (k === 'e') setTool('eraser');
    else if (k === 's') setTool('blend');
    else if (k === 'i') setTool('eyedropper');
    else if (k === 'o') $('#btn-onion').click();
    else if (k === 'escape') closePanels();
    else if (k === '[' || k === ']') {
      const s = currentSettings();
      s.size = k === '['
        ? Math.max(1, Math.min(s.size - 1, Math.round(s.size / 1.15)))
        : Math.min(SIZE_MAX, Math.max(s.size + 1, Math.round(s.size * 1.15)));
      saveSettings();
      syncUI();
    }
  });
  // Space on a focused button shouldn't also "click" it.
  window.addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); });

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  syncUI();
  fit();
  buildStrip();
  history.onChange();
  refreshLayersPanel();
  requestRender();
})();
