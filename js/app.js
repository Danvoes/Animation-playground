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
  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 2800);
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
  // hold = how many beats the frame stays on screen during playback.
  const newFrame = () => ({ id: 'f' + (++frameIds), hold: 1 });

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
  // The stroke buffer clipped to the selection.
  const maskedBuf = makeCanvas(DOC_W, DOC_H), mctx = maskedBuf.getContext('2d');

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
    quickShape: saved.quickShape !== false,
    fillGap: saved.fillGap != null ? saved.fillGap : 12,
    playMode: ['loop', 'pingpong', 'once'].includes(saved.playMode) ? saved.playMode : 'loop',
    selectMode: saved.selectMode === 'rect' ? 'rect' : 'lasso',
    tfUniform: saved.tfUniform !== false,
    exportSize: ['360', '720', '1080'].includes(saved.exportSize) ? saved.exportSize : '720',
    exportLoops: [1, 2, 3].includes(saved.exportLoops) ? saved.exportLoops : 1,
    exportSound: saved.exportSound !== false,
    showTimes: saved.showTimes !== false,
    timelapse: saved.timelapse !== false,
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
      quickShape: state.quickShape, fillGap: state.fillGap, playMode: state.playMode,
      selectMode: state.selectMode, tfUniform: state.tfUniform,
      exportSize: state.exportSize, exportLoops: state.exportLoops, exportSound: state.exportSound,
      showTimes: state.showTimes, timelapse: state.timelapse,
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
    scheduleAutosave();
    tlSchedule();
  };

  const busy = () => !!(stroke || blendStroke);

  function undo() {
    if (transform) { cancelTransform(); return; } // undo while transforming = cancel it
    if (!busy()) { stopPlay(); afterHistory(history.undo()); }
  }
  function redo() {
    if (transform) return;
    if (!busy()) { stopPlay(); afterHistory(history.redo()); }
  }

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
    audioChanged();
  }

  // Checks before changing a layer's pixels.
  function canEdit(layer) {
    if (layer.locked) { toast(`"${layer.name}" is locked. Unlock it in the Layers panel to draw on it.`); return false; }
    if (!layer.visible) { toast(`"${layer.name}" is hidden. Show it in the Layers panel to draw on it.`); return false; }
    return true;
  }

  // extra (optional): { undo(), redo() } for anything else that changes with the pixels.
  function pushPixelStep(label, layer, cel, rect, before, after, extra) {
    const ctx = cel.getContext('2d');
    markCelDirty(cel);
    history.push({
      label,
      frame: doc.frame,
      allFrames: layer.static,
      undo() { ctx.putImageData(before, rect.x, rect.y); markCelDirty(cel); if (extra) extra.undo(); },
      redo() { ctx.putImageData(after, rect.x, rect.y); markCelDirty(cel); if (extra) extra.redo(); },
    });
    if (layer.static) markAllThumbs(); else markThumb(doc.frame);
    refreshLayersPanel();
  }

  function clearLayer() {
    if (busy()) return;
    stopPlay();
    const layer = activeLayer();
    if (!canEdit(layer)) return;
    if (transform) applyTransform();
    const cel = celOf(layer, doc.frame);
    if (!cel) { toast(`"${layer.name}" is already empty on this frame.`); return; }
    const ctx = cel.getContext('2d');
    if (selection) {
      // Only erase inside the selection.
      const r = selection.bounds;
      const before = ctx.getImageData(r.x, r.y, r.w, r.h);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(selection.mask, 0, 0);
      ctx.restore();
      const after = ctx.getImageData(r.x, r.y, r.w, r.h);
      pushPixelStep('Erase selection', layer, cel, r, before, after);
      requestRender();
      return;
    }
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
      let src = buffer;
      if (selection) {
        // Only show paint inside the selection.
        mctx.globalCompositeOperation = 'source-over';
        mctx.clearRect(0, 0, DOC_W, DOC_H);
        mctx.drawImage(buffer, 0, 0);
        mctx.globalCompositeOperation = 'destination-in';
        mctx.drawImage(selection.mask, 0, 0);
        mctx.globalCompositeOperation = 'source-over';
        src = maskedBuf;
      }
      sctx.globalAlpha = stroke.opacity;
      sctx.globalCompositeOperation = stroke.composite;
      sctx.drawImage(src, 0, 0);
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = 'source-over';
      override = { layer, canvas: scratch };
    } else if (transform && transform.frame === doc.frame) {
      // Show the layer with the moved/resized/rotated part in its new place.
      sctx.globalCompositeOperation = 'source-over';
      sctx.globalAlpha = 1;
      sctx.clearRect(0, 0, DOC_W, DOC_H);
      sctx.drawImage(transform.hole, 0, 0);
      drawTransformed(sctx, transform.float);
      override = { layer: transform.layer, canvas: scratch };
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
    sizeUI();
    applyView();
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
  window.addEventListener('resize', () => { fit(); closePanels(); });

  function applyView() {
    wrap.style.transform =
      `translate(-50%, -50%) translate(${view.tx}px, ${view.ty}px) rotate(${view.r}rad) scale(${view.s})`;
    const zoom = (view.s * baseW) / DOC_W; // 1 = real pixel size
    wrap.classList.toggle('pixelated', zoom >= 4);
    if (typeof drawSelOverlay === 'function') { drawSelOverlay(); drawUI(); }
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
    if (e.pointerType === 'touch' || state.tool === 'eyedropper' || state.tool === 'select' ||
        state.tool === 'transform' || playing || gesture ||
        (e.target.closest && e.target.closest('.sidebar, .transform-bar'))) {
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
    if (e.target.closest('.sidebar, .transform-bar')) return;
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
  let picking = null;        // 'tool' (Pick color tool) or 'temp' (Alt-click / touch and hold)
  let pickPrev = null;       // the color before picking started
  let holdPickTimer = null;
  // QuickShape
  let strokeOpts = null, strokePts = [], snapped = false, holdTimer = null, holdAt = null;
  let strokeTaper = 0, strokeDist = 0; // taper length in pixels, distance drawn so far

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
    const q = { x: smooth.x, y: smooth.y, pressure: smooth.pressure };
    if (stroke) {
      const lp = strokePts[strokePts.length - 1];
      strokeDist += Math.hypot(q.x - lp.x, q.y - lp.y);
      q.d = strokeDist;
      q.w = Brushes.taperAt(strokeDist, null, strokeTaper); // thin start; the end is tapered on release
      strokePts.push(q);
    }
    (stroke || blendStroke).moveTo(q);
  }

  // ---- Picking a color (Pick color tool, Alt-click, or touch and hold) ----
  const loupe = $('#loupe');
  function beginPick(e, mode) {
    activePointer = e.pointerId;
    picking = mode;
    pickPrev = state.color;
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    pickAt(e);
  }
  function pickAt(e) {
    pickColor(toDoc(e));
    const sr = stage.getBoundingClientRect();
    const x = e.clientX - sr.left;
    let y = e.clientY - sr.top - 80; // above your finger so you can see it
    if (y < 50) y += 160;
    loupe.style.left = x + 'px';
    loupe.style.top = y + 'px';
    loupe.style.borderColor = `${state.color} ${state.color} ${pickPrev} ${pickPrev}`;
    loupe.style.display = 'block';
    cursorEl.style.display = 'none';
  }
  function endPick(keep) {
    const mode = picking;
    picking = null;
    activePointer = null;
    loupe.style.display = 'none';
    if (keep === false) picker.setHex(pickPrev);
    else addRecent(state.color);
    if (mode === 'tool') setTool(state.prevTool || 'brush');
  }

  // ---- QuickShape: hold still at the end of a stroke to snap it to a clean shape ----
  function armHold(e) {
    clearTimeout(holdTimer);
    holdAt = { x: e.clientX, y: e.clientY };
    holdTimer = setTimeout(trySnap, 550);
  }
  function trySnap() {
    if (!stroke || snapped || !state.quickShape) return;
    const shape = QuickShape.detect(strokePts);
    if (!shape) return;
    let pr = 0;
    for (const q of strokePts) pr += q.pressure;
    pr /= strokePts.length;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, DOC_W, DOC_H);
    const s2 = Brushes.createStroke(strokeOpts);
    shape.points.forEach((q, i) => {
      const pt = { x: q.x, y: q.y, pressure: pr };
      if (i === 0) s2.begin(pt); else s2.moveTo(pt);
    });
    s2.needsTick = false;
    stroke = s2;
    snapped = true;
    toast(shape.name, 1200);
    requestRender();
  }

  function startDrawing(e) {
    e.preventDefault();
    if (playing) { stopPlay(); return; }
    const p = toDoc(e);

    // Pick color tool, or Alt/Option + click with a mouse or stylus.
    const altPick = e.altKey && e.pointerType !== 'touch';
    if (state.tool === 'eyedropper' || altPick) {
      beginPick(e, state.tool === 'eyedropper' ? 'tool' : 'temp');
      return;
    }

    if (state.tool === 'select') { beginSelect(e, p); return; }
    if (state.tool === 'transform') {
      if (!transform && !startTransform()) return;
      beginTransformDrag(e);
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
    strokeOpts = {
      type: isEraser ? 'eraser' : state.brushType,
      ctx: bctx,
      color: state.color,
      size: st.size,
      opacity: st.opacity / 100,
      softness: isEraser ? st.softness / 100 : 0,
      pressure: state.pressure,
      pressureMin: isEraser ? 0.3 : st.pmin / 100,
      jitter: isEraser ? 0 : st.jitter / 100,
    };
    strokeTaper = isEraser || Brushes.TYPES[state.brushType].noTaper ? 0 : Brushes.taperLength(st.size, st.taper);
    strokeDist = 0;
    stroke = Brushes.createStroke(strokeOpts);
    const first = { x: p.x, y: p.y, pressure: p.pressure, d: 0, w: Brushes.taperAt(0, null, strokeTaper) };
    strokePts = [first];
    snapped = false;
    stroke.begin(first);
    armHold(e);
    requestRender();
  }

  // Throw away the stroke in progress (used when a second finger lands).
  function abortStroke() {
    clearTimeout(holdTimer);
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
    if (picking) { endPick(); return; }
    if (selDraft) { activePointer = null; endSelect(); return; }
    if (tfDrag) { activePointer = null; tfDrag = null; return; }
    activePointer = null;
    clearTimeout(holdTimer);
    if (!busy()) return;
    // Let the smoothed line catch up to where you actually stopped.
    if (lastRaw && strokeSmoothing > 0 && !snapped) {
      for (let i = 0; i < 40 && Math.hypot(lastRaw.x - smooth.x, lastRaw.y - smooth.y) > 0.5; i++) feed(lastRaw);
    }
    if (tapSession) tapSession.drew = true; // a real stroke isn't an undo tap
    if (blendStroke) commitBlend();
    else {
      if (state.tool !== 'eraser') addRecent(state.color);
      // Taper the end of the line: redraw the stroke now that we know where it ends.
      if (strokeTaper && !snapped && strokePts.length > 1) {
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.clearRect(0, 0, DOC_W, DOC_H);
        const s2 = Brushes.createStroke(strokeOpts);
        strokePts.forEach((q, i) => {
          const pt = { x: q.x, y: q.y, pressure: q.pressure, w: Brushes.taperAt(q.d || 0, strokeDist, strokeTaper) };
          if (i === 0) s2.begin(pt); else s2.moveTo(pt);
        });
        stroke = s2;
      }
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
    if (e.target.closest('.sidebar, .transform-bar')) return;
    if (e.pointerType === 'pen') noticeStylus();

    if (e.pointerType === 'touch') {
      const p = touchPoint(e);
      touches.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y });
      try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (!tapSession) tapSession = { start: performance.now(), max: 0, moved: false, drew: false };
      tapSession.max = Math.max(tapSession.max, touches.size);
      clearTimeout(holdPickTimer);
      if (touches.size === 2) {
        // A second finger means a gesture, not drawing. If the first finger
        // only just started a stroke, throw it away; otherwise keep it.
        if (picking) endPick(false);
        if (selDraft) { selDraft = null; activePointer = null; drawSelOverlay(); }
        if (tfDrag) { Object.assign(transform, tfDrag.start); tfDrag = null; activePointer = null; refreshTransform(); }
        if (activePointer !== null) {
          if (busy() && performance.now() - strokeStart > 300) finishPointer({ pointerId: activePointer });
          else abortStroke();
        }
        startGesture();
      } else if (touches.size === 1 && (state.fingerDraw || state.tool === 'select' || state.tool === 'transform')) {
        startDrawing(e);
      } else if (touches.size === 1) {
        // Finger drawing is off: touch and hold to pick a color.
        holdPickTimer = setTimeout(() => {
          if (touches.size === 1 && tapSession && !tapSession.moved && !gesture && activePointer === null) {
            beginPick(e, 'temp');
          }
        }, 450);
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
    if (picking) { pickAt(e); return; }
    if (selDraft) { extendSelect(e); return; }
    if (tfDrag) { moveTransformDrag(e); return; }
    if (!busy()) return;
    if (snapped) return; // the shape is done; lift to keep it
    if (stroke && (!holdAt || Math.hypot(e.clientX - holdAt.x, e.clientY - holdAt.y) > 4)) armHold(e);
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
      clearTimeout(holdPickTimer);
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
      if (selection) {
        // Keep only the paint inside the selection.
        bctx.globalCompositeOperation = 'destination-in';
        bctx.drawImage(selection.mask, 0, 0);
        bctx.globalCompositeOperation = 'source-over';
      }
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
      const ctx = cel.getContext('2d');
      const after = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      if (selection) {
        // Put back everything outside the selection.
        const m = selection.data, a = after.data, b = before.data;
        for (let y = 0; y < rect.h; y++) {
          for (let x = 0; x < rect.w; x++) {
            const k = m[((rect.y + y) * DOC_W + rect.x + x) * 4 + 3] / 255;
            if (k === 1) continue;
            const i = (y * rect.w + x) * 4;
            for (let c = 0; c < 4; c++) a[i + c] = b[i + c] + (a[i + c] - b[i + c]) * k;
          }
        }
        ctx.putImageData(after, rect.x, rect.y);
      }
      pushPixelStep('Blend', layer, cel, rect, before, after);
    }
    requestRender();
  }

  // ---------------------------------------------------------------------------
  // Selection: choose an area so changes only affect the inside
  // ---------------------------------------------------------------------------
  const selOverlay = $('#sel-overlay');
  selOverlay.width = DOC_W;
  selOverlay.height = DOC_H;
  const soctx = selOverlay.getContext('2d');
  // selection = { mask (canvas: opaque = selected), data (its pixels), polys (outlines), bounds }
  let selection = null;
  let selDraft = null; // the outline being drawn right now
  let antsOffset = 0, antsTimer = null;

  // The smallest rectangle around all non-transparent pixels.
  function alphaBounds(data) {
    let minX = DOC_W, minY = DOC_H, maxX = -1, maxY = -1;
    for (let y = 0; y < DOC_H; y++) {
      const row = y * DOC_W * 4;
      for (let x = 0; x < DOC_W; x++) {
        if (data[row + x * 4 + 3]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
  function selectionFromMask(mask, polys) {
    const data = mask.getContext('2d').getImageData(0, 0, DOC_W, DOC_H).data;
    const bounds = alphaBounds(data);
    return bounds ? { mask, data, polys, bounds } : null;
  }
  function selectionFromPolys(polys) {
    const mask = makeCanvas(DOC_W, DOC_H);
    const m = mask.getContext('2d');
    m.fillStyle = '#000';
    for (const poly of polys) {
      m.beginPath();
      poly.forEach((q, i) => (i ? m.lineTo(q.x, q.y) : m.moveTo(q.x, q.y)));
      m.closePath();
      m.fill();
    }
    return selectionFromMask(mask, polys);
  }
  function setSelection(sel) {
    selection = sel;
    if (selection && !antsTimer) {
      antsTimer = setInterval(() => { antsOffset = (antsOffset + 1) % 12; drawSelOverlay(); }, 110);
    } else if (!selection && antsTimer) {
      clearInterval(antsTimer);
      antsTimer = null;
    }
    drawSelOverlay();
  }

  // Marching ants around the selection, plus a light tint outside it.
  function drawSelOverlay() {
    soctx.setTransform(1, 0, 0, 1, 0, 0);
    soctx.globalCompositeOperation = 'source-over';
    soctx.clearRect(0, 0, DOC_W, DOC_H);
    const zoom = (view.s * baseW) / DOC_W;
    const outline = (polys, closed) => {
      soctx.lineWidth = 1.5 / zoom;
      soctx.beginPath();
      for (const poly of polys) {
        poly.forEach((q, i) => (i ? soctx.lineTo(q.x, q.y) : soctx.moveTo(q.x, q.y)));
        if (closed) soctx.closePath();
      }
      soctx.setLineDash([]);
      soctx.strokeStyle = 'rgba(255,255,255,0.95)';
      soctx.stroke();
      soctx.setLineDash([6 / zoom, 6 / zoom]);
      soctx.lineDashOffset = -antsOffset / zoom;
      soctx.strokeStyle = '#1f2328';
      soctx.stroke();
      soctx.setLineDash([]);
    };
    if (transform && transform.polys) {
      outline(transform.polys.map((poly) => poly.map(tfMap)), true);
    } else if (selection) {
      soctx.fillStyle = 'rgba(30,50,120,0.09)';
      soctx.fillRect(0, 0, DOC_W, DOC_H);
      soctx.globalCompositeOperation = 'destination-out';
      soctx.drawImage(selection.mask, 0, 0);
      soctx.globalCompositeOperation = 'source-over';
      if (selection.polys) outline(selection.polys, true);
    }
    if (selDraft) {
      const poly = draftPoly();
      if (poly.length > 1) outline([poly], selDraft.mode === 'rect');
    }
  }

  function beginSelect(e, p) {
    activePointer = e.pointerId;
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    selDraft = { mode: state.selectMode, pts: [p], start: p, end: p, sx: e.clientX, sy: e.clientY, far: 0 };
    drawSelOverlay();
  }
  function extendSelect(e) {
    const p = toDoc(e);
    const d = selDraft;
    d.far = Math.max(d.far, Math.hypot(e.clientX - d.sx, e.clientY - d.sy));
    const last = d.pts[d.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) > 1.5) d.pts.push(p);
    d.end = p;
    drawSelOverlay();
  }
  function draftPoly() {
    const d = selDraft;
    if (d.mode === 'rect') {
      return [d.start, { x: d.end.x, y: d.start.y }, d.end, { x: d.start.x, y: d.end.y }];
    }
    return d.pts;
  }
  function endSelect() {
    const d = selDraft;
    const poly = draftPoly();
    selDraft = null;
    if (d.far < 6) { setSelection(null); return; } // a tap clears the selection
    const sel = selectionFromPolys([poly]);
    setSelection(sel);
    if (!sel) toast('Nothing was selected. Draw around an area.');
  }

  // Selection panel actions
  function needSelection() {
    if (!selection) { toast('Select an area first: choose the Select tool and draw around it.'); return false; }
    return true;
  }
  $$('#select-modes button').forEach((b) => b.addEventListener('click', () => {
    state.selectMode = b.dataset.mode;
    saveSettings();
    syncUI();
  }));
  $('#sel-all').addEventListener('click', () => {
    setSelection(selectionFromPolys([[{ x: 0, y: 0 }, { x: DOC_W, y: 0 }, { x: DOC_W, y: DOC_H }, { x: 0, y: DOC_H }]]));
    closePanels();
  });
  $('#sel-none').addEventListener('click', () => { setSelection(null); closePanels(); });
  $('#sel-invert').addEventListener('click', () => {
    if (!needSelection()) return;
    const mask = makeCanvas(DOC_W, DOC_H);
    const m = mask.getContext('2d');
    m.fillRect(0, 0, DOC_W, DOC_H);
    m.globalCompositeOperation = 'destination-out';
    m.drawImage(selection.mask, 0, 0);
    const outer = [{ x: 0, y: 0 }, { x: DOC_W, y: 0 }, { x: DOC_W, y: DOC_H }, { x: 0, y: DOC_H }];
    setSelection(selectionFromMask(mask, (selection.polys || []).concat([outer])));
    closePanels();
  });
  $('#sel-copy').addEventListener('click', () => {
    if (!needSelection() || busy()) return;
    const src = activeLayer();
    const cel = celOf(src, doc.frame);
    if (!cel) { toast(`"${src.name}" has nothing here to copy.`); return; }
    if (doc.layers.length >= MAX_LAYERS) { toast(`You can have up to ${MAX_LAYERS} layers.`); return; }
    const copy = copyCanvas(cel);
    const c = copy.getContext('2d');
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(selection.mask, 0, 0);
    const layer = newLayer(src.name + ' (part)');
    layer.static = src.static;
    layer.cels.set(celKey(layer, doc.frame), copy);
    addLayerStep('Copy selection', layer, layerIndex(src) + 1);
    closePanels();
    toast('Copied the selected part to a new layer. Use Transform to move it.');
  });
  $('#sel-fill').addEventListener('click', () => {
    if (!needSelection()) return;
    const layer = activeLayer();
    if (!canEdit(layer)) return;
    const r = selection.bounds;
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.globalCompositeOperation = 'source-over';
    fctx.clearRect(0, 0, DOC_W, DOC_H);
    fctx.fillStyle = state.color;
    fctx.fillRect(r.x, r.y, r.w, r.h);
    fctx.globalCompositeOperation = 'destination-in';
    fctx.drawImage(selection.mask, 0, 0);
    fctx.globalCompositeOperation = 'source-over';
    const cel = ensureCel(layer, doc.frame);
    const ctx = cel.getContext('2d');
    const before = ctx.getImageData(r.x, r.y, r.w, r.h);
    ctx.drawImage(fillCanvas, 0, 0);
    const after = ctx.getImageData(r.x, r.y, r.w, r.h);
    pushPixelStep('Fill selection', layer, cel, r, before, after);
    addRecent(state.color);
    closePanels();
    requestRender();
  });
  $('#sel-erase').addEventListener('click', () => {
    if (!needSelection()) return;
    closePanels();
    clearLayer();
  });

  // ---------------------------------------------------------------------------
  // Transform: move, resize and rotate the selection (or the whole layer)
  // ---------------------------------------------------------------------------
  const ui = $('#ui-overlay');
  const uctx = ui.getContext('2d');
  let transform = null; // the part being transformed and where it is now
  let tfDrag = null;    // the handle being dragged
  let tfPrevTool = 'brush';
  const tfBar = $('#transform-bar');

  function sizeUI() {
    ui.width = Math.round(stage.clientWidth * DPR);
    ui.height = Math.round(stage.clientHeight * DPR);
    drawUI();
  }
  // Drawing position -> position in the drawing area on screen.
  function docToStage(x, y) {
    const ux = (x * (baseW / DOC_W) - baseW / 2) * view.s, uy = (y * (baseH / DOC_H) - baseH / 2) * view.s;
    const c = Math.cos(view.r), sn = Math.sin(view.r);
    return { x: ux * c - uy * sn + view.tx + stage.clientWidth / 2, y: ux * sn + uy * c + view.ty + stage.clientHeight / 2 };
  }
  // Where a point of the original picture ends up after the transform.
  function tfMap(q) {
    const t = transform;
    const lx = (q.x - t.ox) * t.sx, ly = (q.y - t.oy) * t.sy;
    const c = Math.cos(t.rot), sn = Math.sin(t.rot);
    return { x: t.cx + lx * c - ly * sn, y: t.cy + lx * sn + ly * c };
  }
  const tfLocalCorners = () => {
    const hw = transform.w / 2, hh = transform.h / 2;
    return [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
  };
  const tfCorners = () => tfLocalCorners().map((l) => tfMap({ x: transform.ox + l.x, y: transform.oy + l.y }));
  function drawTransformed(ctx, img) {
    const t = transform;
    ctx.save();
    ctx.translate(t.cx, t.cy);
    ctx.rotate(t.rot);
    ctx.scale(t.sx, t.sy);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -t.w / 2, -t.h / 2);
    ctx.restore();
  }

  // The box with handles, drawn on top in screen pixels so it's always easy to grab.
  function drawUI() {
    uctx.setTransform(1, 0, 0, 1, 0, 0);
    uctx.clearRect(0, 0, ui.width, ui.height);
    if (!transform) return;
    uctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const C = tfCorners().map((q) => docToStage(q.x, q.y));
    const mid = docToStage(transform.cx, transform.cy);
    const top = { x: (C[0].x + C[1].x) / 2, y: (C[0].y + C[1].y) / 2 };
    let dx = top.x - mid.x, dy = top.y - mid.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const rot = { x: top.x + dx * 30, y: top.y + dy * 30 };
    uctx.beginPath();
    C.forEach((q, i) => (i ? uctx.lineTo(q.x, q.y) : uctx.moveTo(q.x, q.y)));
    uctx.closePath();
    uctx.moveTo(top.x, top.y);
    uctx.lineTo(rot.x, rot.y);
    uctx.lineWidth = 3;
    uctx.strokeStyle = 'rgba(255,255,255,0.9)';
    uctx.stroke();
    uctx.lineWidth = 1.5;
    uctx.strokeStyle = '#4f6df5';
    uctx.stroke();
    for (const q of C) {
      uctx.beginPath();
      uctx.arc(q.x, q.y, 8, 0, Math.PI * 2);
      uctx.fillStyle = '#fff';
      uctx.fill();
      uctx.lineWidth = 2;
      uctx.strokeStyle = '#4f6df5';
      uctx.stroke();
    }
    uctx.beginPath();
    uctx.arc(rot.x, rot.y, 8, 0, Math.PI * 2);
    uctx.fillStyle = '#4f6df5';
    uctx.fill();
    uctx.lineWidth = 2;
    uctx.strokeStyle = '#fff';
    uctx.stroke();
    transform.ui = { C, rot };
  }
  function refreshTransform() {
    requestRender();
    drawUI();
    drawSelOverlay();
  }

  // Lift the selected part (or the whole layer) so it can be moved.
  function startTransform() {
    const layer = activeLayer();
    if (!canEdit(layer)) return false;
    const cel = celOf(layer, doc.frame);
    if (!cel) { toast(`"${layer.name}" has nothing to move on this frame.`); return false; }
    const lifted = copyCanvas(cel);
    const lc = lifted.getContext('2d');
    if (selection) {
      lc.globalCompositeOperation = 'destination-in';
      lc.drawImage(selection.mask, 0, 0);
    }
    const bb = alphaBounds(lc.getImageData(0, 0, DOC_W, DOC_H).data);
    if (!bb) {
      toast(selection ? 'There is nothing to move inside the selection on this layer.' : `"${layer.name}" has nothing to move on this frame.`);
      return false;
    }
    const float = makeCanvas(bb.w, bb.h);
    float.getContext('2d').drawImage(lifted, -bb.x, -bb.y);
    const hole = copyCanvas(cel);
    const hc = hole.getContext('2d');
    if (selection) {
      hc.globalCompositeOperation = 'destination-out';
      hc.drawImage(selection.mask, 0, 0);
    } else hc.clearRect(0, 0, DOC_W, DOC_H);
    let maskFloat = null;
    if (selection) {
      maskFloat = makeCanvas(bb.w, bb.h);
      maskFloat.getContext('2d').drawImage(selection.mask, -bb.x, -bb.y);
    }
    const ox = bb.x + bb.w / 2, oy = bb.y + bb.h / 2;
    transform = {
      layer, cel, frame: doc.frame, float, hole, maskFloat,
      polys: selection ? selection.polys : null,
      before: cel.getContext('2d').getImageData(0, 0, DOC_W, DOC_H),
      ox, oy, w: bb.w, h: bb.h, cx: ox, cy: oy, sx: 1, sy: 1, rot: 0,
    };
    tfBar.hidden = false;
    $('#tf-uniform').classList.toggle('on', state.tfUniform);
    refreshTransform();
    return true;
  }

  function endTransformUI() {
    transform = null;
    tfDrag = null;
    tfBar.hidden = true;
    refreshTransform();
  }
  function cancelTransform() {
    if (!transform) return;
    endTransformUI();
  }
  // Put the transformed part down for good (undoable).
  function applyTransform() {
    const t = transform;
    if (!t) return;
    const moved = t.cx !== t.ox || t.cy !== t.oy || t.sx !== 1 || t.sy !== 1 || t.rot !== 0;
    if (moved) {
      const ctx = t.cel.getContext('2d');
      ctx.clearRect(0, 0, DOC_W, DOC_H);
      ctx.drawImage(t.hole, 0, 0);
      drawTransformed(ctx, t.float);
      const after = ctx.getImageData(0, 0, DOC_W, DOC_H);
      // The selection moves along with the picture (and moves back on undo).
      const selBefore = selection;
      let selAfter = selection;
      if (t.maskFloat) {
        const mask = makeCanvas(DOC_W, DOC_H);
        drawTransformed(mask.getContext('2d'), t.maskFloat);
        selAfter = selectionFromMask(mask, t.polys ? t.polys.map((poly) => poly.map(tfMap)) : null);
      }
      const frameNow = doc.frame;
      doc.frame = t.frame;
      pushPixelStep('Transform', t.layer, t.cel, { x: 0, y: 0, w: DOC_W, h: DOC_H }, t.before, after, {
        undo() { setSelection(selBefore); },
        redo() { setSelection(selAfter); },
      });
      doc.frame = frameNow;
      setSelection(selAfter);
    }
    endTransformUI();
  }

  function beginTransformDrag(e) {
    const t = transform;
    const sr = stage.getBoundingClientRect();
    const sp = { x: e.clientX - sr.left, y: e.clientY - sr.top };
    const near = (q) => Math.hypot(sp.x - q.x, sp.y - q.y) < 24;
    let mode = 'move', corner = -1;
    if (t.ui && near(t.ui.rot)) mode = 'rotate';
    else if (t.ui) t.ui.C.forEach((q, k) => { if (corner < 0 && near(q)) { mode = 'scale'; corner = k; } });
    activePointer = e.pointerId;
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const p0 = toDoc(e);
    tfDrag = { mode, corner, p0, start: { cx: t.cx, cy: t.cy, sx: t.sx, sy: t.sy, rot: t.rot } };
    if (mode === 'scale') {
      const L = tfLocalCorners();
      tfDrag.local = L[corner];
      tfDrag.oppLocal = L[(corner + 2) % 4];
      tfDrag.anchor = tfCorners()[(corner + 2) % 4];
    }
    if (mode === 'rotate') tfDrag.a0 = Math.atan2(p0.y - t.cy, p0.x - t.cx);
  }
  function moveTransformDrag(e) {
    const t = transform, d = tfDrag, s0 = d.start;
    const p = toDoc(e);
    if (d.mode === 'move') {
      t.cx = s0.cx + (p.x - d.p0.x);
      t.cy = s0.cy + (p.y - d.p0.y);
    } else if (d.mode === 'rotate') {
      let a = s0.rot + Math.atan2(p.y - s0.cy, p.x - s0.cx) - d.a0;
      const q = Math.PI / 4, near = Math.round(a / q) * q;
      if (Math.abs(a - near) < 0.05) a = near; // snap to straight and diagonal angles
      t.rot = a;
    } else {
      // Resize from the dragged corner; the opposite corner stays put.
      const A = d.anchor;
      const c = Math.cos(s0.rot), sn = Math.sin(s0.rot);
      const vx = (p.x - A.x) * c + (p.y - A.y) * sn, vy = -(p.x - A.x) * sn + (p.y - A.y) * c;
      const dlx = d.local.x - d.oppLocal.x, dly = d.local.y - d.oppLocal.y;
      let sx = vx / dlx, sy = vy / dly;
      if (state.tfUniform) {
        const kx = dlx * s0.sx, ky = dly * s0.sy;
        const f = (vx * kx + vy * ky) / (kx * kx + ky * ky);
        sx = s0.sx * f;
        sy = s0.sy * f;
      }
      const minS = (v) => (v < 0 ? -1 : 1) * Math.max(0.02, Math.abs(v));
      sx = minS(sx); sy = minS(sy);
      t.sx = sx; t.sy = sy; t.rot = s0.rot;
      const ox = d.oppLocal.x * sx, oy = d.oppLocal.y * sy;
      t.cx = A.x - (ox * c - oy * sn);
      t.cy = A.y - (ox * sn + oy * c);
    }
    refreshTransform();
  }

  // Transform bar buttons
  $('#tf-uniform').addEventListener('click', () => {
    state.tfUniform = !state.tfUniform;
    $('#tf-uniform').classList.toggle('on', state.tfUniform);
    saveSettings();
  });
  $('#tf-fliph').addEventListener('click', () => { if (transform) { transform.sx = -transform.sx; refreshTransform(); } });
  $('#tf-flipv').addEventListener('click', () => { if (transform) { transform.sy = -transform.sy; refreshTransform(); } });
  $('#tf-rot90').addEventListener('click', () => { if (transform) { transform.rot += Math.PI / 2; refreshTransform(); } });
  $('#tf-reset').addEventListener('click', () => {
    if (!transform) return;
    Object.assign(transform, { cx: transform.ox, cy: transform.oy, sx: 1, sy: 1, rot: 0 });
    refreshTransform();
  });
  $('#tf-cancel').addEventListener('click', () => { cancelTransform(); setTool(tfPrevTool); });
  $('#tf-done').addEventListener('click', () => { applyTransform(); setTool(tfPrevTool); });

  // ---- Color fill: drag the color circle onto an area ----
  // The fill looks at everything you can see on this frame (all visible
  // layers) to find the edges, and paints onto the selected layer.
  const fillCanvas = makeCanvas(DOC_W, DOC_H), fctx = fillCanvas.getContext('2d');
  function fillAt(p) {
    const layer = activeLayer();
    if (!canEdit(layer)) return;
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
    if (x0 < 0 || y0 < 0 || x0 >= DOC_W || y0 >= DOC_H) return;
    stopPlay();
    drawFrame(fctx, doc.frame, { transparent: true });
    const src = fctx.getImageData(0, 0, DOC_W, DOC_H).data;
    const W = DOC_W, H = DOC_H;
    const tol = (state.fillGap / 100) * 255;
    const i0 = (y0 * W + x0) * 4;
    const tr = src[i0], tg = src[i0 + 1], tb = src[i0 + 2], ta = src[i0 + 3];
    const sel = selection ? selection.data : null;
    if (sel && sel[i0 + 3] < 128) { toast('Tap inside the selection to fill it.'); return; }
    const same = (i) => {
      if (sel && sel[i + 3] < 128) return false; // the selection's edge is a wall
      const a = src[i + 3];
      if (Math.abs(a - ta) > tol) return false;
      if (a < 8 && ta < 8) return true; // both see-through
      return Math.abs(src[i] - tr) <= tol && Math.abs(src[i + 1] - tg) <= tol && Math.abs(src[i + 2] - tb) <= tol;
    };
    const mask = new Uint8Array(W * H);
    const stack = [x0, y0];
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      let l = x;
      while (l >= 0 && !mask[y * W + l] && same((y * W + l) * 4)) l--;
      l++;
      let up = false, down = false;
      for (let r = l; r < W && !mask[y * W + r] && same((y * W + r) * 4); r++) {
        mask[y * W + r] = 1;
        if (y > 0) {
          const ok = !mask[(y - 1) * W + r] && same(((y - 1) * W + r) * 4);
          if (ok && !up) { stack.push(r, y - 1); up = true; } else if (!ok) up = false;
        }
        if (y < H - 1) {
          const ok = !mask[(y + 1) * W + r] && same(((y + 1) * W + r) * 4);
          if (ok && !down) { stack.push(r, y + 1); down = true; } else if (!ok) down = false;
        }
      }
    }
    // Grow the fill by 1 pixel so it tucks under soft line edges (no white halo).
    let minX = W, minY = H, maxX = -1, maxY = -1;
    const grown = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (mask[i] || (x > 0 && mask[i - 1]) || (x < W - 1 && mask[i + 1]) ||
            (y > 0 && mask[i - W]) || (y < H - 1 && mask[i + W])) {
          grown[i] = 1;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return;
    const rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    const rgb = Color.hexToRgb(state.color);
    const img = new ImageData(rect.w, rect.h);
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const gi = (rect.y + y) * W + rect.x + x;
        if (!grown[gi] || (sel && sel[gi * 4 + 3] < 128)) continue;
        const o = (y * rect.w + x) * 4;
        img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
      }
    }
    fctx.clearRect(0, 0, W, H);
    fctx.putImageData(img, rect.x, rect.y);
    const cel = ensureCel(layer, doc.frame);
    const ctx = cel.getContext('2d');
    const before = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    ctx.drawImage(fillCanvas, 0, 0);
    const after = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    pushPixelStep('Fill', layer, cel, rect, before, after);
    addRecent(state.color);
    requestRender();
  }

  // Dragging from the color button
  const colorBtn = $('#btn-color');
  const dropDot = $('#drop-dot');
  let colorDrag = null, suppressColorClick = false;
  colorBtn.addEventListener('pointerdown', (e) => {
    suppressColorClick = false;
    colorDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, active: false };
    try { colorBtn.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
  colorBtn.addEventListener('pointermove', (e) => {
    if (!colorDrag || e.pointerId !== colorDrag.id) return;
    if (!colorDrag.active && Math.hypot(e.clientX - colorDrag.x, e.clientY - colorDrag.y) > 10) {
      colorDrag.active = true;
      closePanels();
      dropDot.style.background = state.color;
      dropDot.style.display = 'block';
    }
    if (colorDrag.active) {
      dropDot.style.left = e.clientX + 'px';
      dropDot.style.top = e.clientY + 'px';
    }
  });
  function endColorDrag(e, cancelled) {
    if (!colorDrag || e.pointerId !== colorDrag.id) return;
    const d = colorDrag;
    colorDrag = null;
    dropDot.style.display = 'none';
    if (!d.active) return;
    suppressColorClick = true;
    if (cancelled) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el.closest('#stage') && !el.closest('.sidebar')) fillAt(toDoc(e));
  }
  colorBtn.addEventListener('pointerup', (e) => endColorDrag(e, false));
  colorBtn.addEventListener('pointercancel', (e) => endColorDrag(e, true));

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
      const tl = audioClips.length ? buildTimeline() : null;
      for (const f of dirtyThumbs) {
        const cell = cells.get(f);
        if (!cell) continue;
        const g = cell.canvas.getContext('2d');
        drawFrame(g, f, { w: cell.canvas.width, h: cell.canvas.height });
        if (tl) drawThumbWave(g, f, tl, cell.canvas.width, cell.canvas.height);
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
      label.className = 'frame-label';
      btn.append(canvas, label);
      btn.addEventListener('click', () => {
        if (suppressFrameClick) { suppressFrameClick = false; return; }
        stopPlay();
        if (f === doc.frame) {
          // Tap the selected frame again for its options.
          const panel = $('#panel-frame');
          if (panel.hidden) openPanel(panel, btn); else closePanels();
        } else {
          closePanels();
          goFrame(f);
        }
      });
      btn.dataset.index = i;
      strip.appendChild(btn);
      cells.set(f, { btn, canvas });
    });
    stripSignature = doc.frames.map((f) => f.id).join();
    markAllThumbs();
    updateFrameUI();
  }

  // Seconds as text: "0.25 s", or "1:05.50" past a minute.
  function fmtSec(t, short) {
    if (t < 60) return t.toFixed(2) + (short ? 's' : ' s');
    const m = Math.floor(t / 60), r = t - m * 60;
    return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
  }
  function updateFrameUI() {
    const i = frameIndex();
    const tl = buildTimeline();
    $('#fc-frame').textContent = `${i + 1} / ${doc.frames.length}`;
    $('#fc-time').textContent = `${fmtSec(tl.starts[i] || 0)} / ${fmtSec(tl.total)}`;
    $('#f-del').disabled = doc.frames.length <= 1;
    cells.forEach((cell, f) => {
      cell.btn.classList.toggle('active', f === doc.frame);
      const hold = f.hold || 1;
      const label = cell.btn.querySelector('.frame-label');
      label.innerHTML = '';
      label.append(String(doc.frames.indexOf(f) + 1));
      if (hold > 1) {
        const h = document.createElement('span');
        h.className = 'hold';
        h.textContent = ` ×${hold}`;
        label.append(h);
      }
      const fi = doc.frames.indexOf(f);
      if (state.showTimes) {
        const tspan = document.createElement('span');
        tspan.className = 'ftime';
        tspan.textContent = fmtSec(tl.starts[fi], true);
        label.append(tspan);
      }
      cell.btn.title = `Frame ${fi + 1}, starts at ${fmtSec(tl.starts[fi])}` + (hold > 1 ? ` (held for ${hold} beats)` : '');
    });
    if (!$('#panel-frame').hidden) refreshFramePanel();
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
    if (transform && frame !== transform.frame) applyTransform();
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
    if (transform) applyTransform();
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
    frame.hold = doc.frame.hold || 1;
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
    if (transform) applyTransform();
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

  // Move a frame to a new position (undoable).
  function moveFrameStep(frame, to) {
    const from = doc.frames.indexOf(frame);
    to = clamp(to, 0, doc.frames.length - 1);
    if (busy() || from < 0 || to === from) return;
    stopPlay();
    if (transform) applyTransform();
    const move = (a, b) => { doc.frames.splice(a, 1); doc.frames.splice(b, 0, frame); };
    move(from, to);
    doc.frame = frame;
    history.push({
      label: 'Move frame',
      frame,
      undo() { move(to, from); },
      redo() { move(from, to); },
    });
    framesChanged();
  }

  // How many beats a frame stays on screen (undoable).
  function setHold(frame, value) {
    const old = frame.hold || 1;
    value = clamp(value, 1, 24);
    if (value === old) return;
    frame.hold = value;
    history.push({
      label: 'Frame hold',
      frame,
      undo() { frame.hold = old; },
      redo() { frame.hold = value; },
    });
    updateFrameUI();
    if (audioClips.length) markAllThumbs();
  }

  // Frame options panel (tap the selected frame)
  function refreshFramePanel() {
    const i = frameIndex();
    const hold = doc.frame.hold || 1;
    $('#pf-title').textContent = `Frame ${i + 1}`;
    const tl = buildTimeline();
    $('#pf-time').textContent = `Starts at ${fmtSec(tl.starts[i])} and stays on screen for ${fmtSec(hold / doc.fps)}.`;
    $('#pf-hold').textContent = hold;
    $('#pf-hold-unit').textContent = hold === 1 ? 'beat' : 'beats';
    $('#pf-hold-minus').disabled = hold <= 1;
    $('#pf-hold-plus').disabled = hold >= 24;
    $('#pf-left').disabled = i <= 0;
    $('#pf-right').disabled = i >= doc.frames.length - 1;
    $('#pf-del').disabled = doc.frames.length <= 1;
  }
  $('#pf-hold-minus').addEventListener('click', () => setHold(doc.frame, (doc.frame.hold || 1) - 1));
  $('#pf-hold-plus').addEventListener('click', () => setHold(doc.frame, (doc.frame.hold || 1) + 1));
  $('#pf-left').addEventListener('click', () => { moveFrameStep(doc.frame, frameIndex() - 1); reopenFramePanel(); });
  $('#pf-right').addEventListener('click', () => { moveFrameStep(doc.frame, frameIndex() + 1); reopenFramePanel(); });
  $('#pf-dup').addEventListener('click', () => { closePanels(); $('#f-dup').click(); });
  $('#pf-del').addEventListener('click', () => { closePanels(); $('#f-del').click(); });
  // After moving, the frame's button has moved too, so reopen the panel next to it.
  function reopenFramePanel() {
    const cell = cells.get(doc.frame);
    if (cell) openPanel($('#panel-frame'), cell.btn);
  }

  // Drag frames to reorder them. Mouse/stylus: just drag.
  // Touch: touch and hold first (so a normal swipe still scrolls the strip).
  let frameDrag = null, suppressFrameClick = false;
  const dropMarker = document.createElement('div');
  dropMarker.className = 'drop-marker';
  strip.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.frame-cell');
    if (!btn || playing) return;
    suppressFrameClick = false;
    frameDrag = { btn, frame: doc.frames[+btn.dataset.index], id: e.pointerId, x: e.clientX, y: e.clientY,
      type: e.pointerType, active: false, timer: null, to: null };
    if (e.pointerType === 'touch') {
      frameDrag.timer = setTimeout(() => { if (frameDrag && !frameDrag.active) beginFrameDrag(); }, 380);
    }
  });
  function beginFrameDrag() {
    frameDrag.active = true;
    closePanels();
    frameDrag.btn.classList.add('dragging');
    try { strip.setPointerCapture(frameDrag.id); } catch (_) { /* ignore */ }
    if (navigator.vibrate) navigator.vibrate(10);
  }
  strip.addEventListener('pointermove', (e) => {
    if (!frameDrag || e.pointerId !== frameDrag.id) return;
    if (!frameDrag.active) {
      if (Math.hypot(e.clientX - frameDrag.x, e.clientY - frameDrag.y) > 8) {
        if (frameDrag.type === 'touch') { clearTimeout(frameDrag.timer); frameDrag = null; return; } // it's a scroll
        beginFrameDrag();
      } else return;
    }
    // Scroll the strip when dragging near its edges.
    const sr = strip.getBoundingClientRect();
    if (e.clientX < sr.left + 30) strip.scrollLeft -= 12;
    else if (e.clientX > sr.right - 30) strip.scrollLeft += 12;
    // Work out where the frame would land, and show a marker there.
    const btns = [...strip.querySelectorAll('.frame-cell')];
    let slot = btns.length;
    for (let i = 0; i < btns.length; i++) {
      const r = btns[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { slot = i; break; }
    }
    const from = doc.frames.indexOf(frameDrag.frame);
    frameDrag.to = slot > from ? slot - 1 : slot;
    const ref = btns[Math.min(slot, btns.length - 1)];
    const left = slot < btns.length ? ref.offsetLeft - 4 : ref.offsetLeft + ref.offsetWidth + 1;
    dropMarker.style.left = left + 'px';
    if (!dropMarker.parentNode) strip.appendChild(dropMarker);
  });
  function endFrameDrag(e, cancelled) {
    if (!frameDrag || e.pointerId !== frameDrag.id) return;
    const d = frameDrag;
    frameDrag = null;
    clearTimeout(d.timer);
    if (!d.active) return;
    suppressFrameClick = true;
    setTimeout(() => { suppressFrameClick = false; }, 0);
    d.btn.classList.remove('dragging');
    dropMarker.remove();
    if (!cancelled && d.to != null) moveFrameStep(d.frame, d.to);
  }
  strip.addEventListener('pointerup', (e) => endFrameDrag(e, false));
  strip.addEventListener('pointercancel', (e) => endFrameDrag(e, true));
  // While dragging a frame on a touch screen, don't scroll the strip.
  strip.addEventListener('touchmove', (e) => { if (frameDrag && frameDrag.active) e.preventDefault(); }, { passive: false });
  strip.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------
  let playing = false;
  let playMode = 'loop';
  // Ping-pong counts beats; Loop and Once follow a clock (the sound card's clock
  // when there is sound, so pictures and sound stay in step).
  let playDir = 1, beatsLeft = 1, lastTick = 0, elapsed = 0;
  let timeline = null, clock0 = 0, anim0 = 0, scheduledLoop = -1, useAudioClock = false;
  let sounds = [];
  let recording = null;

  // When each frame starts (in seconds) and how long the whole animation is.
  function buildTimeline() {
    const starts = [];
    let t = 0;
    for (const f of doc.frames) { starts.push(t); t += (f.hold || 1) / doc.fps; }
    return { starts, total: t };
  }
  function frameAtTime(tl, t) {
    let lo = 0, hi = tl.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tl.starts[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  const timeOfFrame = (frame) => buildTimeline().starts[doc.frames.indexOf(frame)] || 0;
  const clockNow = () => (useAudioClock ? SoundEngine.getCtx().currentTime : performance.now() / 1000);
  const audibleClips = () => audioClips.filter((c) => !c.muted);

  function startPlay(opts) {
    opts = opts || {};
    if (playing || busy()) return;
    if (transform) applyTransform();
    if (doc.frames.length < 2) { toast('Add more frames to play an animation.'); return; }
    closePanels();
    playMode = opts.record ? 'once' : state.playMode;
    // "Once" starts from the beginning if you're on the last frame.
    if (playMode === 'once' && !opts.record && frameIndex() === doc.frames.length - 1) goFrame(doc.frames[0]);
    playing = true;
    cursorEl.style.display = 'none';
    updatePlayButton();
    refreshOnion();
    if (playMode === 'pingpong') {
      if (audibleClips().length) toast('Sound plays in Loop and Once modes, not Ping-pong.', 2500);
      playDir = 1;
      beatsLeft = doc.frame.hold || 1;
      elapsed = 0;
      lastTick = performance.now();
      requestAnimationFrame(pingPongTick);
      return;
    }
    timeline = buildTimeline();
    anim0 = timeline.starts[frameIndex()];
    const ctx = audibleClips().length ? SoundEngine.getCtx() : null;
    useAudioClock = !!ctx;
    if (ctx && ctx.state === 'suspended') ctx.resume();
    clock0 = clockNow() + (useAudioClock ? 0.06 : 0); // a tiny head start so the first sound isn't clipped
    scheduledLoop = -1;
    sounds = [];
    scheduleLoop(0);
    requestAnimationFrame(clockTick);
  }
  // Start the sounds for one pass through the animation.
  function scheduleLoop(k) {
    scheduledLoop = k;
    if (!useAudioClock) return;
    const from = k === 0 ? anim0 : 0;
    const when = k === 0 ? clock0 : clock0 + k * timeline.total - anim0;
    sounds = sounds.slice(-40).concat(SoundEngine.schedule(audibleClips(), from, timeline.total, when));
  }
  function clockTick() {
    if (!playing) return;
    const T = timeline.total;
    let t = Math.max(anim0, anim0 + (clockNow() - clock0));
    if (playMode === 'loop') {
      const k = Math.floor(t / T);
      // Line up the next pass's sound a moment before it's needed.
      if (scheduledLoop === k && (k + 1) * T - t < 0.3) scheduleLoop(k + 1);
      t -= k * T;
    } else if (t >= T) {
      goFrame(doc.frames[doc.frames.length - 1]);
      stopPlay();
      return;
    }
    const f = doc.frames[frameAtTime(timeline, t)];
    if (f !== doc.frame) goFrame(f);
    requestAnimationFrame(clockTick);
  }
  function pingPongTick(t) {
    if (!playing) return;
    elapsed = Math.min(elapsed + (t - lastTick), 1000);
    lastTick = t;
    const beat = 1000 / doc.fps;
    while (playing && elapsed >= beat) {
      elapsed -= beat;
      beatsLeft--;
      if (beatsLeft <= 0) {
        const n = doc.frames.length;
        let i = frameIndex();
        if (i + playDir >= n || i + playDir < 0) playDir = -playDir;
        i += playDir;
        goFrame(doc.frames[i]);
        beatsLeft = doc.frames[i].hold || 1;
      }
    }
    if (playing) requestAnimationFrame(pingPongTick);
  }
  function stopPlay() {
    if (recording) stopRecording();
    if (!playing) return;
    playing = false;
    SoundEngine.stopAll(sounds);
    sounds = [];
    updatePlayButton();
    refreshOnion();
    refreshLayersPanel();
  }
  function togglePlay() {
    if (recording) { stopPlay(); return; }
    if (playing) stopPlay(); else startPlay();
  }
  function updatePlayButton() {
    const stop = playing || !!recording;
    $('#play-label').textContent = recording ? 'Stop rec.' : stop ? 'Stop' : 'Play';
    $('#play-icon').innerHTML = recording ? '<circle cx="12" cy="12" r="6" fill="currentColor"/>'
      : stop ? '<rect x="6" y="6" width="12" height="12" rx="1.5"/>' : '<path d="M7 4.5v15l12-7.5z"/>';
    $('#btn-play').classList.toggle('active', stop && !recording);
    $('#btn-play').classList.toggle('recording', !!recording);
  }
  $('#btn-play').addEventListener('click', togglePlay);

  $('#fps').addEventListener('change', () => { scheduleAutosave(); if (audioClips.length) markAllThumbs(); });
  $('#fps').addEventListener('input', (e) => {
    doc.fps = +e.target.value;
    $('#fps-out').textContent = doc.fps + ' fps';
    saveSettings();
    updateFrameUI(); // the times on the frames change with the speed
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
  $('#o-times').addEventListener('change', (e) => {
    state.showTimes = e.target.checked;
    saveSettings();
    updateFrameUI();
  });
  // Tap the time to jump to a moment in the animation.
  $('#frame-counter').addEventListener('click', () => {
    stopPlay();
    const tl = buildTimeline();
    const answer = prompt(`Go to which time? (in seconds, from 0 to ${tl.total.toFixed(2)})`, (tl.starts[frameIndex()] || 0).toFixed(2));
    if (answer == null) return;
    const t = parseFloat(String(answer).replace(',', '.'));
    if (!Number.isFinite(t)) { toast('Please type a number of seconds, like 1.5'); return; }
    goFrame(doc.frames[frameAtTime(tl, clamp(t, 0, Math.max(0, tl.total - 1e-6)))]);
  });
  $$('#play-modes button').forEach((b) => b.addEventListener('click', () => {
    state.playMode = b.dataset.mode;
    scheduleAutosave();
    saveSettings();
    syncUI();
  }));

  // Menu: drawing helpers
  $('#m-quickshape').addEventListener('change', (e) => { state.quickShape = e.target.checked; saveSettings(); });
  $('#m-fill').addEventListener('input', (e) => {
    state.fillGap = +e.target.value;
    $('#m-fill-out').textContent = state.fillGap + '%';
    saveSettings();
  });

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
    scheduleAutosave();
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
    if (t === state.tool) { syncUI(); return; }
    if (state.tool === 'transform' && transform) applyTransform();
    if (t === 'transform') {
      const prev = state.tool;
      if (!startTransform()) return;
      tfPrevTool = prev === 'eyedropper' || prev === 'select' ? 'brush' : prev;
    }
    if (t === 'select' && !selection) toast('Draw around the area you want to select.', 2000);
    if (t === 'eyedropper' && state.tool !== 'eyedropper') state.prevTool = state.tool;
    state.tool = t;
    syncUI();
  }
  // Tap a tool to choose it; tap it again to open its settings.
  $$('[data-tool]').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.tool;
    if (state.tool === t && t === 'transform') return;
    if (state.tool === t && t !== 'eyedropper') {
      const panel = t === 'select' ? $('#panel-select') : $('#panel-brush');
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
    if (transform) applyTransform();
    closePanels();
    panel.hidden = false;
    anchor.classList.add('open');
    if (panel.id === 'panel-layers') buildLayerList();
    if (panel.id === 'panel-brush') drawBrushPreviews();
    if (panel.id === 'panel-color') picker.markPrevious();
    if (panel.id === 'panel-frame') refreshFramePanel();
    if (panel.id === 'panel-audio') buildAudioList();
    if (panel.id === 'panel-export') { refreshExportPanel(); refreshTimelapseInfo(); }
    if (panel.id === 'panel-menu') $('#p-name').value = project.name === 'Untitled' ? '' : project.name;
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
      if (btn === colorBtn && suppressColorClick) { suppressColorClick = false; return; }
      const panel = document.getElementById(btn.dataset.panel);
      if (panel.hidden) openPanel(panel, btn); else closePanels();
    });
  });
  // Tapping anywhere outside a panel closes it.
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.panel') || e.target.closest('[data-panel]') || e.target.closest('[data-tool]') ||
        e.target.closest('.frame-cell')) return;
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
      Brushes.drawPreview(b.querySelector('canvas'), t, state.color, state.brushes[t]);
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
  onInput('b-taper', (el) => { state.brushes[state.brushType].taper = +el.value; });
  onInput('b-pmin', (el) => { state.brushes[state.brushType].pmin = +el.value; });
  onInput('b-jitter', (el) => { state.brushes[state.brushType].jitter = +el.value; });
  ['b-taper', 'b-pmin', 'b-jitter'].forEach((id) => $('#' + id).addEventListener('change', () => {
    if (!$('#panel-brush').hidden) drawBrushPreviews();
  }));
  $('#b-reset').addEventListener('click', () => {
    Object.assign(state.brushes[state.brushType], Brushes.TYPES[state.brushType].defaults);
    saveSettings();
    syncUI();
    drawBrushPreviews();
  });
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
    $('#m-quickshape').checked = state.quickShape;
    $('#m-fill').value = state.fillGap;
    $('#m-fill-out').textContent = state.fillGap + '%';
    $$('#play-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.playMode));

    const b = state.brushes[state.brushType];
    $('#b-size').value = sizeToSlider(b.size);
    $('#b-size-out').textContent = b.size;
    $('#b-opacity').value = b.opacity;
    $('#b-opacity-out').textContent = b.opacity + '%';
    $('#b-smoothing').value = b.smoothing;
    $('#b-smoothing-out').textContent = b.smoothing + '%';
    $('#b-taper').value = b.taper;
    $('#b-taper-out').textContent = b.taper + '%';
    $('#b-taper-row').hidden = !!Brushes.TYPES[state.brushType].noTaper;
    $('#b-pmin').value = b.pmin;
    $('#b-pmin-out').textContent = b.pmin + '%';
    $('#b-jitter').value = b.jitter;
    $('#b-jitter-out').textContent = b.jitter + '%';
    $$('#select-modes button').forEach((x) => x.classList.toggle('active', x.dataset.mode === state.selectMode));
    stage.classList.toggle('moving', tool === 'transform');
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
    $('#o-times').checked = state.showTimes;
    $('#tl-on').checked = state.timelapse;
    $('#o-opacity').value = state.onion.opacity;
    $('#o-opacity-out').textContent = state.onion.opacity + '%';

    $('#color-swatch').style.background = state.color;
    stage.classList.toggle('picking', tool === 'eyedropper' || tool === 'select');
  }

  // ---------------------------------------------------------------------------
  // Saving and opening projects
  // ---------------------------------------------------------------------------
  const project = { name: 'Untitled', fileHandle: null };
  let storageOK = false;    // can we save in this browser?
  let restoring = true;     // don't save until the last project has been loaded
  let saveTimer = null, saving = false, saveAgain = false, unsaved = false;
  const dirtyCels = new Set(); // drawings changed since they were last saved
  const lastSaved = new Map(); // "layerId|key" -> the drawing saved under it

  function markCelDirty(cel) { dirtyCels.add(cel); }

  // Turn a drawing into a small PNG of just the part that has something on it
  // (much faster and smaller than the whole canvas).
  // Returns { x, y, w, h, blob }, or { empty: true } for a blank drawing.
  const cropCanvas = makeCanvas(1, 1);
  async function encodeCel(cel) {
    const b = alphaBounds(cel.getContext('2d').getImageData(0, 0, DOC_W, DOC_H).data);
    if (!b) return { empty: true };
    if (window.OffscreenCanvas) {
      // Faster: encodes right away instead of waiting for the browser to be idle.
      try {
        const oc = new OffscreenCanvas(b.w, b.h);
        oc.getContext('2d').drawImage(cel, -b.x, -b.y);
        return { x: b.x, y: b.y, w: b.w, h: b.h, blob: await oc.convertToBlob({ type: 'image/png' }) };
      } catch (_) { /* fall back to the normal way below */ }
    }
    cropCanvas.width = b.w;
    cropCanvas.height = b.h;
    const c = cropCanvas.getContext('2d');
    c.clearRect(0, 0, b.w, b.h);
    c.drawImage(cel, -b.x, -b.y);
    return { x: b.x, y: b.y, w: b.w, h: b.h, blob: await ProjectStorage.canvasToBlob(cropCanvas) };
  }
  // The reverse: rebuild a full-size drawing from a saved record.
  // rec is { x, y, blob } (browser storage) or { x, y, png: dataURL } (files);
  // a plain Blob or data URL (a whole-canvas picture) also works.
  async function decodeCel(rec) {
    const c = makeCanvas(DOC_W, DOC_H);
    if (!rec || rec.empty) return c;
    let src = rec, x = 0, y = 0, whole = true;
    if (!(rec instanceof Blob) && typeof rec === 'object') {
      src = rec.blob || rec.png;
      x = +rec.x || 0;
      y = +rec.y || 0;
      whole = false;
    }
    if (typeof src === 'string' && !/^data:image\/(png|jpeg|webp);base64,/.test(src)) return null;
    if (!(src instanceof Blob) && typeof src !== 'string') return null;
    const img = await ProjectStorage.toImage(src);
    const ctx = c.getContext('2d');
    if (whole) ctx.drawImage(img, 0, 0, DOC_W, DOC_H);
    else ctx.drawImage(img, x, y);
    if (img.close) img.close();
    return c;
  }

  function updateTitle() {
    $('#title-name').textContent = project.name;
    document.title = `${project.name} – Playground`;
  }
  function setSaveStatus(kind) {
    const el = $('#save-status');
    const text = {
      saved: 'Saved',
      saving: 'Saving…',
      off: 'Not saved',
      error: 'Couldn\'t save',
    }[kind];
    el.textContent = text;
    el.classList.toggle('warn', kind === 'off' || kind === 'error');
    $('#p-status').textContent = {
      saved: 'Your work is saved in this browser automatically.',
      saving: 'Saving in this browser…',
      off: 'This browser won\'t let the app save automatically here (for example in a private window). Use "Save to file" to keep your work.',
      error: 'Saving in this browser failed (it may be full). Use "Save to file" to keep your work.',
    }[kind];
  }

  // Everything about the project except the pictures themselves.
  function snapshotMeta() {
    const frameIds = new Set(doc.frames.map((f) => f.id));
    return {
      app: 'animation-playground',
      version: 1,
      name: project.name,
      width: DOC_W,
      height: DOC_H,
      fps: doc.fps,
      playMode: state.playMode,
      frames: doc.frames.map((f) => ({ id: f.id, hold: f.hold || 1 })),
      layers: doc.layers.map((l) => ({
        id: l.id, name: l.name, static: l.static, visible: l.visible, locked: l.locked,
        opacity: l.opacity, blend: l.blend,
        cels: [...l.cels.keys()].filter((k) => k === 'static' || frameIds.has(k)),
      })),
      audio: audioClips.map((c) => ({
        id: c.id, name: c.name, offset: c.offset, skip: c.skip, volume: c.volume, muted: c.muted, type: c.blob.type,
      })),
      activeLayer: doc.active.id,
      currentFrame: doc.frame.id,
      layerCounter,
      savedAt: new Date().toISOString(),
    };
  }

  function scheduleAutosave() {
    if (restoring) return;
    unsaved = true;
    if (!storageOK) return;
    setSaveStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(autosave, 600);
  }

  // Save the project in this browser. Only drawings that changed are re-saved.
  async function autosave() {
    saveTimer = null;
    if (!storageOK || restoring) return;
    if (saving) { saveAgain = true; return; }
    if (busy() || transform) { scheduleAutosave(); return; } // wait until you finish
    saving = true;
    try {
      const meta = snapshotMeta();
      const keep = new Set();
      const puts = [];
      for (const L of meta.layers) {
        const layer = doc.layers.find((x) => x.id === L.id);
        for (const key of L.cels) {
          const rk = `${L.id}|${key}`;
          const cel = layer.cels.get(key);
          keep.add(rk);
          if (lastSaved.get(rk) !== cel || dirtyCels.has(cel)) {
            dirtyCels.delete(cel); // if it changes again while saving, it'll be marked again
            puts.push([rk, cel, await encodeCel(cel)]);
          }
        }
      }
      for (const clip of audioClips) {
        const rk = `audio|${clip.id}`;
        keep.add(rk);
        if (lastSaved.get(rk) !== clip) puts.push([rk, clip, { audio: true, blob: clip.blob }]);
      }
      await ProjectStorage.saveProject(meta, puts.map(([rk, , blob]) => [rk, blob]), keep);
      for (const [rk, cel] of puts) lastSaved.set(rk, cel);
      for (const rk of [...lastSaved.keys()]) if (!keep.has(rk)) lastSaved.delete(rk);
      if (!saveTimer && !saveAgain) { unsaved = false; setSaveStatus('saved'); }
    } catch (err) {
      console.warn('Autosave failed', err);
      setSaveStatus('error');
    } finally {
      saving = false;
      if (saveAgain) { saveAgain = false; autosave(); }
    }
  }

  // Save right away when you switch away from the app (so nothing is lost).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer) { clearTimeout(saveTimer); autosave(); }
  });
  window.addEventListener('beforeunload', (e) => {
    if (unsaved && storageOK) { e.preventDefault(); e.returnValue = ''; }
  });

  /**
   * Replace the current project with a saved one.
   * meta: the project description; fetchCel(layerId, key) -> picture (or null).
   */
  async function loadProject(meta, fetchCel, fetchAudio) {
    if (!meta || !Array.isArray(meta.frames) || !Array.isArray(meta.layers) ||
        !meta.frames.length || !meta.layers.length) {
      throw new Error('This file doesn\'t look like a Playground project.');
    }
    // Build everything first, so a broken file can't leave a half-loaded project.
    const usedF = new Set(), usedL = new Set();
    const num = (id) => parseInt(String(id).replace(/\D/g, ''), 10) || 0;
    let maxF = 0, maxL = 0;
    const frames = meta.frames.slice(0, MAX_FRAMES).map((f) => {
      let id = String(f.id || '');
      if (!/^f\d+$/.test(id) || usedF.has(id)) id = 'f' + (100000 + usedF.size);
      usedF.add(id);
      maxF = Math.max(maxF, num(id));
      return { id, hold: clamp(Math.round(+f.hold) || 1, 1, 24), oldId: String(f.id) };
    });
    const idMap = new Map(frames.map((f) => [f.oldId, f.id]));
    const blends = BLEND_MODES.map((m) => m[0]);
    const layers = [];
    for (const L of meta.layers.slice(0, MAX_LAYERS)) {
      let id = String(L.id || '');
      if (!/^l\d+$/.test(id) || usedL.has(id)) id = 'l' + (100000 + usedL.size);
      usedL.add(id);
      maxL = Math.max(maxL, num(id));
      const layer = {
        id,
        name: String(L.name || 'Layer').slice(0, 40),
        cels: new Map(),
        static: !!L.static,
        visible: L.visible !== false,
        locked: !!L.locked,
        opacity: Number.isFinite(+L.opacity) ? clamp(+L.opacity, 0, 1) : 1,
        blend: blends.includes(L.blend) ? L.blend : 'source-over',
      };
      const keys = Array.isArray(L.cels) ? L.cels : Object.keys(L.cels || {});
      for (const key of keys) {
        const newKey = key === 'static' ? 'static' : idMap.get(String(key));
        if (!newKey) continue;
        const c = await fetchCel(String(L.id), String(key), L);
        if (c) layer.cels.set(newKey, c);
      }
      layers.push(layer);
    }
    frames.forEach((f) => { delete f.oldId; });
    const clips = [];
    let maxA = 0;
    for (const A of (Array.isArray(meta.audio) ? meta.audio : []).slice(0, MAX_CLIPS)) {
      try {
        const blob = fetchAudio ? await fetchAudio(A) : null;
        if (!blob) continue;
        const id = /^a\d+$/.test(String(A.id)) && !clips.some((c) => c.id === String(A.id)) ? String(A.id) : null;
        const clip = await makeClip(blob, String(A.name || 'Sound').slice(0, 60), +A.offset || 0, id);
        clip.skip = clamp(+A.skip || 0, 0, Math.max(0, clip.buffer.duration - 0.1));
        clip.volume = Number.isFinite(+A.volume) ? clamp(+A.volume, 0, 1.5) : 1;
        clip.muted = !!A.muted;
        clips.push(clip);
        maxA = Math.max(maxA, num(clip.id));
      } catch (err) {
        console.warn('A sound could not be loaded', err);
      }
    }

    // Swap it in.
    if (transform) cancelTransform();
    setSelection(null);
    stopPlay();
    closePanels();
    doc.layers = layers;
    doc.frames = frames;
    audioClips.length = 0;
    audioClips.push(...clips);
    clipIds = Math.max(maxA, clips.length);
    doc.active = layers.find((l) => l.id === String(meta.activeLayer)) || layers[layers.length - 1];
    doc.frame = frames.find((f) => f.id === idMap.get(String(meta.currentFrame))) || frames[0];
    doc.fps = clamp(Math.round(+meta.fps) || 12, 1, 30);
    if (['loop', 'pingpong', 'once'].includes(meta.playMode)) state.playMode = meta.playMode;
    layerIds = maxL;
    frameIds = maxF;
    layerCounter = Math.max(+meta.layerCounter || 0, layers.length);
    project.name = String(meta.name || 'Untitled').slice(0, 60) || 'Untitled';
    project.fileHandle = null;
    history.undoStack.length = 0;
    history.redoStack.length = 0;
    dirtyCels.clear();
    lastSaved.clear();
    updateTitle();
    buildStrip();
    goFrame(doc.frame);
    layersChanged();
    history.onChange();
    audioChanged();
    syncUI();
    fitView();
  }

  // On start: bring back the project from last time.
  async function restoreProject() {
    try {
      await ProjectStorage.openDB();
      storageOK = true;
    } catch (err) {
      restoring = false;
      setSaveStatus('off');
      return;
    }
    try {
      const meta = await ProjectStorage.get('meta', 'current');
      if (meta && meta.layers) {
        await loadProject(meta, async (layerId, key) => {
          const rec = await ProjectStorage.get('cels', `${layerId}|${key}`);
          return rec ? decodeCel(rec) : null;
        }, async (A) => {
          const rec = await ProjectStorage.get('cels', `audio|${A.id}`);
          return rec && rec.blob;
        });
        // What's on screen now matches what's saved.
        for (const layer of doc.layers) layer.cels.forEach((cel, key) => lastSaved.set(`${layer.id}|${key}`, cel));
        for (const clip of audioClips) lastSaved.set(`audio|${clip.id}`, clip);
        toast('Welcome back! Your last project is open.', 2200);
      }
    } catch (err) {
      console.warn('Restore failed', err);
      toast('Your last project couldn\'t be opened. Starting fresh.');
    }
    restoring = false;
    unsaved = false;
    setSaveStatus('saved');
    try { tlCount = (await ProjectStorage.tlKeys()).length; } catch (_) { tlCount = 0; }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  const safeFileName = (name) => (name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Untitled');

  // Save the whole project as one .anim file.
  async function saveToFile() {
    if (busy()) return;
    if (transform) applyTransform();
    closePanels();
    stopPlay();
    toast('Preparing your file…', 1500);
    let blob;
    try {
      const meta = snapshotMeta();
      for (const L of meta.layers) {
        const layer = doc.layers.find((x) => x.id === L.id);
        const pics = {};
        for (const key of L.cels) {
          const rec = await encodeCel(layer.cels.get(key));
          if (rec.empty) continue; // nothing drawn there
          pics[key] = { x: rec.x, y: rec.y, png: await ProjectStorage.blobToDataURL(rec.blob) };
        }
        L.cels = pics;
      }
      for (const A of meta.audio) {
        const clip = audioClips.find((c) => c.id === A.id);
        A.data = await ProjectStorage.blobToDataURL(clip.blob);
      }
      blob = new Blob([JSON.stringify(meta)], { type: 'application/json' });
    } catch (err) {
      console.warn(err);
      toast('Sorry, the file couldn\'t be prepared.');
      return;
    }
    const fileName = safeFileName(project.name) + '.anim';
    try {
      project.fileHandle = await ProjectStorage.writeFile(blob, fileName, project.fileHandle);
      toast(project.fileHandle ? `Saved to "${project.fileHandle.name}".` : `Saved "${fileName}" to your Downloads folder.`);
    } catch (err) {
      if (err && err.name === 'AbortError') return; // you cancelled
      // The "Save as" window didn't work: use a normal download instead.
      project.fileHandle = null;
      ProjectStorage.download(blob, fileName);
      toast(`Saved "${fileName}" to your Downloads folder.`);
    }
  }

  // Open a .anim file.
  const fileInput = $('#p-file');
  function openFile() {
    if (busy()) return;
    const ok = confirm('Open a project file?\n\nIt will replace the project on screen. To keep this one, press Cancel and use "Save to file" first.');
    if (!ok) return;
    closePanels();
    fileInput.value = '';
    fileInput.click();
  }
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    toast('Opening…', 1500);
    try {
      const meta = JSON.parse(await file.text());
      if (!meta || meta.app !== 'animation-playground') throw new Error('not ours');
      await loadProject(meta, async (layerId, key, L) => {
        const rec = L.cels && L.cels[key];
        return rec ? decodeCel(rec) : null;
      }, async (A) => {
        if (typeof A.data !== 'string' || !/^data:(audio|video)\//.test(A.data)) return null;
        return (await fetch(A.data)).blob();
      });
      if (!meta.name) project.name = file.name.replace(/\.(anim|json)$/i, '') || 'Untitled';
      updateTitle();
      tlReset();
      autosaveNow();
      toast(`Opened "${project.name}".`);
    } catch (err) {
      console.warn(err);
      toast('That file couldn\'t be opened. Is it a Playground project (.anim)?');
    }
  });
  function autosaveNow() {
    scheduleAutosave();
    clearTimeout(saveTimer);
    autosave();
  }

  function newProject() {
    if (busy()) return;
    const ok = confirm('Start a new, empty project?\n\nThe project on screen will be replaced. To keep it, press Cancel and use "Save to file" first.');
    if (!ok) return;
    loadProject({
      name: 'Untitled', fps: doc.fps, playMode: state.playMode, layerCounter: 1,
      frames: [{ id: 'f1', hold: 1 }], layers: [{ id: 'l1', name: 'Layer 1', cels: [] }],
    }, async () => null).then(() => { tlReset(); autosaveNow(); toast('New project started.'); });
  }

  $('#p-save').addEventListener('click', saveToFile);
  $('#p-open').addEventListener('click', openFile);
  $('#p-new').addEventListener('click', newProject);
  $('#p-name').addEventListener('input', (e) => {
    project.name = e.target.value.trim() || 'Untitled';
    updateTitle();
    scheduleAutosave();
  });

  // ---------------------------------------------------------------------------
  // Sound: music and voice clips that play with the animation
  // ---------------------------------------------------------------------------
  const MAX_CLIPS = 8;
  const audioClips = [];
  let clipIds = 0, voiceCount = 0;
  const audioPanel = $('#panel-audio');
  const audioInput = $('#a-file');

  // clip = { id, name, blob (the file), buffer (decoded), peaks, offset, skip, volume, muted }
  async function makeClip(blob, name, offset, id) {
    const buffer = await SoundEngine.decode(blob);
    return {
      id: id || 'a' + (++clipIds), name, blob, buffer,
      peaks: SoundEngine.peaks(buffer),
      offset: Math.max(0, offset || 0), skip: 0, volume: 1, muted: false,
    };
  }
  function audioChanged(rebuild) {
    markAllThumbs();
    scheduleAutosave();
    $('#audio-label').textContent = audioClips.length ? `Sound (${audioClips.length})` : 'Sound';
    if (rebuild !== false && !audioPanel.hidden) buildAudioList();
  }
  async function addClip(blob, name, offset, label) {
    if (audioClips.length >= MAX_CLIPS) { toast(`You can have up to ${MAX_CLIPS} sounds.`); return null; }
    let clip;
    try {
      clip = await makeClip(blob, name, offset);
    } catch (err) {
      console.warn(err);
      toast('That sound couldn\'t be opened. Try an MP3, WAV or M4A file.');
      return null;
    }
    audioClips.push(clip);
    history.push({
      label: label || 'Add sound',
      undo() { audioClips.splice(audioClips.indexOf(clip), 1); },
      redo() { audioClips.push(clip); },
    });
    audioChanged();
    return clip;
  }
  function removeClip(clip) {
    const i = audioClips.indexOf(clip);
    if (i < 0) return;
    stopPlay();
    audioClips.splice(i, 1);
    history.push({
      label: 'Delete sound',
      undo() { audioClips.splice(i, 0, clip); },
      redo() { audioClips.splice(audioClips.indexOf(clip), 1); },
    });
    audioChanged();
    toast(`Deleted "${clip.name}". Press Undo to bring it back.`);
  }

  $('#a-add').addEventListener('click', () => {
    if (audioClips.length >= MAX_CLIPS) { toast(`You can have up to ${MAX_CLIPS} sounds.`); return; }
    audioInput.value = '';
    audioInput.click();
  });
  audioInput.addEventListener('change', async () => {
    const file = audioInput.files && audioInput.files[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { toast('That file is too big (over 100 MB). Try a shorter or compressed (MP3) version.'); return; }
    toast('Adding sound…', 1500);
    const clip = await addClip(file, file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'Sound', 0);
    if (clip) toast(`Added "${clip.name}". Press Play to hear it with your animation.`);
  });

  // Recording your voice: the animation plays from the current frame while you speak.
  async function startRecording() {
    if (recording || playing || busy()) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('This browser can\'t record sound here. Try Chrome or Edge, or add a sound file instead.');
      return;
    }
    if (audioClips.length >= MAX_CLIPS) { toast(`You can have up to ${MAX_CLIPS} sounds.`); return; }
    closePanels();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      toast('The microphone couldn\'t be used. Check that the browser is allowed to use it.');
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks = [];
    const startAt = timeOfFrame(doc.frame);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recording = null;
      updatePlayButton();
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (blob.size < 500) { toast('Nothing was recorded.'); return; }
      const clip = await addClip(blob, `Voice ${++voiceCount}`, startAt, 'Record voice');
      if (clip) toast(`"${clip.name}" added. Press Play to hear it with your animation.`);
    };
    recording = { rec };
    rec.start();
    updatePlayButton();
    toast('Recording… speak now. Press Stop when you\'re done.', 3000);
    if (doc.frames.length >= 2) startPlay({ record: true });
  }
  function stopRecording() {
    if (recording && recording.rec.state !== 'inactive') recording.rec.stop();
  }
  $('#a-rec').addEventListener('click', startRecording);

  const fmtTime = (sec) => {
    const m = Math.floor(sec / 60), s2 = sec - m * 60;
    return `${m}:${s2 < 10 ? '0' : ''}${s2.toFixed(1)}`;
  };
  const SPEAKER = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
  const SPEAKER_OFF = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/></svg>';
  const TRASH = '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';

  function drawClipWave(cv, clip) {
    const w = cv.clientWidth || 280, h = cv.clientHeight || 36;
    cv.width = Math.round(w * DPR);
    cv.height = Math.round(h * DPR);
    const g = cv.getContext('2d');
    g.scale(DPR, DPR);
    const n = clip.peaks.length, dur = clip.buffer.duration;
    const skipX = (clip.skip / dur) * w;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * n), b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
      let m = 0;
      for (let i = a; i < b; i++) if (clip.peaks[i] > m) m = clip.peaks[i];
      const bar = Math.max(1, m * (h - 4));
      g.fillStyle = x < skipX ? 'rgba(120,120,120,0.45)' : '#4f6df5';
      g.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }

  function buildAudioList() {
    const list = $('#audio-list');
    list.innerHTML = '';
    if (!audioClips.length) {
      list.innerHTML = '<p class="audio-empty">No sound yet. Add music or record your voice.</p>';
      return;
    }
    for (const clip of audioClips) {
      const box = document.createElement('div');
      box.className = 'clip' + (clip.muted ? ' muted-clip' : '');
      box.innerHTML = `
        <div class="clip-head">
          <span class="clip-name"></span>
          <span class="clip-len">${fmtTime(clip.buffer.duration)}</span>
          <button class="icon-toggle" data-act="mute" title="${clip.muted ? 'Unmute' : 'Mute'}">${clip.muted ? SPEAKER_OFF : SPEAKER}</button>
          <button class="icon-toggle" data-act="delete" title="Delete this sound">${TRASH}</button>
        </div>
        <canvas class="clip-wave"></canvas>
        <div class="clip-row"><span>Starts at</span>
          <input type="number" data-k="offset" min="0" step="0.1" value="${clip.offset.toFixed(2)}"> s
          <button class="mini" data-act="here" title="Start this sound on the frame you're on">This frame</button></div>
        <div class="clip-row"><span>Skip first</span>
          <input type="number" data-k="skip" min="0" step="0.1" value="${clip.skip.toFixed(2)}"> s</div>
        <div class="clip-row"><span>Volume</span>
          <input type="range" data-k="volume" min="0" max="150" value="${Math.round(clip.volume * 100)}">
          <output>${Math.round(clip.volume * 100)}%</output></div>`;
      box.querySelector('.clip-name').textContent = clip.name;
      box.querySelector('.clip-name').title = clip.name;
      list.appendChild(box);
      drawClipWave(box.querySelector('.clip-wave'), clip);
      box.querySelector('[data-act=mute]').addEventListener('click', () => { clip.muted = !clip.muted; audioChanged(); });
      box.querySelector('[data-act=delete]').addEventListener('click', () => removeClip(clip));
      box.querySelector('[data-act=here]').addEventListener('click', () => {
        clip.offset = Math.round(timeOfFrame(doc.frame) * 100) / 100;
        audioChanged();
      });
      box.querySelectorAll('input[type=number]').forEach((inp) => inp.addEventListener('change', () => {
        const k = inp.dataset.k;
        const max = k === 'skip' ? Math.max(0, clip.buffer.duration - 0.1) : 3600;
        clip[k] = clamp(+inp.value || 0, 0, max);
        inp.value = clip[k].toFixed(2);
        drawClipWave(box.querySelector('.clip-wave'), clip);
        audioChanged(false);
      }));
      const vol = box.querySelector('input[type=range]');
      vol.addEventListener('input', () => {
        clip.volume = +vol.value / 100;
        box.querySelector('output').textContent = vol.value + '%';
      });
      vol.addEventListener('change', () => audioChanged(false));
    }
  }

  // A tiny waveform along the bottom of a frame thumbnail, for lining up sound with pictures.
  function drawThumbWave(g, frame, tl, W, H) {
    const clips = audibleClips();
    if (!clips.length) return;
    const i = doc.frames.indexOf(frame);
    const t0 = tl.starts[i], t1 = t0 + (frame.hold || 1) / doc.fps;
    const band = Math.round(H * 0.26);
    g.fillStyle = 'rgba(20,24,40,0.55)';
    g.fillRect(0, H - band, W, band);
    const bars = 14;
    g.fillStyle = '#9fb2ff';
    for (let b = 0; b < bars; b++) {
      const ta = t0 + ((t1 - t0) * b) / bars, tb = t0 + ((t1 - t0) * (b + 1)) / bars;
      let m = 0;
      for (const c of clips) {
        const a = Math.floor((ta - c.offset + c.skip) * 100), z = Math.ceil((tb - c.offset + c.skip) * 100);
        for (let k = Math.max(a, Math.floor(c.skip * 100)); k < Math.min(z, c.peaks.length); k++) {
          if (c.peaks[k] * c.volume > m) m = c.peaks[k] * c.volume;
        }
      }
      const h = Math.max(1, Math.min(1, m * 1.3) * (band - 2));
      g.fillRect((b * W) / bars + 0.5, H - band / 2 - h / 2, Math.max(1, W / bars - 1), h);
    }
  }

  // ---------------------------------------------------------------------------
  // Inserting pictures (PNG, JPG, ...)
  // ---------------------------------------------------------------------------
  const imageInput = $('#i-file');
  let insertMode = 'frame';

  const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name);
  // A friendly layer name from the file name, e.g. "cat.png" -> "cat".
  const nameFromFile = (f) => (f.name || 'Picture').replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || 'Picture';

  // Draw a picture onto a new full-size canvas: big pictures are shrunk to fit,
  // small ones keep their size. Either way it's centered.
  function pictureCanvas(img) {
    const c = makeCanvas(DOC_W, DOC_H);
    const g = c.getContext('2d');
    const w = img.width, h = img.height;
    const s = Math.min(1, DOC_W / w, DOC_H / h);
    const dw = Math.round(w * s), dh = Math.round(h * s);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, Math.round((DOC_W - dw) / 2), Math.round((DOC_H - dh) / 2), dw, dh);
    if (img.close) img.close();
    return c;
  }

  function chooseImages(mode) {
    if (busy()) return;
    insertMode = mode;
    imageInput.multiple = mode === 'sequence';
    imageInput.value = '';
    closePanels();
    imageInput.click();
  }
  $('#i-frame').addEventListener('click', () => chooseImages('frame'));
  $('#i-bg').addEventListener('click', () => chooseImages('background'));
  $('#i-seq').addEventListener('click', () => chooseImages('sequence'));
  imageInput.addEventListener('change', () => insertImages([...(imageInput.files || [])], insertMode));

  async function insertImages(files, mode) {
    files = files.filter(isImageFile);
    if (!files.length) { toast('Please choose a picture (PNG or JPG).'); return; }
    if (busy()) return;
    if (doc.layers.length >= MAX_LAYERS) { toast(`You can have up to ${MAX_LAYERS} layers. Delete or merge one first.`); return; }
    if (transform) applyTransform();
    stopPlay();
    setSelection(null); // so Transform moves the whole picture
    if (mode === 'sequence' && files.length > 1) { await insertSequence(files); return; }

    let img;
    try {
      img = await ProjectStorage.toImage(files[0]);
    } catch (err) {
      toast('That picture couldn\'t be opened. Try a PNG or JPG.');
      return;
    }
    const layer = newLayer(nameFromFile(files[0]));
    layerCounter--; // a picture layer doesn't use up a "Layer N" number
    const background = mode === 'background';
    layer.static = background;
    layer.cels.set(celKey(layer, doc.frame), pictureCanvas(img));
    // Backgrounds go to the bottom of the stack; other pictures go above the current layer.
    addLayerStep(background ? 'Insert background' : 'Insert picture', layer, background ? 0 : layerIndex(doc.active) + 1);
    // Straight into Transform so you can place it.
    if (state.tool === 'transform') startTransform(); else setTool('transform');
    toast(background
      ? 'Picture added behind everything, on every frame. Drag to move it, drag a corner to resize, then tap Done.'
      : 'Picture added. Drag to move it, drag a corner to resize, then tap Done.', 4500);
  }

  // Several pictures -> one new layer, one picture per frame (starting at the current frame).
  async function insertSequence(files) {
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const room = MAX_FRAMES - doc.frames.length + 1;
    if (files.length > room) {
      files = files.slice(0, room);
      toast(`Only the first ${room} pictures fit (the limit is ${MAX_FRAMES} frames).`);
    }
    toast(`Adding ${files.length} pictures…`, 2000);
    const layer = newLayer('Picture frames');
    layerCounter--;
    const prevActive = doc.active, prevFrame = doc.frame;
    const start = frameIndex();
    const added = [];
    let skipped = 0;
    for (let i = 0; i < files.length; i++) {
      let img;
      try { img = await ProjectStorage.toImage(files[i]); } catch (_) { skipped++; continue; }
      const frame = added.length === 0 && !layer.cels.size ? doc.frame : newFrame();
      if (frame !== doc.frame) added.push(frame);
      layer.cels.set(frame.id, pictureCanvas(img));
    }
    if (!layer.cels.size) { toast('Those pictures couldn\'t be opened. Try PNG or JPG files.'); return; }
    const index = layerIndex(prevActive) + 1;
    const apply = () => {
      putLayer(layer, index);
      doc.frames.splice(start + 1, 0, ...added);
      doc.active = layer;
      doc.frame = prevFrame;
    };
    const unapply = () => {
      takeLayer(layer);
      for (const f of added) doc.frames.splice(doc.frames.indexOf(f), 1);
      doc.active = prevActive;
      doc.frame = prevFrame;
    };
    apply();
    history.push({ label: 'Pictures as frames', undo: unapply, redo: apply });
    framesChanged();
    toast(`Added ${layer.cels.size} pictures as frames on a new layer` + (skipped ? ` (${skipped} couldn't be opened).` : '.') +
      ' Press Play to watch.', 4000);
  }

  // Paste a picture (Ctrl+V / Cmd+V).
  document.addEventListener('paste', (e) => {
    if (e.target.matches && e.target.matches('input[type=text]')) return;
    const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter(isImageFile);
    if (!files.length) return;
    e.preventDefault();
    insertImages(files.slice(0, 1), 'frame');
  });

  // Drag pictures from your computer onto the canvas.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  stage.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    stage.classList.add('drop-target');
  });
  stage.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  stage.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) stage.classList.remove('drop-target');
  });
  stage.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    stage.classList.remove('drop-target');
    const files = [...e.dataTransfer.files].filter(isImageFile);
    // A project file dropped on the canvas opens it.
    const proj = [...e.dataTransfer.files].find((f) => /\.anim$/i.test(f.name));
    if (proj && !files.length) { toast('To open a project, use "Open file" in the menu.'); return; }
    insertImages(files, files.length > 1 ? 'sequence' : 'frame');
  });
  // Dropping a file anywhere else shouldn't make the browser leave the app.
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

  // ---------------------------------------------------------------------------
  // Exporting: a video file (with sound), or one frame as a picture
  // ---------------------------------------------------------------------------
  const EXPORT_SIZES = { 360: [640, 360], 720: [1280, 720], 1080: [1920, 1080] };
  let exporting = null;

  // The best video format this browser can record. MP4 plays almost everywhere;
  // WebM is the fallback (Firefox, older Chrome).
  function pickVideoType(withSound) {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
    const ok = (t) => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } };
    // 1. MP4 with standard H.264 video (plays on phones, Macs, PCs and social sites).
    const mp4 = withSound
      ? ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus']
      : ['video/mp4;codecs=avc1.42E01F', 'video/mp4;codecs=avc1'];
    // 2. WebM (Firefox, and browsers without H.264).
    const webm = withSound
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    // 3. A plain "MP4" request only when WebM isn't available (Safari), where it means H.264.
    const plain = ok('video/webm') ? [] : ['video/mp4'];
    return mp4.concat(webm, plain).find(ok) || null;
  }
  const fmtDuration = (sec) => {
    const m = Math.floor(sec / 60), r = Math.round(sec - m * 60);
    return m ? `${m} min ${r} s` : `${(Math.round(sec * 10) / 10).toFixed(1)} s`;
  };

  function refreshExportPanel() {
    $$('#ex-size button').forEach((b) => b.classList.toggle('active', b.dataset.v === state.exportSize));
    $$('#ex-loops button').forEach((b) => b.classList.toggle('active', +b.dataset.v === state.exportLoops));
    const hasSound = audibleClips().length > 0;
    $('#ex-sound').checked = state.exportSound && hasSound;
    $('#ex-sound').disabled = !hasSound;
    $('#ex-sound').parentElement.style.opacity = hasSound ? '' : '0.5';
    const withSound = state.exportSound && hasSound;
    const type = pickVideoType(withSound);
    const [W, H] = EXPORT_SIZES[state.exportSize];
    const total = buildTimeline().total * state.exportLoops;
    if (!type) {
      $('#ex-info').textContent = 'This browser can\'t make videos. Try a recent Chrome, Edge or Safari.';
      $('#ex-start').disabled = true;
      return;
    }
    $('#ex-start').disabled = false;
    $('#ex-info').textContent = `${type.includes('mp4') ? 'MP4' : 'WebM'} video · ${W}×${H} · ${fmtDuration(total)}` +
      (withSound ? ' · with sound' : hasSound ? ' · no sound' : '') +
      `. Making it takes about ${fmtDuration(total)}.`;
  }
  $$('#ex-size button').forEach((b) => b.addEventListener('click', () => { state.exportSize = b.dataset.v; saveSettings(); refreshExportPanel(); }));
  $$('#ex-loops button').forEach((b) => b.addEventListener('click', () => { state.exportLoops = +b.dataset.v; saveSettings(); refreshExportPanel(); }));
  $('#ex-sound').addEventListener('change', (e) => { state.exportSound = e.target.checked; saveSettings(); refreshExportPanel(); });

  // Make the video by playing the animation (and its sound) into a recorder.
  async function startExport() {
    if (busy() || exporting) return;
    if (transform) applyTransform();
    stopPlay();
    closePanels();
    const [W, H] = EXPORT_SIZES[state.exportSize];
    const loops = state.exportLoops;
    const withSound = state.exportSound && audibleClips().length > 0;
    const type = pickVideoType(withSound);
    if (!type) { toast('This browser can\'t make videos. Try a recent Chrome, Edge or Safari.'); return; }

    const tl = buildTimeline();
    const T = tl.total, total = T * loops;
    const ec = makeCanvas(W, H);
    const ectx = ec.getContext('2d');
    drawFrame(ectx, doc.frames[0], { w: W, h: H });
    // The canvas being recorded doubles as the preview.
    const preview = $('#ex-preview');
    preview.innerHTML = '';
    preview.appendChild(ec);

    const videoStream = ec.captureStream();
    const tracks = [...videoStream.getVideoTracks()];
    let actx = null, dest = null;
    if (withSound) {
      actx = SoundEngine.getCtx();
      if (actx.state === 'suspended') await actx.resume();
      dest = actx.createMediaStreamDestination();
      tracks.push(...dest.stream.getAudioTracks());
    }
    let rec;
    try {
      rec = new MediaRecorder(new MediaStream(tracks), {
        mimeType: type,
        videoBitsPerSecond: W >= 1920 ? 10e6 : W >= 1280 ? 6e6 : 2.5e6,
        audioBitsPerSecond: 160000,
      });
    } catch (err) {
      console.warn(err);
      videoStream.getTracks().forEach((t) => t.stop());
      toast('The video couldn\'t be started in this browser. Try a different size or browser.');
      return;
    }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const finished = new Promise((resolve) => { rec.onstop = resolve; });
    const job = exporting = { rec, cancelled: false, nodes: [] };
    $('#export-overlay').hidden = false;
    $('#ex-bar').style.width = '0%';

    const now = () => (withSound ? actx.currentTime : performance.now() / 1000);
    rec.start(250);
    const t0 = now() + 0.08; // a short moment for the recorder to get going
    if (withSound) {
      for (let k = 0; k < loops; k++) job.nodes.push(...SoundEngine.schedule(audibleClips(), 0, T, t0 + k * T, dest));
    }
    let lastDraw = 0;
    const tick = () => {
      if (job.cancelled || rec.state === 'inactive') return;
      const t = now() - t0;
      // Redraw often (even when the picture doesn't change) so the video has a steady frame rate.
      const wall = performance.now();
      if (wall - lastDraw > 30) {
        lastDraw = wall;
        const tt = Math.max(0, Math.min(t, total - 1e-6));
        drawFrame(ectx, doc.frames[frameAtTime(tl, tt % T)], { w: W, h: H });
      }
      const shown = Math.max(0, Math.min(t, total));
      $('#ex-bar').style.width = (shown / total) * 100 + '%';
      $('#ex-status').textContent = `${fmtDuration(shown)} of ${fmtDuration(total)}`;
      if (t >= total + 0.1) { rec.stop(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    await finished;
    videoStream.getTracks().forEach((t) => t.stop());
    SoundEngine.stopAll(job.nodes);
    $('#export-overlay').hidden = true;
    preview.innerHTML = '';
    exporting = null;
    if (job.cancelled) { toast('Export cancelled.'); return; }
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    if (!blob.size) { toast('Sorry, the video came out empty. Please try again.'); return; }
    const fileName = `${safeFileName(project.name)}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    ProjectStorage.download(blob, fileName);
    toast(`Video saved: "${fileName}" (${(blob.size / 1048576).toFixed(1)} MB) in your Downloads folder.`, 5000);
  }
  function cancelExport() {
    if (!exporting) return;
    exporting.cancelled = true;
    if (exporting.rec.state !== 'inactive') exporting.rec.stop();
  }
  $('#ex-start').addEventListener('click', startExport);
  $('#ex-cancel').addEventListener('click', cancelExport);

  // One frame as a PNG picture, at the chosen size.
  $('#ex-png').addEventListener('click', async () => {
    if (transform) applyTransform();
    closePanels();
    const [W, H] = EXPORT_SIZES[state.exportSize];
    const c = makeCanvas(W, H);
    drawFrame(c.getContext('2d'), doc.frame, { w: W, h: H });
    try {
      const blob = await ProjectStorage.canvasToBlob(c);
      const fileName = `${safeFileName(project.name)} - frame ${frameIndex() + 1}.png`;
      ProjectStorage.download(blob, fileName);
      toast(`Picture saved: "${fileName}" in your Downloads folder.`);
    } catch (err) {
      toast('Sorry, the picture couldn\'t be saved.');
    }
  });

  // ---------------------------------------------------------------------------
  // Time-lapse: a small snapshot after every change, to replay how it was made
  // ---------------------------------------------------------------------------
  const TL_W = 960, TL_H = 540, TL_MAX = 2000;
  let tlCount = 0, tlTimer = null, tlBusy = false, tlView = null;
  const tlMemory = []; // used if this browser can't store things
  const tlCanvas = makeCanvas(TL_W, TL_H);

  function tlSchedule() {
    if (!state.timelapse || restoring) return;
    clearTimeout(tlTimer);
    tlTimer = setTimeout(tlCapture, 350);
  }
  async function snapshotBlob() {
    drawFrame(tlCanvas.getContext('2d'), doc.frame, { w: TL_W, h: TL_H });
    if (window.OffscreenCanvas) {
      try {
        const oc = new OffscreenCanvas(TL_W, TL_H);
        oc.getContext('2d').drawImage(tlCanvas, 0, 0);
        return await oc.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
      } catch (_) { /* use the normal way */ }
    }
    return new Promise((res, rej) => tlCanvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.75));
  }
  async function tlCapture() {
    if (busy() || transform || tlBusy) { tlSchedule(); return; }
    tlBusy = true;
    try {
      const blob = await snapshotBlob();
      if (storageOK) {
        await ProjectStorage.tlAdd(blob);
        tlCount++;
        // Very long sessions: keep every other snapshot so it doesn't grow forever.
        if (tlCount > TL_MAX) {
          const keys = await ProjectStorage.tlKeys();
          await ProjectStorage.tlDelete(keys.filter((_, i) => i % 2 === 1 && i < keys.length - 1));
          tlCount = (await ProjectStorage.tlKeys()).length;
        }
      } else {
        tlMemory.push(blob);
        if (tlMemory.length > 600) for (let i = tlMemory.length - 2; i > 0; i -= 2) tlMemory.splice(i, 1);
        tlCount = tlMemory.length;
      }
    } catch (err) {
      console.warn('Time-lapse snapshot failed', err);
    } finally {
      tlBusy = false;
    }
  }
  async function tlReset() {
    clearTimeout(tlTimer);
    tlMemory.length = 0;
    tlCount = 0;
    if (storageOK) { try { await ProjectStorage.tlClear(); } catch (_) { /* ignore */ } }
  }
  async function tlList() {
    return storageOK ? ProjectStorage.tlKeys() : tlMemory.map((_, i) => i);
  }
  async function tlImage(keys, i) {
    const blob = storageOK ? await ProjectStorage.tlGet(keys[i]) : tlMemory[keys[i]];
    return blob ? ProjectStorage.toImage(blob) : null;
  }
  function refreshTimelapseInfo() {
    $('#tl-info').textContent = state.timelapse
      ? (tlCount ? `${tlCount} step${tlCount === 1 ? '' : 's'} recorded so far. Every change you make is added.`
        : 'Nothing recorded yet. Every change you make will be added.')
      : 'Recording is off.' + (tlCount ? ` ${tlCount} step${tlCount === 1 ? ' was' : 's were'} recorded earlier.` : '');
    $('#tl-watch').disabled = !tlCount;
    $('#tl-export-btn').disabled = !tlCount;
  }
  $('#tl-on').addEventListener('change', (e) => {
    state.timelapse = e.target.checked;
    saveSettings();
    refreshTimelapseInfo();
  });

  // ---- The replay viewer ----
  const tlCtx = $('#tl-canvas').getContext('2d');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function openTimelapse() {
    const keys = await tlList();
    if (!keys.length) { toast('Nothing recorded yet. Draw something first!'); return; }
    closePanels();
    stopPlay();
    tlView = { keys, i: 0, playing: true, interval: Math.max(40, Math.min(250, 15000 / keys.length)) };
    $('#tl-seek').max = keys.length - 1;
    $('#tl-overlay').hidden = false;
    tlLoop(tlView);
  }
  async function tlShow(v, i) {
    const img = await tlImage(v.keys, i);
    if (v !== tlView) { if (img && img.close) img.close(); return; }
    if (img) {
      tlCtx.drawImage(img, 0, 0, TL_W, TL_H);
      if (img.close) img.close();
    }
    v.i = i;
    $('#tl-seek').value = i;
    $('#tl-pos').textContent = `${i + 1} / ${v.keys.length}`;
  }
  async function tlLoop(v) {
    $('#tl-play').textContent = 'Pause';
    while (v === tlView && v.playing) {
      const t0 = performance.now();
      await tlShow(v, v.i);
      if (v.i >= v.keys.length - 1) { v.playing = false; break; }
      v.i++;
      await sleep(Math.max(0, v.interval - (performance.now() - t0)));
    }
    if (v === tlView) $('#tl-play').textContent = 'Play';
  }
  function tlTogglePlay() {
    const v = tlView;
    if (!v) return;
    if (v.playing) { v.playing = false; return; }
    if (v.i >= v.keys.length - 1) v.i = 0;
    v.playing = true;
    tlLoop(v);
  }
  function closeTimelapse() {
    tlView = null;
    $('#tl-overlay').hidden = true;
  }
  $('#tl-watch').addEventListener('click', openTimelapse);
  $('#tl-play').addEventListener('click', tlTogglePlay);
  $('#tl-close').addEventListener('click', closeTimelapse);
  $('#tl-seek').addEventListener('input', (e) => {
    const v = tlView;
    if (!v) return;
    v.playing = false;
    tlShow(v, +e.target.value);
  });
  $('#tl-overlay').addEventListener('pointerdown', (e) => { if (e.target.id === 'tl-overlay') closeTimelapse(); });

  // ---- Export the replay as a video ----
  async function exportTimelapse() {
    if (exporting) return;
    const keys = await tlList();
    if (!keys.length) { toast('Nothing recorded yet. Draw something first!'); return; }
    const type = pickVideoType(false);
    if (!type) { toast('This browser can\'t make videos. Try a recent Chrome, Edge or Safari.'); return; }
    closeTimelapse();
    closePanels();
    stopPlay();
    const n = keys.length;
    const dur = clamp(n / 12, 3, 30); // a quick replay: between 3 and 30 seconds
    const hold = 1.5;                  // then stay on the finished picture a moment
    const total = dur + hold;
    const ec = makeCanvas(TL_W, TL_H);
    const ectx = ec.getContext('2d');
    ectx.fillStyle = '#fff';
    ectx.fillRect(0, 0, TL_W, TL_H);
    const preview = $('#ex-preview');
    preview.innerHTML = '';
    preview.appendChild(ec);
    const stream = ec.captureStream();
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 5e6 });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      toast('The video couldn\'t be started in this browser.');
      return;
    }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const finished = new Promise((resolve) => { rec.onstop = resolve; });
    const job = exporting = { rec, cancelled: false, nodes: [] };
    $('#ex-title').textContent = 'Making your time-lapse…';
    $('#export-overlay').hidden = false;
    rec.start(250);
    const start = performance.now();
    let shown = -1, current = null;
    while (!job.cancelled) {
      const t = (performance.now() - start) / 1000;
      if (t >= total) break;
      const idx = Math.min(n - 1, Math.floor((t / dur) * n));
      if (idx !== shown) {
        shown = idx;
        const img = await tlImage(keys, idx);
        if (img) { if (current && current.close) current.close(); current = img; }
      }
      if (current) ectx.drawImage(current, 0, 0, TL_W, TL_H); // redraw so the video has steady frames
      $('#ex-bar').style.width = Math.min(100, (t / total) * 100) + '%';
      $('#ex-status').textContent = `${fmtDuration(Math.min(t, total))} of ${fmtDuration(total)}`;
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (rec.state !== 'inactive') rec.stop();
    await finished;
    if (current && current.close) current.close();
    stream.getTracks().forEach((t) => t.stop());
    $('#export-overlay').hidden = true;
    $('#ex-title').textContent = 'Making your video…';
    preview.innerHTML = '';
    exporting = null;
    if (job.cancelled) { toast('Export cancelled.'); return; }
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    const fileName = `${safeFileName(project.name)} - time-lapse.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    ProjectStorage.download(blob, fileName);
    toast(`Time-lapse saved: "${fileName}" (${(blob.size / 1048576).toFixed(1)} MB) in your Downloads folder.`, 5000);
  }
  $('#tl-export').addEventListener('click', exportTimelapse);
  $('#tl-export-btn').addEventListener('click', exportTimelapse);

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (exporting) {
      e.preventDefault();
      if (e.key === 'Escape') cancelExport();
      return;
    }
    if (tlView) {
      if (e.key === 'Escape') { e.preventDefault(); closeTimelapse(); }
      else if (e.key === ' ') { e.preventDefault(); tlTogglePlay(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'o')) {
      e.preventDefault();
      if (e.key.toLowerCase() === 's') saveToFile(); else openFile();
      return;
    }
    if (e.target.matches && e.target.matches('input[type=text], input[type=number], select')) return; // typing in a box
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'a') { e.preventDefault(); $('#sel-all').click(); return; }
    if (mod && k === 'd') { e.preventDefault(); setSelection(null); return; }
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
    else if (k === 'v') setTool('transform');
    else if (k === 'l') setTool('select');
    else if (k === 'enter' && transform) { applyTransform(); setTool(tfPrevTool); }
    else if (k === 'escape') {
      if ($$('.panel').some((x) => !x.hidden)) closePanels();
      else if (transform) { cancelTransform(); setTool(tfPrevTool); }
      else if (selection) setSelection(null);
    }
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
  updateTitle();
  setSaveStatus('saving');
  requestRender();
  restoreProject();
})();
