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
    eraser: Object.assign({ size: 30, opacity: 100, softness: 0, smoothing: 20 }, saved.eraser || {}),
    blend: Object.assign({ mode: 'smudge', size: 40, strength: 50, smoothing: 20 }, saved.blend || {}),
    onion: Object.assign({ enabled: true, prev: 1, next: 0, opacity: 35 }, saved.onion || {}),
    fingerDraw: saved.fingerDraw !== false,
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
      fingerDraw: state.fingerDraw, stylusSeen: typeof stylusSeen !== 'undefined' && stylusSeen,
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
  // The view: how the canvas is zoomed, rotated and moved on screen
  // ---------------------------------------------------------------------------
  const stage = $('#stage');
  const wrap = $('#canvas-wrap');
  const cursorEl = $('#cursor');
  // s = zoom (1 = fit to screen), r = rotation in radians,
  // tx/ty = how far the canvas center is from the screen center, in pixels.
  const view = { s: 1, r: 0, tx: 0, ty: 0 };
  let baseW = DOC_W, baseH = DOC_H; // canvas size on screen when "fit"
  const S_MIN = 0.2;
  const sMax = () => (16 * DOC_W) / baseW; // up to 1600% of real size

  function fit() {
    const narrow = stage.clientWidth < 640;
    const side = narrow ? 62 : 70;   // leave room for the side bar
    const pad = narrow ? 10 : 24;
    const scale = Math.min((stage.clientWidth - side * 2) / DOC_W, (stage.clientHeight - pad * 2) / DOC_H);
    baseW = Math.max(50, Math.floor(DOC_W * scale));
    baseH = Math.max(28, Math.floor(DOC_H * scale));
    wrap.style.width = baseW + 'px';
    wrap.style.height = baseH + 'px';
    applyView();
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
  window.addEventListener('resize', () => { fit(); closePanels(); });

  function applyView() {
    wrap.style.transform =
      `translate(-50%, -50%) translate(${view.tx}px, ${view.ty}px) rotate(${view.r}rad) scale(${view.s})`;
    const zoom = (view.s * baseW) / DOC_W; // 1 = real pixel size
    wrap.classList.toggle('pixelated', zoom >= 4);
    let deg = Math.round(((view.r * 180) / Math.PI) % 360);
    if (deg > 180) deg -= 360;
    if (deg <= -180) deg += 360;
    $('#zoom-readout').textContent = Math.round(zoom * 100) + '%' + (deg ? ` · ${deg}°` : '');
  }

  // Change zoom/rotation while keeping the point (px, py) on screen fixed.
  // Points are measured from the center of the drawing area.
  function setViewAround(px, py, s2, r2) {
    const dx = px - view.tx, dy = py - view.ty;
    const c = Math.cos(view.r), sn = Math.sin(view.r);
    const lx = (dx * c + dy * sn) / view.s, ly = (-dx * sn + dy * c) / view.s;
    s2 = clamp(s2, S_MIN, sMax());
    const c2 = Math.cos(r2), sn2 = Math.sin(r2);
    view.tx = px - (lx * c2 - ly * sn2) * s2;
    view.ty = py - (lx * sn2 + ly * c2) * s2;
    view.s = s2;
    view.r = r2;
    applyView();
  }
  function fitView() { view.s = 1; view.r = 0; view.tx = 0; view.ty = 0; applyView(); }
  function actualSize() { setViewAround(view.tx, view.ty, DOC_W / baseW, view.r); }
  function straighten() { setViewAround(view.tx, view.ty, view.s, 0); }
  function zoomBy(f) { setViewAround(0, 0, view.s * f, view.r); }
  // After a pinch, a rotation close to straight (or a quarter turn) snaps to it.
  function snapRotation() {
    const q = Math.PI / 2;
    const near = Math.round(view.r / q) * q;
    if (Math.abs(view.r - near) < 0.14) setViewAround(view.tx, view.ty, view.s, near);
  }

  // Screen position -> position on the drawing (in drawing pixels).
  function stagePoint(e, sr) {
    return { x: e.clientX - sr.left - sr.width / 2, y: e.clientY - sr.top - sr.height / 2 };
  }
  function toDoc(e, sr) {
    const p = stagePoint(e, sr || stage.getBoundingClientRect());
    const dx = p.x - view.tx, dy = p.y - view.ty;
    const c = Math.cos(view.r), sn = Math.sin(view.r);
    const ux = (dx * c + dy * sn) / view.s, uy = (-dx * sn + dy * c) / view.s;
    return {
      x: (ux + baseW / 2) * (DOC_W / baseW),
      y: (uy + baseH / 2) * (DOC_H / baseH),
      // Only a stylus reports real pressure. Mouse and finger count as full pressure.
      pressure: e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 1,
    };
  }

  // The circle that shows your brush size under the mouse or stylus.
  function updateCursor(e) {
    if (e.pointerType === 'touch' || state.tool === 'eyedropper' || playing || gesture ||
        (e.target.closest && e.target.closest('.sidebar'))) {
      cursorEl.style.display = 'none';
      return;
    }
    const sr = stage.getBoundingClientRect();
    showCursorAt(e.clientX - sr.left, e.clientY - sr.top);
  }
  function showCursorAt(x, y) {
    const d = Math.max(4, currentSettings().size * view.s * (baseW / DOC_W));
    cursorEl.style.display = 'block';
    cursorEl.style.width = cursorEl.style.height = d + 'px';
    cursorEl.style.left = x + 'px';
    cursorEl.style.top = y + 'px';
  }

  // Mouse wheel zooms; Shift + wheel rotates. (A trackpad pinch also zooms.)
  stage.addEventListener('wheel', (e) => {
    if (e.target.closest('.sidebar')) return;
    e.preventDefault();
    const p = stagePoint(e, stage.getBoundingClientRect());
    let d = e.deltaY || e.deltaX;
    if (e.deltaMode === 1) d *= 16;
    if (e.shiftKey) setViewAround(p.x, p.y, view.s, view.r + d * 0.003);
    else setViewAround(p.x, p.y, view.s * Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0015)), view.r);
  }, { passive: false });

  // ---------------------------------------------------------------------------
  // Mouse / touch / stylus input
  // ---------------------------------------------------------------------------
  let activePointer = null; // only one finger/pen draws at a time
  let stroke = null;        // brush or eraser stroke in progress
  let blendStroke = null;   // Blend tool stroke in progress
  let strokeTarget = null;  // { layer, cel } being drawn on
  let strokeStart = 0;
  let smooth = null;
  let lastRaw = null;
  let strokeSmoothing = 0;

  const touches = new Map(); // fingers currently on the screen
  let gesture = null;        // two-finger pinch in progress
  let tapSession = null;     // used to spot two- and three-finger taps
  let panDrag = null;        // right-click drag to move the canvas
  let stylusSeen = !!saved.stylusSeen;

  // Palm rejection: the first time a stylus is used, finger drawing turns off.
  function noticeStylus() {
    if (stylusSeen) return;
    stylusSeen = true;
    if (state.fingerDraw) {
      state.fingerDraw = false;
      toast('Stylus detected: finger drawing is now off, so your palm won\'t leave marks. You can turn it back on in the menu.');
    }
    saveSettings();
    syncUI();
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

  function startDrawing(e) {
    e.preventDefault();
    if (playing) { stopPlay(); return; }
    const p = toDoc(e);

    if (state.tool === 'eyedropper') {
      activePointer = e.pointerId;
      try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      pickColor(p);
      return;
    }

    const layer = activeLayer();
    if (!canEdit(layer)) return;
    activePointer = e.pointerId;
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }

    const st = currentSettings();
    strokeSmoothing = st.smoothing / 100;
    smooth = { x: p.x, y: p.y, pressure: p.pressure };
    lastRaw = p;
    strokeStart = performance.now();

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
      opacity: st.opacity / 100,
      softness: isEraser ? st.softness / 100 : 0,
      pressure: state.pressure,
    });
    stroke.begin({ x: p.x, y: p.y, pressure: p.pressure });
    requestRender();
  }

  // Throw away the stroke in progress (used when a second finger lands).
  function abortStroke() {
    if (stroke) {
      stroke = null;
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, DOC_W, DOC_H);
    }
    if (blendStroke) {
      const res = blendStroke.end();
      if (res) strokeTarget.cel.getContext('2d').putImageData(res.before, res.rect.x, res.rect.y);
      blendStroke = null;
    }
    strokeTarget = null;
    activePointer = null;
    requestRender();
  }

  function finishPointer(e) {
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
    if (tapSession) tapSession.drew = true; // a real stroke isn't an undo tap
    if (blendStroke) commitBlend();
    else {
      if (state.tool !== 'eraser') addRecent(state.color);
      stroke.end();
      commitStroke();
    }
  }

  // Two-finger pinch: zoom, rotate and move together.
  function startGesture() {
    const ids = [...touches.keys()].slice(0, 2);
    const a = touches.get(ids[0]), b = touches.get(ids[1]);
    gesture = { ids, a0: { x: a.x, y: a.y }, b0: { x: b.x, y: b.y }, view0: { ...view }, rotating: false };
    cursorEl.style.display = 'none';
  }
  function updateGesture() {
    const g = gesture;
    const a = touches.get(g.ids[0]), b = touches.get(g.ids[1]);
    if (!a || !b) return;
    const v0 = g.view0;
    const m0 = { x: (g.a0.x + g.b0.x) / 2, y: (g.a0.y + g.b0.y) / 2 };
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d0 = Math.max(1, Math.hypot(g.b0.x - g.a0.x, g.b0.y - g.a0.y));
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    let turn = Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(g.b0.y - g.a0.y, g.b0.x - g.a0.x);
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    if (!g.rotating && Math.abs(turn) > 0.12) g.rotating = true; // ignore tiny accidental twists
    if (Math.abs(d - d0) > 12 || Math.hypot(m.x - m0.x, m.y - m0.y) > 12 || g.rotating) {
      if (tapSession) tapSession.moved = true;
    }
    // The spot on the drawing that was under your fingers stays under them.
    const dx = m0.x - v0.tx, dy = m0.y - v0.ty;
    const c = Math.cos(v0.r), sn = Math.sin(v0.r);
    const lx = (dx * c + dy * sn) / v0.s, ly = (-dx * sn + dy * c) / v0.s;
    const s2 = clamp(v0.s * (d / d0), S_MIN, sMax());
    const r2 = v0.r + (g.rotating ? turn : 0);
    const c2 = Math.cos(r2), sn2 = Math.sin(r2);
    view.tx = m.x - (lx * c2 - ly * sn2) * s2;
    view.ty = m.y - (lx * sn2 + ly * c2) * s2;
    view.s = s2;
    view.r = r2;
    applyView();
  }
  function endGesture() {
    gesture = null;
    snapRotation();
  }

  function touchPoint(e) {
    const sr = stage.getBoundingClientRect();
    return stagePoint(e, sr);
  }

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sidebar')) return;
    if (e.pointerType === 'pen') noticeStylus();

    if (e.pointerType === 'touch') {
      const p = touchPoint(e);
      touches.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y });
      try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (!tapSession) tapSession = { start: performance.now(), max: 0, moved: false, drew: false };
      tapSession.max = Math.max(tapSession.max, touches.size);
      if (touches.size === 2) {
        // A second finger means a gesture, not drawing. If the first finger
        // only just started a stroke, throw it away; otherwise keep it.
        if (activePointer !== null) {
          if (busy() && performance.now() - strokeStart > 300) finishPointer({ pointerId: activePointer });
          else abortStroke();
        }
        startGesture();
      } else if (touches.size === 1 && state.fingerDraw) {
        startDrawing(e);
      }
      return;
    }

    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) {
      e.preventDefault();
      panDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
      try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      stage.classList.add('panning');
      cursorEl.style.display = 'none';
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (activePointer !== null) return;
    startDrawing(e);
  });

  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      const t = touches.get(e.pointerId);
      const p = touchPoint(e);
      t.x = p.x; t.y = p.y;
      if (tapSession && Math.hypot(t.x - t.sx, t.y - t.sy) > 12) tapSession.moved = true;
      if (gesture) { updateGesture(); return; }
    }
    if (panDrag && e.pointerId === panDrag.id) {
      view.tx = panDrag.tx + (e.clientX - panDrag.x);
      view.ty = panDrag.ty + (e.clientY - panDrag.y);
      applyView();
      return;
    }
    updateCursor(e);
    if (e.pointerId !== activePointer) return;
    if (state.tool === 'eyedropper') { pickColor(toDoc(e)); return; }
    if (!busy()) return;
    const sr = stage.getBoundingClientRect();
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = list.length ? list : [e];
    for (const ev of events) {
      const p = toDoc(ev, sr);
      lastRaw = p;
      feed(p);
    }
    if (blendStroke) blendStroke.flush();
    requestRender();
  });

  function onPointerUp(e) {
    if (panDrag && e.pointerId === panDrag.id) {
      panDrag = null;
      stage.classList.remove('panning');
      return;
    }
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.delete(e.pointerId);
      if (gesture && touches.size < 2) endGesture();
      finishPointer(e);
      if (touches.size === 0 && tapSession) {
        const s = tapSession;
        tapSession = null;
        if (!s.moved && !s.drew && performance.now() - s.start < 400) {
          if (s.max === 2) undo();
          else if (s.max === 3) redo();
        }
      }
      return;
    }
    finishPointer(e);
  }
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  stage.addEventListener('lostpointercapture', (e) => { if (!touches.has(e.pointerId)) finishPointer(e); });
  stage.addEventListener('pointerleave', () => { if (activePointer === null) cursorEl.style.display = 'none'; });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // Stop the page itself from zooming or scrolling on touch screens.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (e.target.closest('#stage')) e.preventDefault(); }, { passive: false });

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
    $('#layers-badge').textContent = doc.layers.length > 1 ? doc.layers.length : '';
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
  // Tap a tool to choose it; tap it again to open its settings.
  $$('[data-tool]').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.tool;
    if (state.tool === t && t !== 'eyedropper') {
      const panel = $('#panel-brush');
      if (panel.hidden) openPanel(panel, b); else closePanels();
    } else {
      closePanels();
      setTool(t);
    }
  }));

  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-clear').addEventListener('click', () => { closePanels(); clearLayer(); });

  // Menu: view and touch settings
  $('#zoom-readout').addEventListener('click', fitView);
  $('#m-fit').addEventListener('click', fitView);
  $('#m-actual').addEventListener('click', actualSize);
  $('#m-straighten').addEventListener('click', straighten);
  $('#m-finger').addEventListener('change', (e) => { state.fingerDraw = e.target.checked; saveSettings(); });

  // Side bar sliders (size and opacity). Drag up or down.
  const bubble = $('#bubble');
  function makeVSlider(el, opts) {
    el.innerHTML = '<div class="vs-track"><div class="vs-fill"></div></div><div class="vs-thumb"></div>';
    const fill = el.querySelector('.vs-fill'), thumb = el.querySelector('.vs-thumb');
    let dragging = false;
    const update = () => {
      const f = clamp(opts.get(), 0, 1);
      fill.style.height = f * 100 + '%';
      thumb.style.bottom = f * 100 + '%';
    };
    const fromEvent = (e) => {
      const r = el.getBoundingClientRect();
      opts.set(clamp(1 - (e.clientY - r.top) / r.height, 0, 1));
      update();
      const sr = stage.getBoundingClientRect(), tr = thumb.getBoundingClientRect();
      bubble.textContent = opts.text();
      bubble.style.display = 'block';
      bubble.style.left = ($('#sidebar').getBoundingClientRect().right - sr.left + 10) + 'px';
      bubble.style.top = (tr.top + tr.height / 2 - sr.top) + 'px';
      if (opts.onDrag) opts.onDrag();
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      fromEvent(e);
    });
    el.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      bubble.style.display = 'none';
      cursorEl.style.display = 'none';
      saveSettings();
      syncUI();
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    return { update };
  }
  const opacityKey = () => (state.tool === 'blend' ? 'strength' : 'opacity');
  const sizeSlider = makeVSlider($('#s-size'), {
    get: () => sizeToSlider(currentSettings().size) / 100,
    set: (f) => { currentSettings().size = sliderToSize(f * 100); },
    text: () => `Size ${currentSettings().size}`,
    // Preview the brush size in the middle of the screen while dragging.
    onDrag: () => showCursorAt(stage.clientWidth / 2, stage.clientHeight / 2),
  });
  const opacitySlider = makeVSlider($('#s-opacity'), {
    get: () => (currentSettings()[opacityKey()] - 1) / 99,
    set: (f) => { currentSettings()[opacityKey()] = Math.round(1 + f * 99); },
    text: () => `${state.tool === 'blend' ? 'Strength' : 'Opacity'} ${currentSettings()[opacityKey()]}%`,
  });

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
      const tb = $('.topbar').getBoundingClientRect();
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
    if (e.target.closest('.panel') || e.target.closest('[data-panel]') || e.target.closest('[data-tool]')) return;
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
  onInput('b-size', (el) => { state.brushes[state.brushType].size = sliderToSize(+el.value); });
  onInput('b-opacity', (el) => { state.brushes[state.brushType].opacity = +el.value; });
  onInput('b-smoothing', (el) => { state.brushes[state.brushType].smoothing = +el.value; });
  onInput('b-pressure', (el) => { state.pressure = el.checked; });
  onInput('e-size', (el) => { state.eraser.size = sliderToSize(+el.value); });
  onInput('e-softness', (el) => { state.eraser.softness = +el.value; });
  onInput('e-smoothing', (el) => { state.eraser.smoothing = +el.value; });
  onInput('e-opacity', (el) => { state.eraser.opacity = +el.value; });
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
    $('#brush-section').hidden = tool === 'eraser' || tool === 'blend';
    $('#eraser-section').hidden = tool !== 'eraser';
    $('#blend-section').hidden = tool !== 'blend';

    sizeSlider.update();
    opacitySlider.update();
    $('#s-size').title = `${label} size`;
    $('#s-opacity').title = tool === 'blend' ? 'Blend strength' : `${label} opacity`;
    $('#m-finger').checked = state.fingerDraw;

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
    $('#e-opacity').value = state.eraser.opacity;
    $('#e-opacity-out').textContent = state.eraser.opacity + '%';

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
    stage.classList.toggle('picking', tool === 'eyedropper');
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
    else if (k === '0') fitView();
    else if (k === '=' || k === '+') zoomBy(1.25);
    else if (k === '-') zoomBy(0.8);
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
