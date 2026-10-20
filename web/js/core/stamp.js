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
  cutter: null,          // { height: mm above the plate, wall: mm at the plate, tip: mm all the way up, along }
};
// along: "stamp" runs the wall round the stamp's shape; "design" puts its inner face on the
// design's outer outline, so the cut piece is the design's silhouette (shape and margin are ignored)
export const CUTTER_DEFAULTS = { height: 4, wall: 1.5, tip: 0.8, along: "stamp" };

const TAPER_STEPS = 4;
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

    const edge = o.cutter?.along === "design", shape = edge ? "outline" : o.shape;
    const wall = o.cutter ? o.cutter.wall : 0, pad = (edge ? 0 : o.margin) + wall;
    // scale (mm per pixel) that makes the finished stamp o.size across its longest side
    const fit = (polys) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of polys) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      let s;
      if (shape === "circle") {
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
    const filled = (c) => keep(new CrossSection(c.toPolygons().filter((p) => polygonArea(p) > 0), "Positive"));
    // outline: the whole stamp; rim: the outside of the cutter wall; hole: the open face inside it
    let outline, rim, hole, inner = null;
    if (edge) {
      // the cutter's inner face is the design's outer outline; inner is the background inside it
      hole = filled(ink);
      inner = keep(hole.subtract(ink));
      // offsetting a jagged traced corner leaves points a hair apart, which merge into an open
      // edge once written as float32; the old shapes never hit this, as the hull smoothed them
      rim = outline = keep(round(hole, wall).simplify(0.001));
      const parts = hole.decompose();
      if (parts.length > 1) {
        outline = keep(CrossSection.hull([rim]));
        notes.push("The design is in separate pieces: each gets its own cutting edge, on one plate.");
      }
      parts.forEach((p) => p.delete());
    } else if (shape === "circle") {
      outline = keep(CrossSection.circle(o.size / 2, segments(o.size / 2)));
    } else if (shape === "rect") {
      const b = ink.bounds(), w = b.max[0] - b.min[0] + 2 * pad, h = b.max[1] - b.min[1] + 2 * pad;
      const r = Math.max(0, Math.min(o.cornerRadius, w / 2 - 0.01, h / 2 - 0.01));
      outline = keep(CrossSection.square([w - 2 * r, h - 2 * r], true));
      if (r > 0) outline = round(outline, r);
      outline = keep(outline.translate([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]));
    } else {
      // follow the design: grow it by the margin and fill in its holes
      outline = filled(pad > 0 ? round(ink, pad) : ink);
      const parts = outline.decompose();
      if (parts.length > 1) {
        outline = keep(CrossSection.hull([outline]));
        notes.push("The design is in separate pieces, so the outline wraps around all of them.");
      }
      parts.forEach((p) => p.delete());
    }

    if (!edge) {
      // the open face of the stamp: inside the cutter wall, or (without one) the whole outline
      rim = outline;
      hole = wall ? round(outline, -wall) : outline;
    }
    const relief = inner && o.raise === "background" ? inner
      : keep(o.raise === "background" ? hole.subtract(ink) : ink.intersect(hole));
    if (relief.isEmpty())
      throw new Error(edge ? "Nothing to raise: the design has no details inside its outline to stand out."
                           : "Nothing to raise: the design fills the whole stamp.");
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
      const height = Math.max(o.cutter.height, 0.1);            // a wall flush with the plate is no wall
      const tip = Math.min(o.cutter.tip, wall);
      if (height <= o.depth)
        notes.push("The relief stands as tall as the cutter or taller, so it reaches the clay before the cutting edge does.");
      top = o.base + height;
      // plate and wall in one piece: a block with the face hollowed out above the plate. Above the
      // plate the wall is the tip's thickness all the way up, straight on both sides, for a clean
      // straight cut; at the plate it widens out to the full wall.
      // Cutting along the design, everything starts below the bed and is trimmed flat at the end:
      // the relief runs into the wall, and its bottoms would otherwise lie on the block's.
      const cuts = [prism(hole, o.base, top + 1)];
      if (tip < wall) cuts.push(prism(keep(round(rim, 1).subtract(round(rim, -(wall - tip)))), o.base, top + 1));
      body = keep(prism(rim, edge ? -1 : 0, top).subtract(keep(Manifold.union(cuts))));
      if (outline !== rim) {
        // separate pieces: a plate joins their walls. Its edges run inside the walls or cross them,
        // never along a face (the hull of the walls themselves would touch them tangentially). Its
        // top is 0.01 mm under the wall's shoulder, which it would otherwise lie on.
        const join = keep(keep(CrossSection.hull([round(hole, wall / 2)])).subtract(round(hole, wall / 4)));
        body = keep(Manifold.union([body, prism(join, -1.2, o.base - 0.01)]));
      }
    } else {
      body = prism(round(outline, 1), 0, o.base);                   // overshoots; trimmed below
    }
    let raised;
    if (edge && o.raise === "design") {
      // the design fills the cutter: it runs a little into the wall (further at each step, so no
      // two steps share a face) and only its inside gaps widen towards the top
      raised = [];
      for (let k = 0; k < steps; k++) {
        const d = (o.taper * k) / steps;
        raised.push(prism(keep(round(hole, 0.05 * (k + 1)).subtract(d ? round(inner, d) : inner)), -0.5 - 0.1 * k, band(k + 1)));
      }
    } else if (o.raise === "background" && !edge) {
      // a raised face with the design cut in as grooves that widen towards the top
      const face = wall ? round(hole, 0.05) : round(outline, 1);    // into the wall, or past the edge
      const grooves = [];
      for (let k = 0; k < steps; k++) {
        const d = (o.taper * k) / steps;
        grooves.push(prism(d ? round(ink, d) : ink, k ? band(k) : o.base - 0.5, reliefTop + 1 + 0.1 * k));
      }
      raised = [keep(prism(face, 0, reliefTop).subtract(keep(Manifold.union(grooves))))];
    } else {
      // the design (or, cutting along the design, the background inside it), its sides leaning in
      // towards the top; each step stands on the bed
      raised = [];
      for (let k = 0; k < steps; k++) {
        const d = (o.taper * k) / steps, region = d ? round(relief, -d) : relief;
        if (region.isEmpty()) break;
        raised.push(prism(region, 0, band(k + 1)));
      }
    }
    body = keep(Manifold.union([body, ...raised]));
    if (!o.cutter) body = keep(body.intersect(prism(outline, -1, top + 1)));
    else if (edge) body = keep(body.intersect(prism(round(outline, 1), 0, top + 1)));
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
