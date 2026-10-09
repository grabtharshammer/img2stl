import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { writeStl } from "./core/stl.js";
import { luminance, otsu, blur, inkBounds } from "./core/trace.js";
import { DEFAULTS, CUTTER_DEFAULTS } from "./core/stamp.js";

const $ = (id) => document.getElementById(id);
const STORE = "img2stl-settings-v1";
const PREVIEW_PX = 700;     // long side of the raster used for the automatic threshold and the 2D preview
const MAX_PX = 4096;        // long side of the largest raster of the whole image
const MAX_GRID = 2400;      // long side of the traced design, in pixels

// ------------------------------------------------------------------ settings
const SLIDERS = {
  "design-controls": [
    { key: "threshold", label: "Threshold", unit: "%", min: 1, max: 99, step: 1, help: "Where dark turns to light. Pixels on the design's side of it become the design" },
    { key: "smooth", label: "Smoothing", unit: "mm", min: 0, max: 1, step: 0.05, help: "Softens jagged or noisy edges" },
    { key: "boldness", label: "Line boldness", unit: "mm", min: -0.5, max: 1, step: 0.05, help: "Thickens every line of the design (thins it below 0). Fine lines need about 0.4 mm to print" },
    { key: "despeckle", label: "Remove specks under", unit: "mm²", min: 0, max: 10, step: 0.1, help: "Drops stray dots and tiny holes" },
  ],
  "stamp-controls": [
    { key: "size", label: "Size", unit: "mm", min: 20, max: 200, step: 1, help: "Longest side of the stamp" },
    { key: "depth", label: "Impression depth", unit: "mm", min: 0.4, max: 5, step: 0.1, help: "How far the relief stands up, so how deep it presses into the clay" },
    { key: "base", label: "Base thickness", unit: "mm", min: 1, max: 10, step: 0.5 },
    { key: "margin", label: "Border", unit: "mm", min: 1, max: 20, step: 0.5, help: "Space between the design and the edge" },
  ],
  "corner-controls": [
    { key: "cornerRadius", label: "Corner radius", unit: "mm", min: 0, max: 30, step: 0.5 },
  ],
  "cutter-controls": [
    { key: "cutterHeight", label: "Cutter height", unit: "mm", min: 2, max: 25, step: 0.5, help: "Above the base. Match your clay slab's thickness, so the edge cuts through as the stamp touches down" },
    { key: "cutterWall", label: "Wall thickness", unit: "mm", min: 0.8, max: 4, step: 0.1 },
    { key: "cutterTip", label: "Cutting edge", unit: "mm", min: 0.4, max: 4, step: 0.1, help: "Thickness at the very edge; the wall narrows to it over its top 3 mm. Set it to the wall thickness for a square edge" },
  ],
  "advanced-controls": [
    { key: "taper", label: "Relief taper", unit: "mm", min: 0, max: 1, step: 0.05, help: "How far the relief's sides lean in, so the stamp lets go of the clay cleanly" },
  ],
};
const UI_DEFAULTS = {
  ink: "dark", thresholdAuto: true, threshold: 50, smooth: 0.15, boldness: DEFAULTS.boldness, despeckle: DEFAULTS.despeckle,
  mirror: DEFAULTS.mirror, raise: DEFAULTS.raise, shape: DEFAULTS.shape, size: DEFAULTS.size, depth: DEFAULTS.depth,
  base: DEFAULTS.base, margin: DEFAULTS.margin, cornerRadius: DEFAULTS.cornerRadius,
  cutterOn: false, cutterHeight: CUTTER_DEFAULTS.height, cutterWall: CUTTER_DEFAULTS.wall, cutterTip: CUTTER_DEFAULTS.tip,
  cell: 0.1, taper: DEFAULTS.taper,
};

let settings = { ...UI_DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE)) ?? {}); } catch {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {} };

