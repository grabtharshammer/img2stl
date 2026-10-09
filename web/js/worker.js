// Runs the stamp build off the main thread so the page stays responsive.
import { buildStamp } from "./core/stamp.js";
import { blur } from "./core/trace.js";

const MANIFOLD_URL = "https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/manifold.js";

let manifold;
async function getManifold() {
  if (!manifold) {
    manifold = import(MANIFOLD_URL)
      .then((m) => m.default())
      .then((wasm) => (wasm.setup(), wasm));
    manifold.catch(() => (manifold = null));
  }
  return manifold;
}

// image: { lum (0..1, row 0 at the top), nx, ny, threshold, inkDark, sigma (blur, px) }
self.onmessage = async ({ data: { id, image, opts } }) => {
  const progress = (stage, frac) => self.postMessage({ id, type: "progress", stage, frac });
  try {
    progress("engine", 0);
    const wasm = await getManifold();
    const { nx, ny, threshold: t, inkDark } = image, soft = blur(image.lum, nx, ny, image.sigma);
    const field = new Float32Array(nx * ny);   // >= 0 inside the design
    for (let i = 0; i < field.length; i++) field[i] = inkDark ? t - soft[i] : soft[i] - t;
    const m = buildStamp({ field, nx, ny }, opts, { manifold: wasm, progress });
    self.postMessage({ id, type: "done", model: m }, [m.positions.buffer, m.indices.buffer]);
  } catch (err) {
    self.postMessage({ id, type: "error", message: err?.message ?? String(err) });
  }
};
