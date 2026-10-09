// Stamp geometry. The traced design becomes a plate (printed face up, pressed face down into the
// clay) with the design raised on it, or with the background raised so the design stands out in
// the clay. An optional cookie-cutter wall runs round the edge and reaches past the relief, so
// one press cuts the shape out and imprints it. Everything ends up as one watertight manifold.
import { traceLevel, simplifyLoop, polygonArea } from "./trace.js";

export const DEFAULTS = {
  size: 60,              // mm, longest side of the whole stamp
  depth: 1.5,            // mm the relief stands up from the plate (= impression depth)
  base: 3,               // mm plate thickness
  margin: 3,             // mm between the design and the edge (or the cutter wall)
  shape: "outline",      // "outline" follows the design, "rect", "circle"
  cornerRadius: 3,       // mm, rect only
  mirror: true,          // so the impression reads the right way round
  raise: "design",       // "design": pressed into the clay; "background": design stands out
  boldness: 0,           // mm grown (or shrunk) on every edge of the design
  despeckle: 0.5,        // mm²: islands and holes smaller than this are dropped
  taper: 0.2,            // mm the relief's sides lean in over its height, so it lets go of the clay
  cutter: null,          // { height: mm above the plate, wall: mm, tip: mm at the cutting edge }
};
export const CUTTER_DEFAULTS = { height: 6, wall: 1.6, tip: 0.8 };

const TAPER_STEPS = 4, BLADE_STEPS = 6, BLADE_LENGTH = 3;   // mm of wall that narrows to the tip
const MIN_FEATURE = 0.4;                                     // mm; about one nozzle line
const segments = (r) => Math.min(360, Math.max(24, Math.round((2 * Math.PI * Math.abs(r)) / 0.25)));

/**
 * field: Float32Array nx x ny, row 0 at the top; the design is where field >= 0.
 * Returns { positions, indices, stats }.
 */
