/*
 * rig.js
 * Rigging (puppet animation): build a character from separate parts joined at
 * joints, pose it on some frames, and let the frames in between move by themselves.
 *
 * A puppet lives on a "puppet layer":  layer.rig = { nodes, keys, nodeIds }
 *   node = { id, partId, parent (node id or null), restX, restY (where the part's
 *            picture sits when unposed), pivotX, pivotY (its joint, measured inside
 *            the part's picture), z (drawing order) }
 *   keys: Map(frameId -> { ease, pose })  - "key poses" you made on those frames
 *   pose = { nodeId: { x, y (move; whole puppet only), rot (turn, radians), s (size) } }
 *
 * Each part turns around its own joint, and carries its children with it
 * (turn the upper arm and the lower arm and hand come along).
 *
 * Matrices are [a, b, c, d, e, f], the same order as canvas setTransform().
 */
(function () {
  'use strict';

  const I = [1, 0, 0, 1, 0, 0];
  function mul(A, B) {
    return [
      A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
      A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
      A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
    ];
  }
  const T = (x, y) => [1, 0, 0, 1, x, y];
  const R = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
  const S = (k) => [k, 0, 0, k, 0, 0];
  const apply = (M, x, y) => ({ x: M[0] * x + M[2] * y + M[4], y: M[1] * x + M[3] * y + M[5] });
  function invert(M) {
    const det = M[0] * M[3] - M[1] * M[2];
    if (!det) return null;
    const a = M[3] / det, b = -M[1] / det, c = -M[2] / det, d = M[0] / det;
    return [a, b, c, d, -(a * M[4] + c * M[5]), -(b * M[4] + d * M[5])];
  }

  const REST = { x: 0, y: 0, rot: 0, s: 1 };
  const nodeOf = (rig, id) => rig.nodes.find((n) => n.id === id) || null;
  const pivotOf = (n) => ({ x: n.restX + n.pivotX, y: n.restY + n.pivotY });

  /** Where every part ends up for a pose: Map(nodeId -> matrix). */
  function world(rig, pose) {
    const out = new Map();
    const visit = (n, depth) => {
      if (out.has(n.id)) return out.get(n.id);
      const p = (pose && pose[n.id]) || REST;
      const pw = pivotOf(n);
      const local = mul(mul(mul(T(pw.x, pw.y), R(p.rot || 0)), S(p.s == null ? 1 : p.s)), T(-pw.x, -pw.y));
      const parent = n.parent && depth < 64 ? nodeOf(rig, n.parent) : null;
      const M = parent ? mul(visit(parent, depth + 1), local) : mul(T(p.x || 0, p.y || 0), local);
      out.set(n.id, M);
      return M;
    };
    rig.nodes.forEach((n) => visit(n, 0));
    return out;
  }

  /** Draw the puppet in a pose. parts: Map(partId -> { canvas }). */
  function render(ctx, rig, pose, parts) {
    const W = world(rig, pose);
    const order = [...rig.nodes].sort((a, b) => a.z - b.z);
    for (const n of order) {
      const part = parts.get(n.partId);
      if (!part) continue;
      const M = W.get(n.id);
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.drawImage(part.canvas, n.restX, n.restY);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return W;
  }

  function lerpPose(rig, a, b, t) {
    const out = {};
    for (const n of rig.nodes) {
      const p = a[n.id] || REST, q = b[n.id] || REST;
      const ps = p.s == null ? 1 : p.s, qs = q.s == null ? 1 : q.s;
      out[n.id] = {
        x: (p.x || 0) + ((q.x || 0) - (p.x || 0)) * t,
        y: (p.y || 0) + ((q.y || 0) - (p.y || 0)) * t,
        rot: (p.rot || 0) + ((q.rot || 0) - (p.rot || 0)) * t,
        s: ps + (qs - ps) * t,
      };
    }
    return out;
  }

  /**
   * The pose on frame number idx.
   * frameIds: every frame's id in order; times: when each frame starts (seconds).
   * Frames with a key pose use it. Frames between two key poses blend from one to the
   * other (with a smooth start and stop unless the earlier key says otherwise).
   * Before the first key / after the last, the nearest key pose is held.
   */
  function poseAt(rig, frameIds, times, idx) {
    const own = rig.keys.get(frameIds[idx]);
    if (own) return { pose: own.pose, key: own, kind: 'key' };
    let prev = -1, next = -1;
    for (let i = idx - 1; i >= 0; i--) if (rig.keys.has(frameIds[i])) { prev = i; break; }
    for (let i = idx + 1; i < frameIds.length; i++) if (rig.keys.has(frameIds[i])) { next = i; break; }
    if (prev < 0 && next < 0) return { pose: {}, key: null, kind: 'rest' };
    if (prev < 0) return { pose: rig.keys.get(frameIds[next]).pose, key: null, kind: 'hold' };
    if (next < 0) return { pose: rig.keys.get(frameIds[prev]).pose, key: null, kind: 'hold' };
    const A = rig.keys.get(frameIds[prev]), B = rig.keys.get(frameIds[next]);
    let t = (times[idx] - times[prev]) / ((times[next] - times[prev]) || 1);
    if (A.ease !== false) t = t * t * (3 - 2 * t); // ease in and out
    return { pose: lerpPose(rig, A.pose, B.pose, t), key: null, kind: 'between' };
  }

  // Is there something drawn at this spot of the part's picture?
  function alphaAt(part, x, y) {
    const w = part.canvas.width, h = part.canvas.height;
    if (!part.alpha) {
      const d = part.canvas.getContext('2d').getImageData(0, 0, w, h).data;
      part.alpha = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) part.alpha[i] = d[i * 4 + 3];
    }
    return part.alpha[y * w + x];
  }

  /** The top-most part at drawing position (x, y), or null. */
  function hit(rig, W, parts, x, y) {
    const order = [...rig.nodes].sort((a, b) => b.z - a.z);
    for (const n of order) {
      const part = parts.get(n.partId);
      const M = W.get(n.id);
      const inv = M && invert(M);
      if (!part || !inv) continue;
      const l = apply(inv, x, y);
      const ux = Math.floor(l.x - n.restX), uy = Math.floor(l.y - n.restY);
      if (ux < 0 || uy < 0 || ux >= part.canvas.width || uy >= part.canvas.height) continue;
      if (alphaAt(part, ux, uy) > 20) return n;
    }
    return null;
  }

  // Would attaching child to parent make a loop (a part hanging from itself)?
  function wouldLoop(rig, childId, parentId) {
    let cur = parentId;
    for (let i = 0; i < 200 && cur; i++) {
      if (cur === childId) return true;
      const n = nodeOf(rig, cur);
      cur = n && n.parent;
    }
    return false;
  }
  // A part and everything hanging from it.
  function family(rig, id) {
    const out = [nodeOf(rig, id)];
    for (let i = 0; i < out.length; i++) {
      for (const n of rig.nodes) if (n.parent === out[i].id && !out.includes(n)) out.push(n);
    }
    return out.filter(Boolean);
  }

  window.Rig = { I, mul, T, R, S, apply, invert, world, render, poseAt, lerpPose, hit, wouldLoop, family, nodeOf, pivotOf };
})();
