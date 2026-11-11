/*
 * brushes.js
 * The brush engine. Each brush type knows how to paint a stroke onto a
 * canvas as the pen/finger/mouse moves.
 *
 * A stroke is first painted onto a temporary "stroke buffer". When the stroke
 * ends, the app blends that buffer onto the drawing using the stroke's
 * `opacity` and `composite` (blend) settings. This keeps semi-transparent
 * brushes even within a single stroke.
 *
 * Every brush has these settings:
 *   size, opacity, smoothing,
 *   taper  - how much the line thins out at its start and end (0-100)
 *   pmin   - how big the brush is at the lightest stylus pressure, in % (0-100)
 *   jitter - random size changes for a rougher, hand-made look (0-100)
 */
(function () {
  'use strict';

  const TYPES = {
    pen:         { label: 'Pen',         defaults: { size: 6,  opacity: 100, smoothing: 35, taper: 20, pmin: 15, jitter: 0 } },
    ink:         { label: 'Ink',         defaults: { size: 9,  opacity: 100, smoothing: 45, taper: 70, pmin: 5,  jitter: 0 } },
    pencil:      { label: 'Pencil',      defaults: { size: 5,  opacity: 90,  smoothing: 20, taper: 10, pmin: 40, jitter: 0 } },
    charcoal:    { label: 'Charcoal',    defaults: { size: 22, opacity: 85,  smoothing: 15, taper: 15, pmin: 50, jitter: 15 } },
    crayon:      { label: 'Crayon',      defaults: { size: 14, opacity: 95,  smoothing: 15, taper: 0,  pmin: 60, jitter: 5 } },
    marker:      { label: 'Marker',      defaults: { size: 24, opacity: 55,  smoothing: 30, taper: 0,  pmin: 60, jitter: 0 } },
    soft:        { label: 'Soft brush',  defaults: { size: 60, opacity: 70,  smoothing: 20, taper: 0,  pmin: 35, jitter: 0 } },
    watercolor:  { label: 'Watercolor',  defaults: { size: 50, opacity: 70,  smoothing: 25, taper: 0,  pmin: 50, jitter: 10 } },
    airbrush:    { label: 'Airbrush',    defaults: { size: 70, opacity: 80,  smoothing: 10, taper: 0,  pmin: 100, jitter: 0 }, noTaper: true },
    splatter:    { label: 'Splatter',    defaults: { size: 40, opacity: 90,  smoothing: 0,  taper: 0,  pmin: 60, jitter: 0 }, noTaper: true },
    calligraphy: { label: 'Calligraphy', defaults: { size: 18, opacity: 100, smoothing: 45, taper: 20, pmin: 30, jitter: 0 } },
    glow:        { label: 'Glow',        defaults: { size: 16, opacity: 100, smoothing: 35, taper: 20, pmin: 40, jitter: 0 } },
  };
  const ORDER = ['pen', 'ink', 'pencil', 'charcoal', 'crayon', 'marker', 'soft', 'watercolor',
    'airbrush', 'splatter', 'calligraphy', 'glow'];

  const STAMP = 128;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerpPt = (a, b, t) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
    w: (a.w != null ? a.w : 1) + ((b.w != null ? b.w : 1) - (a.w != null ? a.w : 1)) * t,
  });
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  // Random number with a bell-curve spread.
  function gauss() {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

  // A round dab that fades out toward its edge. hardness 0 = very soft, 1 = crisp.
  function softStamp(rgb, hardness) {
    const c = makeCanvas(STAMP, STAMP);
    const g = c.getContext('2d');
    const r = STAMP / 2;
    const h = clamp(hardness, 0, 0.98);
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, rgba(rgb, 1));
    grad.addColorStop(h, rgba(rgb, 1));
    grad.addColorStop(h + (1 - h) * 0.5, rgba(rgb, 0.4));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, STAMP, STAMP);
    return c;
  }

  // A watercolor dab: pale in the middle, darker toward the rim, like a drying puddle.
  function wetStamp(rgb) {
    const c = makeCanvas(STAMP, STAMP);
    const g = c.getContext('2d');
    const r = STAMP / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, rgba(rgb, 0.3));
    grad.addColorStop(0.65, rgba(rgb, 0.42));
    grad.addColorStop(0.88, rgba(rgb, 0.75));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, STAMP, STAMP);
    return c;
  }

  /**
   * A speckled dab for dry media.
   *   S: texture resolution (lower = coarser grain), keep: how much of it is filled,
   *   streak: stretch the grain sideways (crayon on paper).
   */
  function grainStamp(rgb, S, keep, streak) {
    const r = S / 2;
    const noise = makeCanvas(S, streak ? Math.max(4, S / 4) : S);
    const ng = noise.getContext('2d');
    const img = ng.createImageData(noise.width, noise.height);
    for (let i = 0; i < img.data.length; i += 4) {
      if (Math.random() > keep) continue;
      img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
      img.data[i + 3] = (0.5 + 0.5 * Math.random()) * 255;
    }
    ng.putImageData(img, 0, 0);
    const c = makeCanvas(S, S);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(noise, 0, 0, S, S);
    // Fade toward the edge of the round dab.
    const fade = g.createRadialGradient(r, r, 0, r, r, r);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.6, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = fade;
    g.fillRect(0, 0, S, S);
    return c;
  }

  /**
   * Start a new stroke.
   * o = { type, ctx, color, size, opacity (0-1), softness (0-1, eraser), pressure (bool),
   *       pressureMin (0-1, size at lightest pressure), jitter (0-1) }
   * Points passed to begin()/moveTo() look like { x, y, pressure (0-1), w (0-1, taper) }.
   */
  function createStroke(o) {
    const ctx = o.ctx;
    const type = o.type;
    const rgb = Color.hexToRgb(o.color) || [0, 0, 0];
    const css = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    const usePressure = o.pressure !== false;
    const pmin = o.pressureMin != null ? clamp(o.pressureMin, 0, 1) : 0.3;
    const jitter = clamp(o.jitter || 0, 0, 1);
    const pf = (p) => (usePressure ? pmin + (1 - pmin) * clamp(p.pressure != null ? p.pressure : 1, 0, 1) : 1);
    const jit = () => (jitter ? 1 - jitter * 0.7 * Math.random() : 1);
    const widthAt = (p) => Math.max(0.5, o.size * pf(p) * (p.w != null ? p.w : 1) * jit());

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
    // Draw an image centered on (x, y), w wide, turned by angle.
    function stampAt(img, x, y, w, angle) {
      if (angle) {
        const c = Math.cos(angle), s = Math.sin(angle);
        ctx.setTransform(c, s, -s, c, x, y);
        ctx.drawImage(img, -w / 2, -w / 2, w, w);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      } else {
        ctx.drawImage(img, x - w / 2, y - w / 2, w, w);
      }
      grow(x, y, w / 2);
    }

    if (type === 'pen' || type === 'ink' || type === 'marker') {
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
    } else if (type === 'pencil' || type === 'charcoal' || type === 'crayon') {
      // Dry media: grainy dabs. Charcoal is coarse and scattered;
      // crayon has streaky texture that keeps one direction, like paper grain.
      const look = {
        pencil:   { S: 64, keep: 0.7,  spacing: 0.28, alpha: 0.5,  scatter: 0,    turn: true },
        charcoal: { S: 28, keep: 0.5,  spacing: 0.2,  alpha: 0.45, scatter: 0.15, turn: true },
        crayon:   { S: 48, keep: 0.55, spacing: 0.2,  alpha: 0.6,  scatter: 0.04, turn: false },
      }[type];
      const stamps = [0, 1, 2, 3].map(() => grainStamp(rgb, look.S, look.keep, type === 'crayon'));
      const fixedAngle = Math.random() * Math.PI;
      useStamps(
        (p) => Math.max(0.6, widthAt(p) * look.spacing),
        (p) => {
          const w = widthAt(p);
          const sc = look.scatter * w;
          ctx.globalAlpha = look.alpha * (usePressure ? 0.4 + 0.6 * clamp(p.pressure, 0, 1) : 1);
          stampAt(stamps[(Math.random() * 4) | 0], p.x + gauss() * sc, p.y + gauss() * sc, w,
            look.turn ? Math.random() * Math.PI * 2 : fixedAngle);
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
          ctx.globalAlpha = flow;
          stampAt(stamp, p.x, p.y, widthAt(p), 0);
        }
      );
    } else if (type === 'watercolor') {
      // Rim-dark dabs build up darker edges along the stroke. Multiply lets
      // overlapping washes mix like real paint.
      stroke.composite = 'multiply';
      const stamp = wetStamp(rgb);
      useStamps(
        (p) => Math.max(0.75, widthAt(p) * 0.03),
        (p) => {
          ctx.globalAlpha = 0.04;
          // A tiny wobble hides the individual dabs.
          stampAt(stamp, p.x + gauss() * 0.6, p.y + gauss() * 0.6, widthAt(p), 0);
        }
      );
    } else if (type === 'glow') {
      // A soft halo with a bright core.
      const halo = softStamp(rgb, 0);
      const light = [0, 1, 2].map((i) => Math.round(rgb[i] + (255 - rgb[i]) * 0.65));
      const core = softStamp(light, 0.7);
      useStamps(
        (p) => Math.max(0.75, widthAt(p) * 0.12),
        (p) => {
          const w = widthAt(p);
          ctx.globalAlpha = 0.07;
          stampAt(halo, p.x, p.y, w * 2.6, 0);
          ctx.globalAlpha = 0.9;
          stampAt(core, p.x, p.y, w * 0.55, 0);
        }
      );
    } else if (type === 'splatter') {
      // Random drops of different sizes scattered around the line.
      ctx.fillStyle = css;
      const drops = (p) => {
        const w = widthAt(p);
        const n = 2 + ((Math.random() * 4) | 0);
        for (let i = 0; i < n; i++) {
          const r = w * (0.03 + Math.pow(Math.random(), 3) * 0.25);
          const x = p.x + gauss() * w * 0.6, y = p.y + gauss() * w * 0.6;
          ctx.globalAlpha = 0.6 + 0.4 * Math.random();
          ctx.beginPath();
          ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
          ctx.fill();
          grow(x, y, r);
        }
      };
      useStamps((p) => Math.max(2, widthAt(p) * 0.6), drops);
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

  /**
   * Taper: how wide (0-1) the line is at distance d along a stroke of length L.
   * Used by the app for live strokes and by the previews below.
   */
  function taperAt(d, L, T) {
    if (!T) return 1;
    const start = 0.12 + 0.88 * Math.min(1, d / T);
    const end = L == null ? 1 : 0.12 + 0.88 * Math.min(1, Math.max(0, L - d) / T);
    return Math.min(start, end);
  }
  // Taper length in pixels for a given brush size and taper setting (0-100).
  const taperLength = (size, taper) => (taper / 100) * (40 + size * 4);

  // Sample sizes used for the little previews in the brush panel.
  const PREVIEW_SIZE = {
    pen: 3, ink: 4, pencil: 4, charcoal: 9, crayon: 7, marker: 10, soft: 14, watercolor: 16,
    airbrush: 18, splatter: 14, calligraphy: 8, glow: 6,
  };

  /** Draw a sample squiggle of a brush type into a small canvas. s = that brush's settings. */
  function drawPreview(cv, type, color, s) {
    s = s || TYPES[type].defaults;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 90, H = cv.clientHeight || 34;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const buf = makeCanvas(cv.width, cv.height);
    const size = PREVIEW_SIZE[type] * dpr;
    const st = createStroke({
      type, ctx: buf.getContext('2d'), color, size,
      opacity: s.opacity / 100, softness: 0, pressure: true,
      pressureMin: s.pmin / 100, jitter: s.jitter / 100,
    });
    const N = 48;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push({
        x: (8 + t * (W - 16)) * dpr,
        y: (H / 2 + Math.sin(t * Math.PI * 2) * H * 0.22) * dpr,
        pressure: 0.25 + 0.75 * Math.sin(t * Math.PI),
      });
    }
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const T = TYPES[type].noTaper ? 0 : (s.taper / 100) * L * 0.35;
    let d = 0;
    pts.forEach((p, i) => {
      if (i) d += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
      p.w = taperAt(d, L, T);
      if (i === 0) st.begin(p); else st.moveTo(p);
    });
    st.end();
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.globalAlpha = st.opacity;
    g.globalCompositeOperation = st.composite === 'multiply' ? 'source-over' : st.composite;
    g.drawImage(buf, 0, 0);
  }

  window.Brushes = { TYPES, ORDER, createStroke, drawPreview, taperAt, taperLength };
})();