export function buildStamp({ field, nx, ny }, options, { manifold, progress = () => {} }) {
  const o = { ...DEFAULTS, ...options };
  const { CrossSection, Manifold } = manifold;
  const trash = [];
  const keep = (x) => (trash.push(x), x);
  const round = (cs, d) => keep(cs.offset(d, "Round", 2, segments(d)));
  try {
    progress("trace", 0);
    const raw = traceLevel(field, nx, ny, 0).map((l) => l.map(([i, j]) => [i, ny - 1 - j]));   // y up
    if (!raw.length) throw new Error("No design found. Try another threshold, or switch between dark and light parts.");

    const wall = o.cutter ? o.cutter.wall : 0, pad = o.margin + wall;
    // scale (mm per pixel) that makes the finished stamp o.size across its longest side
    const fit = (polys) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of polys) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      let s;
      if (o.shape === "circle") {
        let r = 0;
        for (const p of polys) for (const [x, y] of p) r = Math.max(r, Math.hypot(x - cx, y - cy));
        s = (o.size / 2 - pad - o.boldness) / r;
      } else s = (o.size - 2 * (pad + o.boldness)) / Math.max(x1 - x0, y1 - y0);
      if (!(s > 0)) throw new Error("The margin and cutter wall leave no room for the design at this size. Make the stamp bigger or the margin smaller.");
      return { cx, cy, s };
    };
    let f = fit(raw);

    // simplify to ~0.01 mm, then let manifold sort out nesting (even-odd) and orientation
    const cs = keep(new CrossSection(raw.map((l) => simplifyLoop(l, 0.01 / f.s)).filter((l) => l.length >= 3), "EvenOdd"));
    const all = cs.toPolygons();
    // drop specks; dropping an island also drops anything inside it, which is smaller still
    let polys = all;
    for (let pass = 0; pass < 2 && o.despeckle > 0; pass++) {
      polys = all.filter((p) => Math.abs(polygonArea(p)) * f.s ** 2 >= o.despeckle);
      if (!polys.some((p) => polygonArea(p) > 0)) throw new Error("Nothing is left after removing specks. Lower 'Remove specks under'.");
      f = fit(polys);
    }
    progress("trace", 1);

    // into mm, centred on the origin; mirroring reverses the winding, so flip the point order back
    const sx = o.mirror ? -f.s : f.s;
    const mm = polys.map((p) => {
      const q = p.map(([x, y]) => [(x - f.cx) * sx, (y - f.cy) * f.s]);
      return o.mirror ? q.reverse() : q;
    });
    let ink = keep(new CrossSection(mm, "Positive"));
    if (o.boldness) ink = round(ink, o.boldness);
    if (ink.isEmpty()) throw new Error("The design vanished. Use less negative line boldness.");

    progress("outline", 0);
    const notes = [];
    let outline;
    if (o.shape === "circle") {
      outline = keep(CrossSection.circle(o.size / 2, segments(o.size / 2)));
    } else if (o.shape === "rect") {
      const b = ink.bounds(), w = b.max[0] - b.min[0] + 2 * pad, h = b.max[1] - b.min[1] + 2 * pad;
      const r = Math.max(0, Math.min(o.cornerRadius, w / 2 - 0.01, h / 2 - 0.01));
      outline = keep(CrossSection.square([w - 2 * r, h - 2 * r], true));
      if (r > 0) outline = round(outline, r);
      outline = keep(outline.translate([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]));
    } else {
      // follow the design: grow it by the margin and fill in its holes
      const grown = pad > 0 ? round(ink, pad) : ink;
      outline = keep(new CrossSection(grown.toPolygons().filter((p) => polygonArea(p) > 0), "Positive"));
      const parts = outline.decompose();
      if (parts.length > 1) {
        outline = keep(CrossSection.hull([outline]));
        notes.push("The design is in separate pieces, so the outline wraps around all of them.");
      }
      parts.forEach((p) => p.delete());
    }

    // the open face of the stamp: inside the cutter wall, or (without one) the whole outline
    const hole = wall ? round(outline, -wall) : outline;
    const relief = keep(o.raise === "background" ? hole.subtract(ink) : ink.intersect(hole));
    if (relief.isEmpty()) throw new Error("Nothing to raise: the design fills the whole stamp.");
    const opened = round(round(relief, -MIN_FEATURE / 2), MIN_FEATURE / 2);
    if ((relief.area() - opened.area()) / relief.area() > 0.01)
      notes.push(`Some raised details are thinner than ${MIN_FEATURE} mm and may not print cleanly. A little more line boldness helps.`);
    progress("outline", 1);

    // Solids that share a face exactly can leave slivers and non-manifold edges behind in a
    // boolean, so nothing here does: bodies overlap, overshoot the edge and get trimmed back, or
    // are carved out by subtraction, and every cutting tool reaches past what it cuts.
    progress("solid", 0);
    const prism = (cs, z0, z1) => keep(keep(cs.extrude(z1 - z0)).translate([0, 0, z0]));
    const reliefTop = o.base + o.depth, steps = o.taper > 0 ? TAPER_STEPS : 1;
    const band = (k) => o.base + (o.depth * k) / steps;             // bottom of taper step k
    let top = reliefTop, body;
    if (o.cutter) {
      const height = Math.max(o.cutter.height, o.depth + 1);   // the edge must reach past the relief
      const tip = Math.min(o.cutter.tip, wall);
      const blade = tip < wall ? Math.min(BLADE_LENGTH, height - o.depth - 0.5) : 0;
      top = o.base + height;
      // plate and wall in one piece: a block with the face hollowed out above the plate. The inner
      // face stays vertical, so the cut piece gets clean straight sides; the outside narrows in
      // steps to the tip over the top `blade` mm.
      const cuts = [prism(hole, o.base, top + 1)];
      for (let k = 1; blade > 0 && k <= BLADE_STEPS; k++) {
        const t = wall - ((wall - tip) * k) / BLADE_STEPS;
        cuts.push(prism(keep(round(outline, 1 + 0.1 * k).subtract(round(outline, -(wall - t)))),
                        top - blade + (blade * (k - 1)) / BLADE_STEPS, top + 1 + 0.1 * k));
      }
      body = keep(prism(outline, 0, top).subtract(keep(Manifold.union(cuts))));
    } else {
      body = prism(round(outline, 1), 0, o.base);                   // overshoots; trimmed below
    }
    let raised;
    if (o.raise === "background") {
      // a raised face with the design cut in as grooves that widen towards the top
      const face = wall ? round(hole, 0.05) : round(outline, 1);    // into the wall, or past the edge
      const grooves = [];
      for (let k = 0; k < steps; k++) {
        const d = (o.taper * k) / steps;
        grooves.push(prism(d ? round(ink, d) : ink, k ? band(k) : o.base - 0.5, reliefTop + 1 + 0.1 * k));
      }
      raised = [keep(prism(face, 0, reliefTop).subtract(keep(Manifold.union(grooves))))];
    } else {
      // the design itself, its sides leaning in towards the top; each step stands on the bed
      raised = [];
      for (let k = 0; k < steps; k++) {
        const d = (o.taper * k) / steps, region = d ? round(relief, -d) : relief;
        if (region.isEmpty()) break;
        raised.push(prism(region, 0, band(k + 1)));
      }
    }
    body = keep(Manifold.union([body, ...raised]));
    if (!o.cutter) body = keep(body.intersect(prism(outline, -1, top + 1)));
    if (body.status() !== "NoError") throw new Error(`Geometry error: ${body.status()}`);
    progress("solid", 1);

    const g = body.getMesh(), gp = g.numProp, gv = g.vertProperties;
    const positions = new Float32Array((gv.length / gp) * 3);
    for (let i = 0, k = 0; i < gv.length; i += gp, k += 3) { positions[k] = gv[i]; positions[k + 1] = gv[i + 1]; positions[k + 2] = gv[i + 2]; }
    const bb = body.boundingBox(), ib = ink.bounds();
    return {
      positions, indices: new Uint32Array(g.triVerts),
      stats: {
        width: bb.max[0] - bb.min[0], depth: bb.max[1] - bb.min[1], height: bb.max[2] - bb.min[2],
        design: { width: ib.max[0] - ib.min[0], depth: ib.max[1] - ib.min[1] },
        volume: body.volume() / 1000, triangles: body.numTri(), genus: body.genus(),
        base: o.base, reliefTop, top, cutter: Boolean(o.cutter), notes,
      },
    };
  } finally {
    for (const x of trash) x.delete();
  }
}
