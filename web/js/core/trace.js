// Image -> design outlines: greyscale helpers, automatic threshold, and marching squares tracing.
// No DOM use, so it runs in the worker and in Node.

/** RGBA bytes -> luminance 0..1 per pixel. */
export function luminance(rgba) {
  const n = rgba.length / 4, out = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) / 255;
  return out;
}

/** Otsu's threshold (0..1): the level that best splits the histogram into two classes. */
export function otsu(lum) {
  const hist = new Float64Array(256);
  for (const v of lum) hist[Math.min(255, Math.max(0, Math.round(v * 255)))]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let wB = 0, sumB = 0, best = -1, pick = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; pick = t; }
  }
  return (pick + 0.5) / 255;
}

/** Separable Gaussian blur (sigma in pixels, edges clamped). */
export function blur(src, w, h, sigma) {
  if (!(sigma > 0.3)) return src;
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) ks += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * src[row + Math.min(w - 1, Math.max(0, x + i))];
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = s;
    }
  return out;
}

/** Bounding box of the design pixels {x0, y0, x1, y1} (inclusive), or null when there are none. */
export function inkBounds(lum, w, h, threshold, inkDark) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = lum[y * w + x];
      if (inkDark ? v < threshold : v > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// marching squares segment table: for each case, pairs of cell edges (0 bottom, 1 right, 2 top,
// 3 left) the line crosses; saddles (5, 10) are resolved by the cell's centre value
const CASES = [[], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], null, [[0, 2]], [[3, 2]],
               [[2, 3]], [[0, 2]], null, [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], []];

/**
 * Trace the `level` contour of Z (nx x ny grid), treating the grid as surrounded by -Infinity so
 * every line closes around the area at or above the level. Returns closed loops in grid units
 * [[i, j], ...] (the start repeated at the end), in no particular orientation.
 * (From gpx2stl's contours.js.)
 */
export function traceLevel(Z, nx, ny, level) {
  const W = nx + 2, H = ny + 2;
  const val = (i, j) => {
    i -= 1; j -= 1;
    return i < 0 || j < 0 || i >= nx || j >= ny ? -Infinity : Z[j * nx + i];
  };
  const point = (e) => {                                 // where the line crosses edge e
    const k = e >> 1, i = k % W, j = (k - i) / W;
    const a = val(i, j), b = e & 1 ? val(i, j + 1) : val(i + 1, j);
    let t = a === -Infinity ? 1 : b === -Infinity ? 0 : (level - a) / (b - a);
    t = Math.min(1, Math.max(0, t));
    return e & 1 ? [i - 1, j + t - 1] : [i + t - 1, j - 1];
  };
  const adj = new Map();
  const link = (a, b) => {
    (adj.get(a) ?? adj.set(a, []).get(a)).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)).push(a);
  };
  for (let j = 0; j < H - 1; j++)
    for (let i = 0; i < W - 1; i++) {
      const v0 = val(i, j), v1 = val(i + 1, j), v2 = val(i + 1, j + 1), v3 = val(i, j + 1);
      const c = (v0 >= level) | ((v1 >= level) << 1) | ((v2 >= level) << 2) | ((v3 >= level) << 3);
      if (c === 0 || c === 15) continue;
      const edges = [(j * W + i) * 2, (j * W + i + 1) * 2 + 1, ((j + 1) * W + i) * 2, (j * W + i) * 2 + 1];
      let segs = CASES[c];
      if (!segs) {
        const centre = [v0, v1, v2, v3].filter(Number.isFinite);
        const high = centre.length && centre.reduce((s, v) => s + v, 0) / centre.length >= level;
        segs = (c === 5) === Boolean(high) ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
      }
      for (const [a, b] of segs) link(edges[a], edges[b]);
    }
  const lines = [], seen = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const line = [start];
    seen.add(start);
    let prev = -1, cur = start;
    for (;;) {
      const nb = adj.get(cur), next = nb[0] !== prev ? nb[0] : nb[1];
      if (next === undefined) break;
      if (seen.has(next)) { if (next === start) line.push(start); break; }
      seen.add(next); line.push(next); prev = cur; cur = next;
    }
    if (line.length > 3) lines.push(line.map(point));
  }
  return lines;
}

/** Douglas-Peucker simplification of an open polyline (keeps both ends). */
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i], [bx, by] = pts[j], l = Math.hypot(bx - ax, by - ay) || 1e-12;
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / l;
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Simplify a closed loop (start repeated at the end); returns it without the repeat. */
export function simplifyLoop(pts, tol) {
  // Douglas-Peucker needs two distinct ends: split the loop at its farthest point from the start
  let far = 1, fd = -1;
  for (let k = 1; k < pts.length - 1; k++) {
    const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]);
    if (d > fd) { fd = d; far = k; }
  }
  const out = [...simplify(pts.slice(0, far + 1), tol), ...simplify(pts.slice(far), tol).slice(1)];
  out.pop();
  return out;
}

/** Signed area (positive = counter-clockwise). */
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}
