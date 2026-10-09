// Engine checks on synthetic designs: every option combination gives one closed, valid solid of
// the requested size.   cd tests && npm install && node stamp.mjs
import Module from "manifold-3d";
import { buildStamp } from "../web/js/core/stamp.js";
import { otsu, blur } from "../web/js/core/trace.js";

const manifold = await Module();
manifold.setup();

let failed = false;
const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) failed = true; };
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

// a ring with a dot in it, and an off-centre bar (asymmetric, to see mirroring), on 400 x 300 px
function design(nx = 400, ny = 300) {
  const lum = new Float32Array(nx * ny).fill(0.95);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const r = Math.hypot(x - 150, y - 150);
      if ((r > 70 && r < 110) || r < 20 || (x > 300 && x < 330 && y > 60 && y < 240)) lum[y * nx + x] = 0.1;
    }
  lum[5 * nx + 5] = 0.1;                                     // a one-pixel speck
  const thr = otsu(lum), soft = blur(lum, nx, ny, 1);
  const field = new Float32Array(nx * ny);
  for (let i = 0; i < field.length; i++) field[i] = thr - soft[i];
  return { field, nx, ny };
}
const d = design();

function build(opts, label) {
  const t0 = performance.now();
  const m = buildStamp(d, opts, { manifold });
  const s = m.stats, ms = performance.now() - t0;
  console.log(`     ${label}: ${s.width.toFixed(2)} x ${s.depth.toFixed(2)} x ${s.height.toFixed(2)} mm, ` +
              `${s.volume.toFixed(2)} cm³, ${s.triangles} tris, genus ${s.genus}, ${ms.toFixed(0)} ms${s.notes.length ? " · " + s.notes.join(" ") : ""}`);
  // closed: every edge used exactly twice, once each way
  const edges = new Map(), I = m.indices, P = m.positions, key = (a, b) => `${a},${b}`;
  // merge coincident vertices first (manifold may duplicate them along property seams)
  const id = new Map(), vid = new Uint32Array(P.length / 3);
  for (let v = 0; v < vid.length; v++) {
    const k = `${P[3 * v]},${P[3 * v + 1]},${P[3 * v + 2]}`;
    vid[v] = id.get(k) ?? id.set(k, id.size).get(k);
  }
  for (let t = 0; t < I.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const k = key(vid[I[t + e]], vid[I[t + (e + 1) % 3]]);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  let open = 0;
  for (const [k, n] of edges) { const [a, b] = k.split(","); if (n !== 1 || edges.get(key(b, a)) !== 1) open++; }
  check(open === 0, `${label}: closed mesh`);
  return m;
}

const base = build({}, "defaults");
check(near(Math.max(base.stats.width, base.stats.depth), 60), "defaults: longest side is 60 mm");
check(near(base.stats.height, 4.5), "defaults: height = base 3 + depth 1.5");
check(base.stats.genus === 0, "defaults: outline fills the ring's hole (genus 0)");

const rect = build({ shape: "rect", size: 80 }, "rect");
check(near(rect.stats.width, 80), "rect: 80 mm wide");
const circ = build({ shape: "circle", size: 50 }, "circle");
check(near(circ.stats.width, 50, 0.1) && near(circ.stats.depth, 50, 0.1), "circle: 50 mm across");

const cut = build({ cutter: { height: 8, wall: 1.6, tip: 0.8 } }, "cutter");
check(near(cut.stats.height, 11), "cutter: wall reaches 3 + 8 mm");
check(near(Math.max(cut.stats.width, cut.stats.depth), 60), "cutter: still 60 mm overall");
build({ cutter: { height: 8, wall: 1.6, tip: 1.6 }, shape: "rect" }, "cutter, square edge, rect");
build({ cutter: { height: 2, wall: 1.2, tip: 0.6 }, shape: "circle", depth: 3 }, "cutter lower than relief (clamped)");

const bg = build({ raise: "background" }, "background raised");
check(bg.stats.volume > base.stats.volume, "background raised: more material than design raised");
build({ raise: "background", cutter: { height: 6, wall: 1.6, tip: 0.8 } }, "background raised, cutter");
build({ raise: "background", shape: "rect" }, "background raised, rect");
build({ taper: 0 }, "no taper");
build({ boldness: 0.5 }, "bold");
build({ boldness: -0.3, despeckle: 0 }, "thin, specks kept");

// mirroring: the ring is left of the design's centre in the image, so right of it on the stamp face
const xs = (m) => {
  let sum = 0, n = 0;
  for (let i = 0; i < m.positions.length; i += 3) if (m.positions[i + 2] > m.stats.base + 0.5) { sum += m.positions[i]; n++; }
  return sum / n;
};
const unm = build({ mirror: false }, "not mirrored");
check(xs(unm) < -1 && near(xs(base), -xs(unm), 0.01), "mirror: relief flips sides");

try { buildStamp(d, { size: 10, margin: 6 }, { manifold }); check(false, "too small: should fail"); }
catch (e) { check(/no room/.test(e.message), `too small: "${e.message}"`); }
try { buildStamp({ field: new Float32Array(100).fill(-1), nx: 10, ny: 10 }, {}, { manifold }); check(false, "empty: should fail"); }
catch (e) { check(/No design/.test(e.message), `empty: "${e.message}"`); }

process.exit(failed ? 1 : 0);