const engineOpts = () => ({
  size: settings.size, depth: settings.depth, base: settings.base, margin: settings.margin, shape: settings.shape,
  cornerRadius: settings.cornerRadius, mirror: settings.mirror, raise: settings.raise, boldness: settings.boldness,
  despeckle: settings.despeckle, taper: settings.taper,
  cutter: settings.cutterOn ? { height: settings.cutterHeight, wall: settings.cutterWall, tip: settings.cutterTip } : null,
});

const inputs = {};
for (const [container, defs] of Object.entries(SLIDERS)) {
  for (const d of defs) {
    const el = document.createElement("div");
    el.className = "field";
    el.innerHTML = `
      <label class="label" for="r-${d.key}">${d.label}</label>
      <div class="slide"><input type="range" id="r-${d.key}" min="${d.min}" max="${d.max}" step="${d.step}">
        <span class="val"><input type="number" min="${d.min}" max="${d.max}" step="${d.step}" aria-label="${d.label}">${d.unit}</span></div>
      ${d.help ? `<span class="help">${d.help}</span>` : ""}`;
    const [range, num] = el.querySelectorAll("input");
    const set = (v, from) => {
      v = parseFloat(v);
      if (!Number.isFinite(v)) return;
      if (from !== num || +num.value !== v) num.value = v;   // also show a clamped typed value
      if (from !== range) range.value = v;
      settings[d.key] = v;
      if (d.key === "threshold") settings.thresholdAuto = false;
      changed();
    };
    range.addEventListener("input", () => set(range.value, range));
    num.addEventListener("change", () => set(Math.min(d.max * 4, Math.max(d.min, num.value)), num));
    inputs[d.key] = (v) => { num.value = v; range.value = v; };
    $(container).append(el);
  }
}

function bindSeg(id, key, parse = (v) => v) {
  const btns = [...$(id).querySelectorAll("button")];
  const sync = () => btns.forEach((b) => b.setAttribute("aria-checked", parse(b.dataset.v) === settings[key]));
  btns.forEach((b) => {
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => { settings[key] = parse(b.dataset.v); sync(); changed(); });
  });
  return sync;
}
function bindCheck(id, key) {
  $(id).addEventListener("change", () => { settings[key] = $(id).checked; changed(); });
  return () => { $(id).checked = settings[key]; };
}
const syncs = [bindSeg("ink", "ink"), bindSeg("raise", "raise"), bindSeg("shape", "shape"), bindSeg("detail", "cell", parseFloat),
               bindCheck("mirror", "mirror"), bindCheck("cutter-on", "cutterOn")];

function syncControls() {
  for (const [k, set] of Object.entries(inputs)) set(settings[k]);
  syncs.forEach((s) => s());
}
$("reset").addEventListener("click", () => {
  settings = { ...UI_DEFAULTS };
  syncControls();
  changed();
});

// ------------------------------------------------------------------ the image
let source = null;     // { name, kind: "svg" | "bitmap", w, h, svg (root element) | bmp }
let preview = null;    // whole image at PREVIEW_PX: { lum, w, h, auto (Otsu threshold) }
let bounds = null;     // the design's bounding box in preview pixels, or null if there is none
let svgCache = null;   // { w, h, img }

function loadSvg(text, name) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.nodeName !== "svg" || doc.querySelector("parsererror")) throw new Error("That SVG file couldn't be read.");
  const vb = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  let w, h;
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) [, , w, h] = vb;
  else {
    // no viewBox: use plain width/height (px, or bare numbers) as one, so the drawing scales
    w = parseFloat(svg.getAttribute("width")); h = parseFloat(svg.getAttribute("height"));
    if (!(w > 0 && h > 0) || /%/.test(svg.getAttribute("width") + svg.getAttribute("height")))
      throw new Error("This SVG has no size (no viewBox, width or height), so it can't be scaled.");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }
  svg.setAttribute("preserveAspectRatio", "none");
  return { name, kind: "svg", svg, w, h };
}

