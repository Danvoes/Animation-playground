/*
 * brushes.js
 * The brush engine. Each brush type knows how to paint a stroke onto a
 * canvas as the pen/finger/mouse moves.
 *
 * A stroke is first painted onto a temporary "stroke buffer". When the stroke
 * ends, the app blends that buffer onto the drawing using the stroke's
 * `opacity` and `composite` (blend) settings. This keeps semi-transparent
 * brushes even within a single stroke.
 */
(function () {
  'use strict';

  const TYPES = {
    pen:         { label: 'Pen',         defaults: { size: 6,  opacity: 100, smoothing: 35 } },
    pencil:      { label: 'Pencil',      defaults: { size: 5,  opacity: 90,  smoothing: 20 } },
    marker:      { label: 'Marker',      defaults: { size: 24, opacity: 55,  smoothing: 30 } },
    soft:        { label: 'Soft brush',  defaults: { size: 60, opacity: 70,  smoothing: 20 } },
    airbrush:    { label: 'Airbrush',    defaults: { size: 70, opacity: 80,  smoothing: 10 } },
    calligraphy: { label: 'Calligraphy', defaults: { size: 18, opacity: 100, smoothing: 45 } },
  };
  const ORDER = ['pen', 'pencil', 'marker', 'soft', 'airbrush', 'calligraphy'];

  // How thin each brush gets at the lightest stylus pressure (1 = no change).
  const PRESSURE_MIN = { pen: 0.15, pencil: 0.4, marker: 0.6, soft: 0.35, airbrush: 1, calligraphy: 0.3, eraser: 0.3 };

  const STAMP = 128;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerpPt = (a, b, t) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
  });
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  // Random number with a bell-curve spread (used by the airbrush).
  function gauss() {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // A round dab that fades out toward its edge. hardness 0 = very soft, 1 = crisp.
  function softStamp(rgb, hardness) {
    const c = makeCanvas(STAMP, STAMP);
    const g = c.getContext('2d');
    const r = STAMP / 2;
    const col = `${rgb[0]},${rgb[1]},${rgb[2]}`;
    const h = clamp(hardness, 0, 0.98);
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, `rgba(${col},1)`);
    grad.addColorStop(h, `rgba(${col},1)`);
    grad.addColorStop(h + (1 - h) * 0.5, `rgba(${col},0.4)`);
    grad.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, STAMP, STAMP);
    return c;
  }

  // A speckled dab that looks like graphite grain.
  function grainStamp(rgb) {
    const S = 64, r = S / 2;
    const c = makeCanvas(S, S);
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = Math.hypot(x + 0.5 - r, y + 0.5 - r) / r;
        if (d > 1 || Math.random() > 0.7) continue;
        const fall = d < 0.6 ? 1 : (1 - d) / 0.4;
        const i = (y * S + x) * 4;
        img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
        img.data[i + 3] = (0.5 + 0.5 * Math.random()) * fall * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /**
   * Start a new stroke.
   * o = { type, ctx, color, size, opacity (0-1), softness (0-1, eraser), pressure (bool) }
   * Points passed to begin()/moveTo() look like { x, y, pressure (0-1) }.
   */
  function createStroke(o) {
    const ctx = o.ctx;
    const type = o.type;
    const rgb = Color.hexToRgb(o.color) || [0, 0, 0];
    const css = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    const usePressure = o.pressure !== false;
    const pmin = PRESSURE_MIN[type] != null ? PRESSURE_MIN[type] : 0.3;
    const pf = (p) => (usePressure ? pmin + (1 - pmin) * clamp(p.pressure != null ? p.pressure : 1, 0, 1) : 1);
    const widthAt = (p) => Math.max(0.5, o.size * pf(p));

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x, y, r) => {
      r += 2;
      if (x - r < minX) minX = x - r;
      if (y - r < minY) minY = y - r;
      if (x + r > maxX) maxX = x + r;
      if (y + r > maxY) maxY = y + r;
    };

    let last = null;
    let need = 0; // distance left until the next dab

    const stroke = {
      opacity: clamp(o.opacity != null ? o.opacity : 1, 0, 1),
      composite: 'source-over',
      needsTick: false,
      begin() {},
      moveTo() {},
      tick() {},
      end() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
      },
      /** The area that was painted, as a whole-pixel rectangle (or null). */
      bounds() {
        const W = ctx.canvas.width, H = ctx.canvas.height;
        const x = Math.max(0, Math.floor(minX)), y = Math.max(0, Math.floor(minY));
        const x1 = Math.min(W, Math.ceil(maxX)), y1 = Math.min(H, Math.ceil(maxY));
        if (x1 <= x || y1 <= y) return null;
        return { x, y, w: x1 - x, h: y1 - y };
      },
    };

    // Place dabs evenly along the path from a to b.
    function walk(a, b, spacingOf, dab) {
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (dist === 0) return;
      let d = need;
      while (d <= dist) {
        const p = lerpPt(a, b, d / dist);
        dab(p);
        d += spacingOf(p);
      }
      need = d - dist;
    }
    function useStamps(spacingOf, dab) {
      stroke.begin = (p) => { last = p; dab(p); need = spacingOf(p); };
      stroke.moveTo = (p) => { walk(last, p, spacingOf, dab); last = p; };
    }

    if (type === 'pen' || type === 'marker') {
      // Smooth solid line. The marker blends with "multiply", so overlapping
      // strokes get darker, like real marker ink.
      if (type === 'marker') stroke.composite = 'multiply';
      ctx.fillStyle = css;
      ctx.strokeStyle = css;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      stroke.begin = (p) => {
        const w = widthAt(p);
        ctx.beginPath();
        ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
        ctx.fill();
        grow(p.x, p.y, w / 2);
        last = p;
      };
      stroke.moveTo = (p) => {
        const w = (widthAt(last) + widthAt(p)) / 2;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        grow(last.x, last.y, w / 2);
        grow(p.x, p.y, w / 2);
        last = p;
      };
    } else if (type === 'pencil') {
      const stamps = [grainStamp(rgb), grainStamp(rgb), grainStamp(rgb), grainStamp(rgb)];
      useStamps(
        (p) => Math.max(0.6, widthAt(p) * 0.28),
        (p) => {
          const w = widthAt(p);
          const a = Math.random() * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
          ctx.globalAlpha = 0.5 * (usePressure ? 0.4 + 0.6 * clamp(p.pressure, 0, 1) : 1);
          ctx.setTransform(c, s, -s, c, p.x, p.y);
          ctx.drawImage(stamps[(Math.random() * 4) | 0], -w / 2, -w / 2, w, w);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          grow(p.x, p.y, w / 2);
        }
      );
    } else if (type === 'soft' || type === 'eraser') {
      const softness = type === 'soft' ? 1 : clamp(o.softness || 0, 0, 1);
      const stamp = softStamp(type === 'eraser' ? [0, 0, 0] : rgb, 1 - softness);
      if (type === 'eraser') stroke.composite = 'destination-out';
      const flow = type === 'soft' ? 0.18 : (softness > 0 ? 0.35 + 0.65 * (1 - softness) : 1);
      const spacing = type === 'soft' ? 0.08 : (softness > 0 ? 0.1 : 0.15);
      useStamps(
        (p) => Math.max(0.75, widthAt(p) * spacing),
        (p) => {
          const w = widthAt(p);
          ctx.globalAlpha = flow;
          ctx.drawImage(stamp, p.x - w / 2, p.y - w / 2, w, w);
          grow(p.x, p.y, w / 2);
        }
      );
    } else if (type === 'airbrush') {
      // Sprays fine dots. Keeps spraying while you hold still.
      stroke.needsTick = true;
      ctx.fillStyle = css;
      const R = o.size / 2;
      const dot = Math.max(1, o.size / 80);
      const rate = clamp(o.size * 0.5, 6, 160); // dots per 1/60 second
      let lastT = 0;
      const emit = (p, count) => {
        const flow = usePressure ? clamp(p.pressure, 0.05, 1) : 1;
        for (let i = 0; i < count; i++) {
          const ang = Math.random() * Math.PI * 2;
          const r = Math.min(1, Math.abs(gauss()) / 2.2) * R;
          const s = dot * (0.6 + Math.random() * 0.9);
          ctx.globalAlpha = (0.12 + 0.35 * Math.random()) * flow;
          ctx.fillRect(p.x + Math.cos(ang) * r - s / 2, p.y + Math.sin(ang) * r - s / 2, s, s);
        }
        grow(p.x, p.y, R + dot);
      };
      const spacing = () => Math.max(1, R * 0.3);
      stroke.begin = (p) => { last = p; lastT = performance.now(); emit(p, rate); need = spacing(); };
      stroke.moveTo = (p) => { walk(last, p, spacing, (q) => emit(q, Math.ceil(rate * 0.6))); last = p; };
      stroke.tick = () => {
        const t = performance.now();
        const dt = Math.min(64, t - lastT);
        lastT = t;
        if (last) emit(last, Math.round(rate * dt / 16));
      };
    } else if (type === 'calligraphy') {
      // A flat nib held at 45 degrees: thick in one direction, thin in the other.
      const ang = -Math.PI / 4, ux = Math.cos(ang), uy = Math.sin(ang);
      const thin = Math.max(1, o.size * 0.12);
      ctx.fillStyle = css;
      ctx.strokeStyle = css;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = thin;
      const nib = (p) => widthAt(p) / 2;
      stroke.begin = (p) => {
        const h = nib(p);
        ctx.beginPath();
        ctx.moveTo(p.x - ux * h, p.y - uy * h);
        ctx.lineTo(p.x + ux * h, p.y + uy * h);
        ctx.stroke();
        grow(p.x, p.y, h + thin);
        last = p;
      };
      stroke.moveTo = (p) => {
        const h0 = nib(last), h1 = nib(p);
        ctx.beginPath();
        ctx.moveTo(last.x + ux * h0, last.y + uy * h0);
        ctx.lineTo(p.x + ux * h1, p.y + uy * h1);
        ctx.lineTo(p.x - ux * h1, p.y - uy * h1);
        ctx.lineTo(last.x - ux * h0, last.y - uy * h0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        grow(last.x, last.y, h0 + thin);
        grow(p.x, p.y, h1 + thin);
        last = p;
      };
    }

    return stroke;
  }

  // Sample sizes used for the little previews in the brush panel.
  const PREVIEW_SIZE = { pen: 3, pencil: 4, marker: 10, soft: 14, airbrush: 18, calligraphy: 8 };

  /** Draw a sample squiggle of a brush type into a small canvas. */
  function drawPreview(cv, type, color, opacity) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 120, H = cv.clientHeight || 36;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const buf = makeCanvas(cv.width, cv.height);
    const s = createStroke({
      type, ctx: buf.getContext('2d'), color,
      size: PREVIEW_SIZE[type] * dpr, opacity, softness: 0, pressure: true,
    });
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = {
        x: (10 + t * (W - 20)) * dpr,
        y: (H / 2 + Math.sin(t * Math.PI * 2) * H * 0.22) * dpr,
        pressure: 0.25 + 0.75 * Math.sin(t * Math.PI),
      };
      if (i === 0) s.begin(p); else s.moveTo(p);
    }
    s.end();
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.globalAlpha = s.opacity;
    g.globalCompositeOperation = s.composite === 'multiply' ? 'source-over' : s.composite;
    g.drawImage(buf, 0, 0);
  }

  window.Brushes = { TYPES, ORDER, createStroke, drawPreview };
})();
