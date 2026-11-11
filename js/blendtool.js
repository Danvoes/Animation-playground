/*
 * blendtool.js
 * The Blend tool: works on paint that's already on a layer.
 *   - Smudge: drags paint along in the direction you move, like a finger in wet paint.
 *   - Soften: blurs hard edges into smooth transitions.
 *   - Mix:    blends neighboring colors together, like mixing wet paint.
 *
 * How it works: when a blend stroke starts, the layer's pixels are copied into
 * a working array. Each "dab" of the tool changes the pixels under the brush,
 * and the changed area is copied back onto the layer so you see it right away.
 */
(function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const SPACING = { smudge: 0.12, soften: 0.35, mix: 0.25 }; // dab spacing, as a fraction of the radius

  /**
   * o = { ctx (the layer's 2D context), mode, size, strength (0-1), pressure (bool) }
   */
  function createBlendStroke(o) {
    const ctx = o.ctx;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const img = ctx.getImageData(0, 0, W, H);
    const px = img.data;
    const orig = new Uint8ClampedArray(px); // kept for undo

    // Work with "premultiplied" colors (color × alpha) so that blending into
    // transparent areas doesn't create dark halos.
    const P = new Float32Array(W * H * 4);
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3] / 255;
      P[i] = px[i] * a; P[i + 1] = px[i + 1] * a; P[i + 2] = px[i + 2] * a; P[i + 3] = a;
    }

    const mode = o.mode in SPACING ? o.mode : 'smudge';
    const r = Math.max(1.5, o.size / 2);
    const ri = Math.ceil(r);
    const S = ri * 2 + 1;
    const baseStrength = clamp(o.strength, 0, 1);
    const usePressure = o.pressure !== false;

    // Total area changed (for undo) and area changed since the last screen update.
    let bx0 = W, by0 = H, bx1 = 0, by1 = 0;
    let dx0 = W, dy0 = H, dx1 = 0, dy1 = 0;

    let pickup = null;   // smudge: the paint "on your finger"
    let mixColor = null; // mix: the blended color being carried
    let last = null, need = 0;

    const falloff = (d) => { const t = 1 - d * d; return t * t; };

    function region(cx, cy) {
      const x = Math.round(cx), y = Math.round(cy);
      return { x, y, x0: Math.max(0, x - ri), y0: Math.max(0, y - ri), x1: Math.min(W - 1, x + ri), y1: Math.min(H - 1, y + ri) };
    }
    function markDirty(g) {
      if (g.x0 > g.x1 || g.y0 > g.y1) return;
      if (g.x0 < bx0) bx0 = g.x0; if (g.y0 < by0) by0 = g.y0;
      if (g.x1 > bx1) bx1 = g.x1; if (g.y1 > by1) by1 = g.y1;
      if (g.x0 < dx0) dx0 = g.x0; if (g.y0 < dy0) dy0 = g.y0;
      if (g.x1 > dx1) dx1 = g.x1; if (g.y1 > dy1) dy1 = g.y1;
    }

    function loadPickup(cx, cy) {
      pickup = new Float32Array(S * S * 4);
      const g = region(cx, cy);
      for (let j = -ri; j <= ri; j++) {
        const y = g.y + j;
        if (y < 0 || y >= H) continue;
        for (let i = -ri; i <= ri; i++) {
          const x = g.x + i;
          if (x < 0 || x >= W) continue;
          const k = ((j + ri) * S + (i + ri)) * 4, idx = (y * W + x) * 4;
          pickup[k] = P[idx]; pickup[k + 1] = P[idx + 1]; pickup[k + 2] = P[idx + 2]; pickup[k + 3] = P[idx + 3];
        }
      }
    }

    function dabSmudge(g, s) {
      const refresh = 0.08 + 0.5 * (1 - s);
      for (let j = -ri; j <= ri; j++) {
        const y = g.y + j;
        if (y < 0 || y >= H) continue;
        for (let i = -ri; i <= ri; i++) {
          const x = g.x + i;
          if (x < 0 || x >= W) continue;
          const d = Math.hypot(i, j) / r;
          if (d >= 1) continue;
          const w = falloff(d);
          const m = w * s;
          const k = ((j + ri) * S + (i + ri)) * 4, idx = (y * W + x) * 4;
          const f = refresh * w;
          for (let c = 0; c < 4; c++) {
            const v = P[idx + c] + (pickup[k + c] - P[idx + c]) * m;
            P[idx + c] = v;
            pickup[k + c] += (v - pickup[k + c]) * f;
          }
        }
      }
    }

    function dabSoften(g, s) {
      // Box blur using a "summed-area table" so each pixel's average is quick to find.
      const b = clamp(Math.round(r * 0.12), 1, 6);
      const ax0 = Math.max(0, g.x0 - b), ay0 = Math.max(0, g.y0 - b);
      const ax1 = Math.min(W - 1, g.x1 + b), ay1 = Math.min(H - 1, g.y1 + b);
      const aw = ax1 - ax0 + 1, ah = ay1 - ay0 + 1;
      const stride = aw + 1;
      const sat = new Float64Array(stride * (ah + 1) * 4);
      for (let y = 0; y < ah; y++) {
        const row = [0, 0, 0, 0];
        for (let x = 0; x < aw; x++) {
          const idx = ((ay0 + y) * W + (ax0 + x)) * 4;
          const o1 = ((y + 1) * stride + (x + 1)) * 4, o0 = (y * stride + (x + 1)) * 4;
          for (let c = 0; c < 4; c++) {
            row[c] += P[idx + c];
            sat[o1 + c] = sat[o0 + c] + row[c];
          }
        }
      }
      const m0 = s * 0.6;
      const out = [];
      for (let j = -ri; j <= ri; j++) {
        const y = g.y + j;
        if (y < 0 || y >= H) continue;
        for (let i = -ri; i <= ri; i++) {
          const x = g.x + i;
          if (x < 0 || x >= W) continue;
          const d = Math.hypot(i, j) / r;
          if (d >= 1) continue;
          const lx0 = Math.max(ax0, x - b) - ax0, lx1 = Math.min(ax1, x + b) - ax0 + 1;
          const ly0 = Math.max(ay0, y - b) - ay0, ly1 = Math.min(ay1, y + b) - ay0 + 1;
          const n = (lx1 - lx0) * (ly1 - ly0);
          const A = (ly1 * stride + lx1) * 4, B = (ly0 * stride + lx1) * 4, C = (ly1 * stride + lx0) * 4, D = (ly0 * stride + lx0) * 4;
          out.push((y * W + x) * 4, falloff(d) * m0,
            (sat[A] - sat[B] - sat[C] + sat[D]) / n,
            (sat[A + 1] - sat[B + 1] - sat[C + 1] + sat[D + 1]) / n,
            (sat[A + 2] - sat[B + 2] - sat[C + 2] + sat[D + 2]) / n,
            (sat[A + 3] - sat[B + 3] - sat[C + 3] + sat[D + 3]) / n);
        }
      }
      // Write results after reading, so the blur doesn't feed on itself mid-dab.
      for (let q = 0; q < out.length; q += 6) {
        const idx = out[q], m = out[q + 1];
        for (let c = 0; c < 4; c++) P[idx + c] += (out[q + 2 + c] - P[idx + c]) * m;
      }
    }

    function dabMix(g, s) {
      // Average color under the brush (weighted toward the center)...
      const avg = [0, 0, 0, 0];
      let total = 0;
      for (let j = -ri; j <= ri; j++) {
        const y = g.y + j;
        if (y < 0 || y >= H) continue;
        for (let i = -ri; i <= ri; i++) {
          const x = g.x + i;
          if (x < 0 || x >= W) continue;
          const d = Math.hypot(i, j) / r;
          if (d >= 1) continue;
          const w = falloff(d), idx = (y * W + x) * 4;
          for (let c = 0; c < 4; c++) avg[c] += P[idx + c] * w;
          total += w;
        }
      }
      if (!total) return;
      for (let c = 0; c < 4; c++) avg[c] /= total;
      // ...mixed into the color we're carrying...
      if (!mixColor) mixColor = avg.slice();
      else for (let c = 0; c < 4; c++) mixColor[c] += (avg[c] - mixColor[c]) * 0.35;
      // ...then laid back down.
      const m0 = s * 0.5;
      for (let j = -ri; j <= ri; j++) {
        const y = g.y + j;
        if (y < 0 || y >= H) continue;
        for (let i = -ri; i <= ri; i++) {
          const x = g.x + i;
          if (x < 0 || x >= W) continue;
          const d = Math.hypot(i, j) / r;
          if (d >= 1) continue;
          const m = falloff(d) * m0, idx = (y * W + x) * 4;
          for (let c = 0; c < 4; c++) P[idx + c] += (mixColor[c] - P[idx + c]) * m;
        }
      }
    }

    function dab(p) {
      const s = baseStrength * (usePressure ? clamp(p.pressure != null ? p.pressure : 1, 0.05, 1) : 1);
      const g = region(p.x, p.y);
      if (s > 0) {
        if (mode === 'smudge') dabSmudge(g, s);
        else if (mode === 'soften') dabSoften(g, s);
        else dabMix(g, s);
      }
      markDirty(g);
    }

    const spacing = Math.max(1, r * SPACING[mode]);

    return {
      begin(p) {
        last = p;
        if (mode === 'smudge') loadPickup(p.x, p.y);
        else dab(p);
        need = spacing;
      },
      moveTo(p) {
        const dist = Math.hypot(p.x - last.x, p.y - last.y);
        if (dist > 0) {
          let d = need;
          while (d <= dist) {
            const t = d / dist;
            dab({
              x: last.x + (p.x - last.x) * t,
              y: last.y + (p.y - last.y) * t,
              pressure: last.pressure + (p.pressure - last.pressure) * t,
            });
            d += spacing;
          }
          need = d - dist;
        }
        last = p;
      },
      /** Copy the changed pixels onto the layer so they show on screen. */
      flush() {
        if (dx0 > dx1 || dy0 > dy1) return;
        for (let y = dy0; y <= dy1; y++) {
          for (let x = dx0; x <= dx1; x++) {
            const i = (y * W + x) * 4, a = P[i + 3];
            if (a <= 0.001) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; continue; }
            px[i] = P[i] / a; px[i + 1] = P[i + 1] / a; px[i + 2] = P[i + 2] / a; px[i + 3] = a * 255;
          }
        }
        ctx.putImageData(img, 0, 0, dx0, dy0, dx1 - dx0 + 1, dy1 - dy0 + 1);
        dx0 = W; dy0 = H; dx1 = 0; dy1 = 0;
      },
      /** Finish. Returns the changed area and its pixels from before, for undo. */
      end() {
        this.flush();
        if (bx0 > bx1 || by0 > by1) return null;
        const rect = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
        const before = new ImageData(rect.w, rect.h);
        for (let y = 0; y < rect.h; y++) {
          const from = ((rect.y + y) * W + rect.x) * 4;
          before.data.set(orig.subarray(from, from + rect.w * 4), y * rect.w * 4);
        }
        return { rect, before };
      },
    };
  }

  window.BlendTool = { createBlendStroke };
})();