// SVGs are drawn by the browser as an image (scripts in them don't run) at the size needed
async function svgImage(w, h) {
  if (svgCache?.w === w && svgCache?.h === h) return svgCache.img;
  source.svg.setAttribute("width", w);
  source.svg.setAttribute("height", h);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(source.svg)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    svgCache = { w, h, img };
    return img;
  } finally { URL.revokeObjectURL(url); }
}

/** Luminance of the part (sx0..sx1, sy0..sy1, fractions of the image) drawn at dw x dh pixels. */
async function raster(sx0, sy0, sx1, sy1, dw, dh) {
  const c = document.createElement("canvas");
  c.width = dw; c.height = dh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  // transparent areas count as background
  ctx.fillStyle = settings.ink === "dark" ? "#fff" : "#000";
  ctx.fillRect(0, 0, dw, dh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  let img, iw, ih;
  if (source.kind === "svg") {
    iw = Math.max(1, Math.round(dw / (sx1 - sx0))); ih = Math.max(1, Math.round(dh / (sy1 - sy0)));
    img = await svgImage(iw, ih);
  } else { img = source.bmp; iw = img.width; ih = img.height; }
  ctx.drawImage(img, sx0 * iw, sy0 * ih, (sx1 - sx0) * iw, (sy1 - sy0) * ih, 0, 0, dw, dh);
  return luminance(ctx.getImageData(0, 0, dw, dh).data);
}

async function load(make) {
  showError(null);
  let s;
  try { s = await make(); }
  catch (err) { showError(err.message || "That image couldn't be read."); return; }
  source = s;
  svgCache = null;
  clearModel();
  $("source-name").textContent = s.name;
  $("source-meta").textContent = s.kind === "svg" ? "SVG drawing" : `${s.w} × ${s.h} pixels`;
  $("source-info").hidden = false;
  $("drop").hidden = true;
  $("example-hint").hidden = true;
  $("viewer").classList.add("has-source");
  await analyse();
}

async function loadFile(file) {
  const name = file.name || "pasted image";
  await load(async () => {
    if (file.type === "image/svg+xml" || /\.svg$/i.test(name)) return loadSvg(await file.text(), name);
    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch { throw new Error(`${name} isn't an image this browser can read. Try PNG, JPG or SVG.`); }
    return { name, kind: "bitmap", bmp, w: bmp.width, h: bmp.height };
  });
}

// the low-resolution copy: automatic threshold, the design's bounds and the 2D preview
async function analyse() {
  if (!source) return;
  const k = PREVIEW_PX / Math.max(source.w, source.h);
  const w = Math.max(1, Math.round(source.w * k)), h = Math.max(1, Math.round(source.h * k));
  const lum = await raster(0, 0, 1, 1, w, h);
  preview = { lum, w, h, auto: otsu(lum) };
  changed();
}

const threshold = () => (settings.thresholdAuto && preview ? preview.auto : settings.threshold / 100);

// mm across the design's longest side, as the stamp will be built (the engine works it out exactly)
function designLong() {
  const bw = bounds.x1 - bounds.x0 + 1, bh = bounds.y1 - bounds.y0 + 1;
  let L = settings.size - 2 * (settings.margin + (settings.cutterOn ? settings.cutterWall : 0) + settings.boldness);
  if (settings.shape === "circle") L *= Math.max(bw, bh) / Math.hypot(bw, bh);
  return L;
}

function drawPreview() {
  const { lum, w, h } = preview, inkDark = settings.ink === "dark", t = threshold();
  bounds = inkBounds(lum, w, h, t, inkDark);
  const inset = $("inset");
  inset.hidden = !bounds;
  if (!bounds) return;
  // crop round the design, blurred as much as the build will be
  const bw = bounds.x1 - bounds.x0 + 1, bh = bounds.y1 - bounds.y0 + 1, pad = Math.round(Math.max(bw, bh) * 0.06) + 2;
  const x0 = Math.max(0, bounds.x0 - pad), y0 = Math.max(0, bounds.y0 - pad);
  const x1 = Math.min(w, bounds.x1 + 1 + pad), y1 = Math.min(h, bounds.y1 + 1 + pad), cw = x1 - x0, ch = y1 - y0;
  const L = designLong(), soft = blur(lum, w, h, L > 0 ? settings.smooth / (L / Math.max(bw, bh)) : 0);
  const c = $("design"), ctx = c.getContext("2d");
  c.width = cw; c.height = ch;
  const img = ctx.createImageData(cw, ch), css = getComputedStyle(document.documentElement);
  const rgb = (v) => { const n = parseInt(css.getPropertyValue(v).trim().slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  // pressed-in parts are shaded deep; the stamp is mirrored, so the clay shows the image as it
  // is (or reversed when the stamp isn't)
  const deep = rgb("--clay-deep"), surface = rgb("--clay"), pressed = settings.raise === "design";
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const sx = settings.mirror ? x0 + x : x1 - 1 - x, v = soft[(y0 + y) * w + sx];
      const ink = inkDark ? v < t : v > t, col = ink === pressed ? deep : surface, p = (y * cw + x) * 4;
      img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
}

// ------------------------------------------------------------------ state
function changed() {
  save();
  $("corner-controls").hidden = settings.shape !== "rect";
  $("cutter-body").hidden = !settings.cutterOn;
  if (settings.thresholdAuto && preview) inputs.threshold(Math.round(preview.auto * 100));
  $("threshold-note").innerHTML = settings.thresholdAuto
    ? "Threshold is set automatically for this image."
    : `Threshold set by hand. <button class="link" type="button" id="threshold-auto">Set it automatically</button>`;
  if (!source || !preview) return;
  drawPreview();
  if (!bounds) {
    showError("No design found in this image. Try another threshold, or switch between dark and light parts.");
    clearModel();
    return;
  }
  showError(null);
  if (designLong() <= 1) {
    showError("The border and cutter wall leave no room for the design. Make the stamp bigger or the border smaller.");
    return;
  }
  scheduleBuild();
}
$("threshold-note").addEventListener("click", (e) => {
  if (e.target.id !== "threshold-auto") return;
  settings.thresholdAuto = true;
  changed();
});

function showError(msg) {
  $("error").hidden = !msg;
  $("error").textContent = msg ?? "";
}

// ------------------------------------------------------------------ building (automatic)
const STAGES = { engine: ["Loading geometry engine…", 0, 0.1], trace: ["Tracing the design…", 0.1, 0.3],
                 outline: ["Shaping the stamp…", 0.3, 0.5], solid: ["Making it printable…", 0.5, 1] };
let worker = null, busy = false, pending = false, reqId = 0, buildTimer = null;
let model = null, builtFor = null, building = null;

const buildKey = () => JSON.stringify([source?.name, preview?.w, threshold(), settings]);

function scheduleBuild() {
  clearTimeout(buildTimer);
  if (builtFor === buildKey()) return setStatus();
  setStatus("Waiting…");
  buildTimer = setTimeout(startBuild, 250);
}

async function startBuild() {
  if (!source || !bounds) return;
  if (busy) { pending = true; return; }
  const k = buildKey(), opts = engineOpts();
  if (builtFor === k) return setStatus();
  busy = true;
  building = k;
  setProgress("engine", 0);
  try {
    // trace the design at the chosen detail: crop the image round it and draw that at the resolution needed
    const { w: pw, h: ph } = preview, b = bounds;
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, L = designLong();
    const grid = Math.min(MAX_GRID, Math.max(100, L / settings.cell));
    const scale = Math.min(grid / Math.max(bw, bh), MAX_PX / Math.max(pw, ph));   // raster px per preview px
    const x0 = Math.max(0, b.x0 - 2), y0 = Math.max(0, b.y0 - 2), x1 = Math.min(pw, b.x1 + 3), y1 = Math.min(ph, b.y1 + 3);
    const nx = Math.max(2, Math.round((x1 - x0) * scale)), ny = Math.max(2, Math.round((y1 - y0) * scale));
    const lum = await raster(x0 / pw, y0 / ph, x1 / pw, y1 / ph, nx, ny);
    const image = { lum, nx, ny, threshold: threshold(), inkDark: settings.ink === "dark", sigma: settings.smooth / (L / (Math.max(bw, bh) * scale)) };
    worker ??= new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const id = ++reqId;
    const result = await new Promise((resolve) => {
      worker.onmessage = ({ data }) => {
        if (data.id !== id) return;
        if (data.type === "progress") return setProgress(data.stage, data.frac);
        resolve(data);
      };
      worker.onerror = (e) => { worker = null; resolve({ type: "error", message: `Something went wrong: ${e.message || "the worker failed to start"}` }); };
      worker.postMessage({ id, image, opts }, [lum.buffer]);
    });
    if (result.type === "error") { showError(result.message); builtFor = k; clearModel(false); }
    else { showError(null); model = result.model; model.name = source.name; model.cutter = Boolean(opts.cutter); builtFor = k; showModel(model); }
  } catch (err) {
    showError(err.message || String(err));
  }
  busy = false;
  building = null;
  $("progress").hidden = true;
  setStatus();
  if (pending) { pending = false; startBuild(); }
}

function setProgress(stage, frac) {
  const [label, a, b] = STAGES[stage] ?? ["Working…", 0, 1];
  $("progress").hidden = false;
  $("progress-bar").style.width = `${(a + (b - a) * frac) * 100}%`;
  setStatus(label);
}
function setStatus(text) {
  if (text === undefined) text = model && builtFor === buildKey() ? "Model is up to date." : "";
  $("status").textContent = text;
}

// ------------------------------------------------------------------ 3D viewer
const canvas = $("canvas");
// without WebGL the app still builds and downloads models; only the preview is missing
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
} catch (err) {
  console.warn("3D preview unavailable:", err.message);
  $("no-gl").hidden = false;
}
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6050, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-1, 1.2, 1.4);
scene.add(sun);
let mesh = null, framedFor = null;

const dark = matchMedia("(prefers-color-scheme: dark)");
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function applyTheme() {
  scene.background = new THREE.Color(cssVar("--viewer"));
  mesh?.geometry.setAttribute("color", new THREE.BufferAttribute(vertexColors(model), 3));
  if (preview) drawPreview();
  requestRender();
}
dark.addEventListener("change", applyTheme);

new ResizeObserver(() => {
  const { clientWidth: w, clientHeight: h } = canvas.parentElement;
  if (!w || !h) return;
  renderer?.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}).observe(canvas.parentElement);
// render on demand only: redrawing every frame drains batteries (and stalls software GL)
let renderQueued = false;
function requestRender() {
  if (renderQueued || !renderer) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (controls.update()) requestRender();   // still easing (damping)
    renderer.render(scene, camera);
  });
}
controls.addEventListener("change", requestRender);

