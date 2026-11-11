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
 *
 * Each brush is one of a few "kinds" of mark-making (a solid line, grainy dabs,
 * soft dabs, bristles, ...) plus a "look" that tunes it. Brushes are listed in
 * groups for the brush panel.
 */
(function () {
  'use strict';

  const d = (size, opacity, smoothing, taper, pmin, jitter) => ({ size, opacity, smoothing, taper, pmin, jitter });

  // key: { label, group, kind, look, defaults }
  const TYPES = {
    // ---- Inking ----
    pen:         { label: 'Pen',           group: 'Inking', kind: 'line', look: {}, defaults: d(6, 100, 35, 20, 15, 0) },
    ink:         { label: 'Ink',           group: 'Inking', kind: 'line', look: {}, defaults: d(9, 100, 45, 70, 5, 0) },
    brushpen:    { label: 'Brush pen',     group: 'Inking', kind: 'line', look: {}, defaults: d(14, 100, 50, 90, 2, 5) },
    technical:   { label: 'Technical pen', group: 'Inking', kind: 'line', look: {}, defaults: d(3, 100, 55, 0, 100, 0) },
    calligraphy: { label: 'Calligraphy',   group: 'Inking', kind: 'nib', look: { angle: -Math.PI / 4, thin: 0.12 }, defaults: d(18, 100, 45, 20, 30, 0) },
    ribbon:      { label: 'Ribbon',        group: 'Inking', kind: 'nib', look: { angle: -Math.PI / 2 + 0.25, thin: 0.06 }, defaults: d(30, 100, 50, 30, 40, 0) },
    // ---- Sketching ----
    pencil:      { label: 'Pencil',         group: 'Sketching', kind: 'grain', look: { S: 64, keep: 0.7, spacing: 0.28, alpha: 0.5, scatter: 0, turn: true }, defaults: d(5, 90, 20, 10, 40, 0) },
    graphite:    { label: 'Graphite',       group: 'Sketching', kind: 'grain', look: { S: 90, keep: 0.85, spacing: 0.22, alpha: 0.32, scatter: 0.02, turn: true }, defaults: d(9, 85, 20, 15, 35, 0) },
    colorpencil: { label: 'Colored pencil', group: 'Sketching', kind: 'grain', look: { S: 56, keep: 0.6, spacing: 0.22, alpha: 0.55, scatter: 0.02, turn: false, streak: true }, defaults: d(7, 95, 20, 10, 40, 0) },
    charcoal:    { label: 'Charcoal',       group: 'Sketching', kind: 'grain', look: { S: 28, keep: 0.5, spacing: 0.2, alpha: 0.45, scatter: 0.15, turn: true }, defaults: d(22, 85, 15, 15, 50, 15) },
    crayon:      { label: 'Crayon',         group: 'Sketching', kind: 'grain', look: { S: 48, keep: 0.55, spacing: 0.2, alpha: 0.6, scatter: 0.04, turn: false, streak: true }, defaults: d(14, 95, 15, 0, 60, 5) },
    pastel:      { label: 'Pastel',         group: 'Sketching', kind: 'grain', look: { S: 18, keep: 0.6, spacing: 0.16, alpha: 0.5, scatter: 0.22, turn: true }, defaults: d(34, 90, 15, 0, 55, 20) },
    // ---- Painting ----
    soft:        { label: 'Soft brush', group: 'Painting', kind: 'soft', look: { hardness: 0, flow: 0.18, spacing: 0.08 }, defaults: d(60, 70, 20, 0, 35, 0) },
    watercolor:  { label: 'Watercolor', group: 'Painting', kind: 'wet', look: { flow: 0.04, spacing: 0.03 }, defaults: d(50, 70, 25, 0, 50, 10) },
    inkwash:     { label: 'Ink wash',   group: 'Painting', kind: 'wet', look: { flow: 0.07, spacing: 0.04 }, defaults: d(70, 55, 25, 0, 50, 15) },
    gouache:     { label: 'Gouache',    group: 'Painting', kind: 'soft', look: { hardness: 0.88, flow: 0.85, spacing: 0.1, wobble: 0.05 }, defaults: d(28, 100, 30, 10, 60, 8) },
    oil:         { label: 'Oil paint',  group: 'Painting', kind: 'bristle', look: { gaps: 0, shade: 0.12 }, defaults: d(30, 100, 35, 25, 55, 0) },
    drybrush:    { label: 'Dry brush',  group: 'Painting', kind: 'bristle', look: { gaps: 0.45, shade: 0.06 }, defaults: d(36, 95, 30, 20, 55, 0) },
    marker:      { label: 'Marker',     group: 'Painting', kind: 'line', look: { multiply: true }, defaults: d(24, 55, 30, 0, 60, 0) },
    highlighter: { label: 'Highlighter', group: 'Painting', kind: 'nib', look: { angle: -Math.PI / 2, thin: 0.3, multiply: true }, defaults: d(30, 45, 50, 0, 100, 0) },
    felttip:     { label: 'Felt tip',   group: 'Painting', kind: 'soft', look: { hardness: 0.7, flow: 0.55, spacing: 0.08 }, defaults: d(10, 95, 35, 15, 45, 0) },
    // ---- Airbrush & texture ----
    airbrush:    { label: 'Airbrush',    group: 'Airbrush & texture', kind: 'spray', look: { dot: 80, rate: 0.5, alpha: [0.12, 0.35] }, defaults: d(70, 80, 10, 0, 100, 0), noTaper: true },
    spraypaint:  { label: 'Spray paint', group: 'Airbrush & texture', kind: 'spray', look: { dot: 35, rate: 0.9, alpha: [0.35, 0.45] }, defaults: d(60, 95, 10, 0, 100, 0), noTaper: true },
    splatter:    { label: 'Splatter',    group: 'Airbrush & texture', kind: 'splatter', look: {}, defaults: d(40, 90, 0, 0, 60, 0), noTaper: true },
    stipple:     { label: 'Stipple',     group: 'Airbrush & texture', kind: 'stipple', look: {}, defaults: d(30, 100, 10, 0, 60, 0), noTaper: true },
    hatching:    { label: 'Hatching',    group: 'Airbrush & texture', kind: 'hatch', look: { angles: [Math.PI / 4] }, defaults: d(22, 90, 30, 0, 70, 0), noTaper: true },
    crosshatch:  { label: 'Crosshatch',  group: 'Airbrush & texture', kind: 'hatch', look: { angles: [Math.PI / 4, -Math.PI / 4] }, defaults: d(22, 85, 30, 0, 70, 0), noTaper: true },
    smoke:       { label: 'Smoke',       group: 'Airbrush & texture', kind: 'soft', look: { hardness: 0, flow: 0.05, spacing: 0.12, wobble: 0.3 }, defaults: d(80, 60, 25, 0, 50, 35) },
    // ---- Effects ----
    glow:        { label: 'Glow',    group: 'Effects', kind: 'glow', look: { halo: 2.6, haloAlpha: 0.07, core: 0.55, light: 0.65 }, defaults: d(16, 100, 35, 20, 40, 0) },
    neon:        { label: 'Neon',    group: 'Effects', kind: 'glow', look: { halo: 3.4, haloAlpha: 0.1, core: 0.35, light: 0.9 }, defaults: d(12, 100, 45, 15, 60, 0) },
    rainbow:     { label: 'Rainbow', group: 'Effects', kind: 'line', look: { rainbow: true }, defaults: d(14, 100, 40, 20, 40, 0) },
    stars:       { label: 'Stars',   group: 'Effects', kind: 'stars', look: {}, defaults: d(24, 100, 20, 0, 60, 30), noTaper: true },
    fur:         { label: 'Fur',     group: 'Effects', kind: 'fur', look: {}, defaults: d(24, 90, 30, 0, 60, 20), noTaper: true },
  };
  const ORDER = Object.keys(TYPES);
  const GROUPS = [...new Set(ORDER.map((k) => TYPES[k].group))];

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
  // Lighter (k > 0) or darker (k < 0) version of a color.
  const shadeRgb = (rgb, k) => rgb.map((c) => Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k)));

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
    const info = TYPES[type] || { kind: type === 'eraser' ? 'eraser' : 'line', look: {} };
    const kind = info.kind, look = info.look || {};
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
      composite: look.multiply ? 'multiply' : 'source-over',
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
      let dd = need;
      while (dd <= dist) {
        const p = lerpPt(a, b, dd / dist);
        dab(p, a, b);
        dd += spacingOf(p);
      }
      need = dd - dist;
    }
    function useStamps(spacingOf, dab) {
      stroke.begin = (p) => { last = p; dab(p, p, p); need = spacingOf(p); };
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
    // Direction of travel between two points (unit vector), or a default.
    const dirOf = (a, b) => {
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      return L ? { x: (b.x - a.x) / L, y: (b.y - a.y) / L } : { x: 1, y: 0 };
    };

    if (kind === 'line') {
      // Smooth solid line. Rainbow changes color as it goes.
      const hsv = Color.rgbToHsv(rgb[0], rgb[1], rgb[2]);
      let travelled = 0;
      const colorNow = () => {
        if (!look.rainbow) return css;
        const c = Color.hsvToRgb((hsv[0] + travelled * 0.6) % 360, Math.max(0.65, hsv[1]), Math.max(0.85, hsv[2]));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
      };
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      stroke.begin = (p) => {
        const w = widthAt(p);
        ctx.fillStyle = colorNow();
        ctx.beginPath();
        ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
        ctx.fill();
        grow(p.x, p.y, w / 2);
        last = p;
      };
      stroke.moveTo = (p) => {
        const w = (widthAt(last) + widthAt(p)) / 2;
        travelled += Math.hypot(p.x - last.x, p.y - last.y);
        ctx.strokeStyle = colorNow();
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        grow(last.x, last.y, w / 2);
        grow(p.x, p.y, w / 2);
        last = p;
      };
    } else if (kind === 'grain') {
      // Dry media: grainy dabs. Streaky grain keeps one direction, like paper texture.
      const stamps = [0, 1, 2, 3].map(() => grainStamp(rgb, look.S, look.keep, !!look.streak));
      const fixedAngle = Math.random() * Math.PI;
      useStamps(
        (p) => Math.max(0.6, widthAt(p) * look.spacing),
        (p) => {
          const w = widthAt(p);
          const sc = (look.scatter || 0) * w;
          ctx.globalAlpha = look.alpha * (usePressure ? 0.4 + 0.6 * clamp(p.pressure, 0, 1) : 1);
          stampAt(stamps[(Math.random() * 4) | 0], p.x + gauss() * sc, p.y + gauss() * sc, w,
            look.turn ? Math.random() * Math.PI * 2 : fixedAngle);
        }
      );
    } else if (kind === 'soft' || kind === 'eraser') {
      const isEraser = kind === 'eraser';
      const softness = isEraser ? clamp(o.softness || 0, 0, 1) : 1 - (look.hardness || 0);
      const stamp = softStamp(isEraser ? [0, 0, 0] : rgb, 1 - softness);
      if (isEraser) stroke.composite = 'destination-out';
      const flow = isEraser ? (softness > 0 ? 0.35 + 0.65 * (1 - softness) : 1) : look.flow;
      const spacing = isEraser ? (softness > 0 ? 0.1 : 0.15) : look.spacing;
      const wobble = look.wobble || 0;
      useStamps(
        (p) => Math.max(0.75, widthAt(p) * spacing),
        (p) => {
          const w = widthAt(p);
          ctx.globalAlpha = flow;
          stampAt(stamp, p.x + gauss() * w * wobble, p.y + gauss() * w * wobble, w, 0);
        }
      );
    } else if (kind === 'wet') {
      // Rim-dark dabs build up darker edges along the stroke. Multiply lets
      // overlapping washes mix like real paint.
      stroke.composite = 'multiply';
      const stamp = wetStamp(rgb);
      useStamps(
        (p) => Math.max(0.75, widthAt(p) * look.spacing),
        (p) => {
          ctx.globalAlpha = look.flow;
          // A tiny wobble hides the individual dabs.
          stampAt(stamp, p.x + gauss() * 0.6, p.y + gauss() * 0.6, widthAt(p), 0);
        }
      );
    } else if (kind === 'bristle') {
      // Many thin bristles side by side, each a slightly different shade.
      // Dry brush bristles skip now and then, leaving streaky gaps.
      const n = clamp(Math.round(o.size / 2.5), 5, 28);
      const bristles = Array.from({ length: n }, (_, i) => {
        const k = (Math.random() * 2 - 1) * look.shade;
        const c = shadeRgb(rgb, k);
        return {
          off: (i + 0.5) / n - 0.5 + (Math.random() - 0.5) * (0.6 / n),
          width: (1.4 + Math.random() * 1.2) / n,
          color: `rgb(${c[0]},${c[1]},${c[2]})`,
          alpha: 0.55 + Math.random() * 0.45,
          on: true,
        };
      });
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      // The brush turns smoothly, and each bristle continues from where it ended,
      // so the bristle lines stay unbroken through curves.
      let nx = 0, ny = 0;
      stroke.begin = (p) => { last = p; };
      stroke.moveTo = (p) => {
        const L = Math.hypot(p.x - last.x, p.y - last.y);
        if (L < 1.5) return; // wait until the brush has really moved
        const dir = dirOf(last, p);
        if (!nx && !ny) { nx = -dir.y; ny = dir.x; }
        else {
          nx = nx * 0.6 - dir.y * 0.4; ny = ny * 0.6 + dir.x * 0.4;
          const n = Math.hypot(nx, ny) || 1;
          nx /= n; ny /= n;
        }
        const w = widthAt(p);
        for (const b of bristles) {
          const x = p.x + nx * b.off * w, y = p.y + ny * b.off * w;
          if (look.gaps && Math.random() < 0.08) b.on = Math.random() > look.gaps;
          if (b.on && b.px != null) {
            ctx.globalAlpha = b.alpha;
            ctx.strokeStyle = b.color;
            ctx.lineWidth = Math.max(0.6, b.width * w);
            ctx.beginPath();
            ctx.moveTo(b.px, b.py);
            ctx.lineTo(x, y);
            ctx.stroke();
          }
          b.px = x; b.py = y;
        }
        grow(last.x, last.y, w / 2 + 2);
        grow(p.x, p.y, w / 2 + 2);
        last = p;
      };
    } else if (kind === 'glow') {
      // A soft halo with a bright core.
      const halo = softStamp(rgb, 0);
      const core = softStamp(shadeRgb(rgb, look.light), 0.7);
      useStamps(
        (p) => Math.max(0.75, widthAt(p) * 0.12),
        (p) => {
          const w = widthAt(p);
          ctx.globalAlpha = look.haloAlpha;
          stampAt(halo, p.x, p.y, w * look.halo, 0);
          ctx.globalAlpha = 0.9;
          stampAt(core, p.x, p.y, w * look.core, 0);
        }
      );
    } else if (kind === 'splatter') {
      // Random drops of different sizes scattered around the line.
      ctx.fillStyle = css;
      useStamps((p) => Math.max(2, widthAt(p) * 0.6), (p) => {
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
      });
    } else if (kind === 'stipple') {
      // Small, solid dots, like drawing with the tip of a pen.
      ctx.fillStyle = css;
      useStamps((p) => Math.max(1.5, widthAt(p) * 0.45), (p) => {
        const w = widthAt(p);
        const dot = Math.max(1, o.size * 0.07);
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * w / 2;
          const x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r;
          ctx.globalAlpha = 0.85 + Math.random() * 0.15;
          ctx.beginPath();
          ctx.arc(x, y, dot * (0.7 + Math.random() * 0.6), 0, Math.PI * 2);
          ctx.fill();
          grow(x, y, dot * 1.3);
        }
      });
    } else if (kind === 'hatch') {
      // Short parallel lines at a fixed slant (crosshatch adds the other slant).
      ctx.strokeStyle = css;
      ctx.lineCap = 'round';
      let count = 0;
      useStamps((p) => Math.max(2.5, o.size * 0.28), (p) => {
        const w = widthAt(p);
        const ang = look.angles[count++ % look.angles.length];
        const ux = Math.cos(ang) * w / 2, uy = Math.sin(ang) * w / 2;
        const jx = (Math.random() - 0.5) * w * 0.15;
        ctx.globalAlpha = 0.75 + Math.random() * 0.25;
        ctx.lineWidth = Math.max(0.8, o.size * 0.06);
        ctx.beginPath();
        ctx.moveTo(p.x - ux + jx, p.y - uy);
        ctx.lineTo(p.x + ux + jx, p.y + uy);
        ctx.stroke();
        grow(p.x, p.y, w / 2 + 2);
      });
    } else if (kind === 'stars') {
      // Little five-pointed stars, scattered and turned.
      useStamps((p) => Math.max(4, widthAt(p) * 0.9), (p) => {
        const w = widthAt(p);
        const R = w * (0.25 + Math.random() * 0.3);
        const x = p.x + gauss() * w * 0.35, y = p.y + gauss() * w * 0.35;
        const turn = Math.random() * Math.PI;
        const c = shadeRgb(rgb, (Math.random() - 0.3) * 0.5);
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.globalAlpha = 0.8 + Math.random() * 0.2;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? R * 0.42 : R;
          const a = turn + (i * Math.PI) / 5;
          const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
          if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        grow(x, y, R);
      });
    } else if (kind === 'fur') {
      // Fine hairs growing out to both sides of the line.
      ctx.lineCap = 'round';
      let side = 1;
      useStamps((p) => Math.max(1, o.size * 0.08), (p, a, b) => {
        const w = widthAt(p);
        const dir = dirOf(a, b);
        side = -side;
        const ang = Math.atan2(dir.y, dir.x) + side * (Math.PI / 2 - 0.5 + Math.random() * 0.6);
        const len = w * (0.5 + Math.random() * 0.7);
        const c = shadeRgb(rgb, (Math.random() - 0.5) * 0.25);
        ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.globalAlpha = 0.6 + Math.random() * 0.4;
        ctx.lineWidth = Math.max(0.7, o.size * 0.05);
        const ex = p.x + Math.cos(ang) * len, ey = p.y + Math.sin(ang) * len;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(p.x + Math.cos(ang) * len * 0.6 + dir.x * len * 0.2,
          p.y + Math.sin(ang) * len * 0.6 + dir.y * len * 0.2, ex, ey);
        ctx.stroke();
        grow(p.x, p.y, len + 2);
      });
    } else if (kind === 'spray') {
      // Sprays fine dots. Keeps spraying while you hold still.
      stroke.needsTick = true;
      ctx.fillStyle = css;
      const R = o.size / 2;
      const dot = Math.max(1, o.size / look.dot);
      const rate = clamp(o.size * look.rate, 6, 220); // dots per 1/60 second
      let lastT = 0;
      const emit = (p, count) => {
        const flow = usePressure ? clamp(p.pressure, 0.05, 1) : 1;
        for (let i = 0; i < count; i++) {
          const ang = Math.random() * Math.PI * 2;
          const r = Math.min(1, Math.abs(gauss()) / 2.2) * R;
          const s = dot * (0.6 + Math.random() * 0.9);
          ctx.globalAlpha = (look.alpha[0] + look.alpha[1] * Math.random()) * flow;
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
    } else if (kind === 'nib') {
      // A flat nib held at a fixed angle: thick in one direction, thin in the other.
      const ux = Math.cos(look.angle), uy = Math.sin(look.angle);
      const thin = Math.max(1, o.size * look.thin);
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
  function taperAt(dist, L, T) {
    if (!T) return 1;
    const start = 0.12 + 0.88 * Math.min(1, dist / T);
    const end = L == null ? 1 : 0.12 + 0.88 * Math.min(1, Math.max(0, L - dist) / T);
    return Math.min(start, end);
  }
  // Taper length in pixels for a given brush size and taper setting (0-100).
  const taperLength = (size, taper) => (taper / 100) * (40 + size * 4);

  // Brush size used for each little preview in the brush panel.
  const previewSize = (type) => {
    const s = TYPES[type].defaults.size;
    return clamp(s * 0.32, 3, 18);
  };

  /** Draw a sample squiggle of a brush type into a small canvas. s = that brush's settings. */
  function drawPreview(cv, type, color, s) {
    s = s || TYPES[type].defaults;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 90, H = cv.clientHeight || 34;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const buf = makeCanvas(cv.width, cv.height);
    const st = createStroke({
      type, ctx: buf.getContext('2d'), color, size: previewSize(type) * dpr,
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
    let dist = 0;
    pts.forEach((p, i) => {
      if (i) dist += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
      p.w = taperAt(dist, L, T);
      if (i === 0) st.begin(p); else st.moveTo(p);
    });
    st.end();
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.globalAlpha = st.opacity;
    g.globalCompositeOperation = st.composite === 'multiply' ? 'source-over' : st.composite;
    g.drawImage(buf, 0, 0);
  }

  window.Brushes = { TYPES, ORDER, GROUPS, createStroke, drawPreview, taperAt, taperLength };
})();
