/*
 * quickshape.js
 * QuickShape: turns a hand-drawn line into a clean shape.
 * Draw a shape, keep your pen/finger down and hold still for a moment,
 * and it snaps to the nearest clean version:
 *   line, connected lines, circle, ellipse, triangle, rectangle or polygon.
 *
 * detect(points) returns { name, points } with evenly spaced points along the
 * clean shape (ready to be painted with the current brush), or null if the
 * drawing doesn't look like any shape.
 */
(function () {
  'use strict';

  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  function pathLength(P) {
    let L = 0;
    for (let i = 1; i < P.length; i++) L += dist(P[i - 1], P[i]);
    return L;
  }

  // Distance from point p to the straight line through a and b.
  function lineDist(p, a, b) {
    const L = dist(a, b);
    if (L === 0) return dist(p, a);
    return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / L;
  }

  // Resample a path into n evenly spaced points.
  function resample(P, n) {
    const L = pathLength(P);
    if (L === 0) return [P[0]];
    const step = L / (n - 1);
    const out = [{ x: P[0].x, y: P[0].y }];
    let acc = 0;
    for (let i = 1; i < P.length; i++) {
      let a = P[i - 1];
      const b = P[i];
      let seg = dist(a, b);
      while (acc + seg >= step && out.length < n) {
        const t = (step - acc) / seg;
        const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        out.push(q);
        a = q;
        seg = dist(a, b);
        acc = 0;
      }
      acc += seg;
    }
    while (out.length < n) out.push({ x: P[P.length - 1].x, y: P[P.length - 1].y });
    return out;
  }

  // Ramer-Douglas-Peucker: keep only the points that matter (the corners).
  function simplify(P, eps) {
    if (P.length < 3) return P.slice();
    const keep = new Uint8Array(P.length);
    keep[0] = keep[P.length - 1] = 1;
    const stack = [[0, P.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = s + 1; i < e; i++) {
        const d = lineDist(P[i], P[s], P[e]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > 0) {
        keep[idx] = 1;
        stack.push([s, idx], [idx, e]);
      }
    }
    return P.filter((_, i) => keep[i]);
  }

  // Corners of a closed loop.
  function closedCorners(P, eps) {
    // Split the loop at the point farthest from the start, simplify both halves.
    let far = 0, farD = 0;
    for (let i = 0; i < P.length; i++) {
      const d = dist(P[0], P[i]);
      if (d > farD) { farD = d; far = i; }
    }
    const loop = P.concat([P[0]]);
    const a = simplify(loop.slice(0, far + 1), eps);
    const b = simplify(loop.slice(far), eps);
    let pts = a.concat(b.slice(1, -1));
    // Remove corners that are really just points along a straight edge
    // (for example where you started drawing in the middle of a side).
    let changed = true;
    while (changed && pts.length > 3) {
      changed = false;
      for (let i = 0; i < pts.length; i++) {
        const prev = pts[(i - 1 + pts.length) % pts.length], next = pts[(i + 1) % pts.length];
        if (lineDist(pts[i], prev, next) < eps) { pts.splice(i, 1); changed = true; break; }
      }
    }
    return pts;
  }

  // Evenly spaced points along a set of straight segments.
  function densify(corners, closed, step) {
    const pts = closed ? corners.concat([corners[0]]) : corners;
    const out = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.max(1, Math.ceil(dist(a, b) / step));
      for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
    out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
    return out;
  }

  function ellipsePoints(cx, cy, a, b, theta, step) {
    const n = Math.max(24, Math.ceil((Math.PI * (a + b)) / step));
    const c = Math.cos(theta), s = Math.sin(theta);
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      const u = a * Math.cos(t), v = b * Math.sin(t);
      out.push({ x: cx + u * c - v * s, y: cy + u * s + v * c });
    }
    return out;
  }

  // Fit an ellipse to a closed loop. Returns the fit and how far off it is (0 = perfect).
  function fitEllipse(P) {
    const n = P.length;
    let cx = 0, cy = 0;
    for (const p of P) { cx += p.x; cy += p.y; }
    cx /= n; cy /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of P) {
      const dx = p.x - cx, dy = p.y - cy;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const c = Math.cos(theta), s = Math.sin(theta);
    let uu = 0, vv = 0;
    for (const p of P) {
      const dx = p.x - cx, dy = p.y - cy;
      const u = dx * c + dy * s, v = -dx * s + dy * c;
      uu += u * u; vv += v * v;
    }
    const a = Math.sqrt((2 * uu) / n), b = Math.sqrt((2 * vv) / n);
    if (!a || !b) return null;
    let err = 0;
    for (const p of P) {
      const dx = p.x - cx, dy = p.y - cy;
      const u = dx * c + dy * s, v = -dx * s + dy * c;
      err += Math.abs(Math.sqrt((u / a) ** 2 + (v / b) ** 2) - 1);
    }
    return { cx, cy, a, b, theta, err: err / n };
  }

  // Snap an angle to the nearest multiple of `step` if it's within `tol`.
  function snapAngle(angle, step, tol) {
    const near = Math.round(angle / step) * step;
    return Math.abs(angle - near) < tol ? near : angle;
  }

  function angleAt(prev, p, next) {
    const a1 = Math.atan2(prev.y - p.y, prev.x - p.x), a2 = Math.atan2(next.y - p.y, next.x - p.x);
    let d = Math.abs(a1 - a2);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  }

  // Four corners that are close to right angles become a perfect rectangle.
  function regularizeRect(c) {
    const right = c.every((p, i) => Math.abs(angleAt(c[(i + 3) % 4], p, c[(i + 1) % 4]) - Math.PI / 2) < 0.3);
    if (!right) return null;
    // Use the direction of the longest side, snapped to straight if it's close.
    let best = 0, bestL = 0;
    for (let i = 0; i < 4; i++) {
      const L = dist(c[i], c[(i + 1) % 4]);
      if (L > bestL) { bestL = L; best = i; }
    }
    let ang = Math.atan2(c[(best + 1) % 4].y - c[best].y, c[(best + 1) % 4].x - c[best].x);
    ang = snapAngle(ang, Math.PI / 2, 0.09);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of c) {
      const u = p.x * ux + p.y * uy, v = -p.x * uy + p.y * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const toXY = (u, v) => ({ x: u * ux - v * uy, y: u * uy + v * ux });
    return [toXY(minU, minV), toXY(maxU, minV), toXY(maxU, maxV), toXY(minU, maxV)];
  }

  function detect(raw) {
    if (!raw || raw.length < 4) return null;
    const L = pathLength(raw);
    if (L < 20) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of raw) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const diag = Math.hypot(maxX - minX, maxY - minY);
    const P = resample(raw, 96);
    const start = P[0], end = P[P.length - 1];
    const chord = dist(start, end);
    const step = 2;

    // 1. A straight line?
    let maxDev = 0;
    for (const p of P) maxDev = Math.max(maxDev, lineDist(p, start, end));
    if (chord > 0.7 * L && maxDev < Math.max(4, chord * 0.07)) {
      // Snap to perfectly level or upright when it's close.
      const ang = snapAngle(Math.atan2(end.y - start.y, end.x - start.x), Math.PI / 2, 0.06);
      const b = { x: start.x + Math.cos(ang) * chord, y: start.y + Math.sin(ang) * chord };
      return { name: 'Line', points: densify([start, b], false, step) };
    }

    const closed = chord < Math.max(0.15 * L, 0.2 * diag);
    if (closed) {
      const loop = P.slice(0, -1);
      // 2. A triangle, rectangle or other simple polygon?
      const corners = closedCorners(loop, 0.06 * diag);
      if (corners.length === 3) return { name: 'Triangle', points: densify(corners, true, step) };
      if (corners.length === 4) {
        const rect = regularizeRect(corners);
        return rect
          ? { name: 'Rectangle', points: densify(rect, true, step) }
          : { name: 'Shape', points: densify(corners, true, step) };
      }
      // 3. A circle or ellipse?
      const e = fitEllipse(loop);
      if (e && e.err < 0.12) {
        if (Math.min(e.a, e.b) / Math.max(e.a, e.b) > 0.86) {
          const r = (e.a + e.b) / 2;
          return { name: 'Circle', points: ellipsePoints(e.cx, e.cy, r, r, 0, step) };
        }
        const theta = snapAngle(e.theta, Math.PI / 2, 0.09);
        return { name: 'Ellipse', points: ellipsePoints(e.cx, e.cy, e.a, e.b, theta, step) };
      }
      if (corners.length >= 5 && corners.length <= 6) return { name: 'Shape', points: densify(corners, true, step) };
      return null;
    }

    // 4. A few connected straight lines?
    const corners = simplify(P, Math.max(4, 0.05 * diag));
    if (corners.length >= 3 && corners.length <= 5) {
      let fits = true;
      // Make sure each part really is straight.
      for (let i = 1; i < corners.length && fits; i++) {
        const a = corners[i - 1], b = corners[i];
        const ia = P.indexOf(a), ib = P.indexOf(b);
        for (let k = ia; k <= ib; k++) if (lineDist(P[k], a, b) > Math.max(5, 0.06 * diag)) { fits = false; break; }
      }
      if (fits) return { name: 'Lines', points: densify(corners, false, step) };
    }
    return null;
  }

  window.QuickShape = { detect };
})();