function fitCamera() {
  if (!model) return;
  const { width, depth, height } = model.stats, r = Math.hypot(width, depth, height) / 2;
  const vfov = (camera.fov * Math.PI) / 360, hfov = Math.atan(Math.tan(vfov) * camera.aspect);
  const d = (r / Math.sin(Math.min(vfov, hfov))) * 0.95;
  controls.target.set(0, 0, height / 3);
  camera.position.set(0, -d * 0.6, d * 0.8);
  camera.near = d / 50; camera.far = d * 10;
  camera.updateProjectionMatrix();
  controls.update();
  requestRender();
}
$("reset-view").addEventListener("click", fitCamera);

const fmtMB = (bytes) => (bytes / 1e6 < 10 ? (bytes / 1e6).toFixed(1) : Math.round(bytes / 1e6)) + " MB";
const mm = (v) => `${v.toFixed(v < 10 ? 1 : 0)} mm`;

function showModel(m) {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.setAttribute("color", new THREE.BufferAttribute(vertexColors(m), 3));
  mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }));
  scene.add(mesh);
  $("viewer").classList.add("has-model");
  // keep the view while adjusting the same image; frame it again for a new one or a new size
  const s = m.stats, frame = `${source.name} ${Math.round(Math.max(s.width, s.depth) / 5)}`;
  if (framedFor !== frame) { framedFor = frame; fitCamera(); }
  requestRender();

  const stats = [
    ["Stamp", `${s.width.toFixed(0)} × ${s.depth.toFixed(0)} × ${mm(s.height)}`],
    ["Design", `${s.design.width.toFixed(0)} × ${s.design.depth.toFixed(0)} mm`],
    ["Impression", mm(s.reliefTop - s.base)],
  ];
  if (s.cutter) stats.push(["Cutter", `${mm(s.top - s.base)} above the base`]);
  stats.push(["Volume", `${s.volume.toFixed(1)} cm³`], ["Triangles", s.triangles.toLocaleString()]);
  $("stats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  $("download-size").textContent = `(${fmtMB(84 + 50 * s.triangles)})`;
  $("notes").innerHTML = s.notes.map((n) => `<li>${n}</li>`).join("");
  $("notes").hidden = !s.notes.length;
  $("result").hidden = false;
}

