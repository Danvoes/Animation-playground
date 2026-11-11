/*
 * app.js
 * The main program: connects the toolbar, panels, canvas, brushes and undo.
 */
(function () {
  'use strict';

  // Drawing size in pixels (16:9, the shape of most videos).
  const DOC_W = 1280, DOC_H = 720;
  const SIZE_MAX = 200;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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

  // ---------------------------------------------------------------------------
  // The drawing ("document"). It is a list of layers. Part 1a has one layer;
  // Part 1b adds the Layers panel.
  // ---------------------------------------------------------------------------
  const doc = { width: DOC_W, height: DOC_H, layers: [], active: 0 };
  function addLayer(name) {
    const canvas = makeCanvas(DOC_W, DOC_H);
    const layer = { name, canvas, ctx: canvas.getContext('2d'), visible: true, opacity: 1 };
    doc.layers.push(layer);
    return layer;
  }
  addLayer('Layer 1');
  const activeLayer = () => doc.layers[doc.active];

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
  };
  Brushes.ORDER.forEach((t) => {
    state.brushes[t] = Object.assign({}, Brushes.TYPES[t].defaults, (saved.brushes || {})[t] || {});
  });
  function saveSettings() {
    store.set('ap.settings.v1', {
      brushType: state.brushType, color: state.color, pressure: state.pressure,
      brushes: state.brushes, eraser: state.eraser,
    });
  }
  let recent = store.get('ap.recentColors.v1', []);
  if (!Array.isArray(recent)) recent = [];
  recent = recent.map(Color.normalizeHex).filter(Boolean).slice(0, 10);

  const currentSettings = () => (state.tool === 'eraser' ? state.eraser : state.brushes[state.brushType]);

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
  history.onChange();

  function undo() { if (!stroke && history.undo()) requestRender(); }
  function redo() { if (!stroke && history.redo()) requestRender(); }

  function clearLayer() {
    if (stroke) return;
    const layer = activeLayer();
    const before = layer.ctx.getImageData(0, 0, DOC_W, DOC_H);
    layer.ctx.clearRect(0, 0, DOC_W, DOC_H);
    history.push({
      label: 'Clear',
      undo() { layer.ctx.putImageData(before, 0, 0); },
      redo() { layer.ctx.clearRect(0, 0, DOC_W, DOC_H); },
    });
    requestRender();
  }

  // ---------------------------------------------------------------------------
  // Drawing what you see: white paper, then each visible layer.
  // ---------------------------------------------------------------------------
  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }
  function render() {
    renderQueued = false;
    if (stroke && stroke.needsTick) stroke.tick();

    dctx.globalCompositeOperation = 'source-over';
    dctx.globalAlpha = 1;
    dctx.fillStyle = '#ffffff';
    dctx.fillRect(0, 0, DOC_W, DOC_H);

    doc.layers.forEach((layer, i) => {
      if (!layer.visible) return;
      let src = layer.canvas;
      if (stroke && i === doc.active) {
        // Show the layer as it will look once this stroke is finished.
        sctx.globalCompositeOperation = 'source-over';
        sctx.globalAlpha = 1;
        sctx.clearRect(0, 0, DOC_W, DOC_H);
        sctx.drawImage(layer.canvas, 0, 0);
        sctx.globalAlpha = stroke.opacity;
        sctx.globalCompositeOperation = stroke.composite;
        sctx.drawImage(buffer, 0, 0);
        sctx.globalAlpha = 1;
        sctx.globalCompositeOperation = 'source-over';
        src = scratch;
      }
      dctx.globalAlpha = layer.opacity;
      dctx.drawImage(src, 0, 0);
    });
    dctx.globalAlpha = 1;

    if (stroke && stroke.needsTick) requestRender(); // keep the airbrush spraying
  }

  // ---------------------------------------------------------------------------
  // Mouse / touch / stylus input
  // ---------------------------------------------------------------------------
  let activePointer = null; // only one finger/pen draws at a time
  let stroke = null;
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
    stroke.moveTo({ x: smooth.x, y: smooth.y, pressure: smooth.pressure });
  }

  display.addEventListener('pointerdown', (e) => {
    if (activePointer !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    activePointer = e.pointerId;
    try { display.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const p = toDoc(e);

    if (state.tool === 'eyedropper') { pickColor(p); return; }

    const isEraser = state.tool === 'eraser';
    const st = currentSettings();
    stroke = Brushes.createStroke({
      type: isEraser ? 'eraser' : state.brushType,
      ctx: bctx,
      color: state.color,
      size: st.size,
      opacity: isEraser ? 1 : st.opacity / 100,
      softness: isEraser ? st.softness / 100 : 0,
      pressure: state.pressure,
    });
    strokeSmoothing = st.smoothing / 100;
    smooth = { x: p.x, y: p.y, pressure: p.pressure };
    lastRaw = p;
    stroke.begin({ x: p.x, y: p.y, pressure: p.pressure });
    if (!isEraser) addRecent(state.color);
    requestRender();
  });

  display.addEventListener('pointermove', (e) => {
    updateCursor(e);
    if (e.pointerId !== activePointer) return;
    if (state.tool === 'eyedropper') { pickColor(toDoc(e)); return; }
    if (!stroke) return;
    const rect = display.getBoundingClientRect();
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = list.length ? list : [e];
    for (const ev of events) {
      const p = toDoc(ev, rect);
      lastRaw = p;
      feed(p);
    }
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
    if (!stroke) return;
    // Let the smoothed line catch up to where you actually stopped.
    if (lastRaw && strokeSmoothing > 0) {
      for (let i = 0; i < 40 && Math.hypot(lastRaw.x - smooth.x, lastRaw.y - smooth.y) > 0.5; i++) feed(lastRaw);
    }
    stroke.end();
    commitStroke();
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
    if (rect) {
      const layer = activeLayer();
      const before = layer.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      layer.ctx.save();
      layer.ctx.globalAlpha = s.opacity;
      layer.ctx.globalCompositeOperation = s.composite;
      layer.ctx.drawImage(buffer, 0, 0);
      layer.ctx.restore();
      const after = layer.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      history.push({
        label: 'Stroke',
        undo() { layer.ctx.putImageData(before, rect.x, rect.y); },
        redo() { layer.ctx.putImageData(after, rect.x, rect.y); },
      });
    }
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, DOC_W, DOC_H);
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
    if (e.pointerType === 'touch' || state.tool === 'eyedropper') {
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
    const pad = stage.clientWidth < 640 ? 8 : 20;
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
  // Toolbar and panels
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
    $$('.panel').forEach((p) => { p.hidden = true; });
    $$('.btn.open').forEach((b) => b.classList.remove('open'));
  }
  function openPanel(panel, anchor) {
    closePanels();
    panel.hidden = false;
    anchor.classList.add('open');
    const r = anchor.getBoundingClientRect();
    const tb = $('.toolbar').getBoundingClientRect();
    const left = clamp(r.left, 8, Math.max(8, window.innerWidth - panel.offsetWidth - 8));
    panel.style.left = left + 'px';
    panel.style.top = (tb.bottom + 6) + 'px';
    panel.style.maxHeight = (window.innerHeight - tb.bottom - 14) + 'px';
    if (panel.id === 'panel-brush') drawBrushPreviews();
    if (panel.id === 'panel-color') picker.markPrevious();
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

    const eraser = state.tool === 'eraser';
    $('#settings-label').textContent = eraser ? 'Eraser' : Brushes.TYPES[state.brushType].label;
    $('#brush-section').hidden = eraser;
    $('#eraser-section').hidden = !eraser;

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

    $('#color-swatch').style.background = state.color;
    display.classList.toggle('picking', state.tool === 'eyedropper');
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target.matches && e.target.matches('input[type=text]')) return; // typing a hex code
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    if (k === 'b') setTool('brush');
    else if (k === 'e') setTool('eraser');
    else if (k === 'i') setTool('eyedropper');
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

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  syncUI();
  fit();
  requestRender();
})();