// preview only: plate, relief (shaded up its sides) and cutter wall in their own colours
function vertexColors(m) {
  const { base, reliefTop } = m.stats, P = m.positions, col = new Float32Array(P.length);
  const plate = new THREE.Color(cssVar("--model")), relief = new THREE.Color(cssVar("--relief-3d")), wall = new THREE.Color(cssVar("--cutter-3d"));
  const c = new THREE.Color();
  for (let i = 0; i < P.length; i += 3) {
    const z = P[i + 2];
    if (z > reliefTop + 0.01) c.copy(wall);
    else c.lerpColors(plate, relief, Math.min(1, Math.max(0, (z - base) / (reliefTop - base))));
    c.toArray(col, i);
  }
  return col;
}

function clearModel(all = true) {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); mesh = null; }
  model = null;
  if (all) builtFor = null;
  $("viewer").classList.remove("has-model");
  $("result").hidden = true;
  requestRender();
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
$("download").addEventListener("click", () => {
  if (!model) return;
  const base = model.name.replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "design";
  saveBlob(new Blob([writeStl(model.positions, model.indices, model.name)], { type: "model/stl" }),
           `${base}_${model.cutter ? "cutter-stamp" : "stamp"}.stl`);
});

// ------------------------------------------------------------------ getting an image in
$("file").addEventListener("change", () => { const f = $("file").files[0]; $("file").value = ""; if (f) loadFile(f); });
$("change").addEventListener("click", () => $("file").click());
$("example").addEventListener("click", async () => {
  await load(async () => loadSvg(await (await fetch("examples/leaf.svg")).text(), "leaf.svg"));
});
for (const t of ["dragenter", "dragover"])
  document.addEventListener(t, (e) => { e.preventDefault(); $("drop").classList.add("over"); });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("drop").classList.remove("over"); });
document.addEventListener("drop", (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});
document.addEventListener("paste", (e) => {
  const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
  if (f) { e.preventDefault(); loadFile(f); }
});

// switching dark/light design changes what transparent areas count as, so redraw the image
let lastInk = settings.ink;
$("ink").addEventListener("click", () => {
  if (settings.ink === lastInk) return;
  lastInk = settings.ink;
  svgCache = null;
  analyse();
});

syncControls();
applyTheme();
changed();
