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
  cutter: null,          // { height: mm above the relief, wall: mm at the plate, tip: mm all the way up, along,
                         //   ledge: mm the foot reaches past the wall, open: no plate behind the face }
};
// along: "stamp" runs the wall round the stamp's shape; "design" puts its inner face on the
// design's outer outline, so the cut piece is the design's silhouette (shape and margin are ignored)
// open: the face has no plate behind it; details that don't reach the wall are held by bars at the
// back, as thick as the base (so is the ledge)
export const CUTTER_DEFAULTS = { height: 2, wall: 1.5, tip: 0.9, along: "stamp", ledge: 1.5, open: true };

const TAPER_STEPS = 4, BAR = 1.2;                            // mm, bar width
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
    const wall = o.cutter ? o.cutter.wall : 0, lip = o.cutter?.ledge ?? 0, open = Boolean(o.cutter?.open);
    const padIn = (edge ? 0 : o.margin) + wall, pad = padIn + lip;   // design to outline, to the edge
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
    let outline, rim, hole, inner = null, lines = 0;
    if (edge) {
      // the cutter's inner face is the design's outer outline; inner is the background inside it
      hole = filled(ink);
      // A piece drawn as an outline (lines round spaces that are most of its area) is cut along the
      // outer line's inside: the cutter takes that line's place, rather than standing outside it
      // with the line impressed against it. The cutter's face is the outline moved in by one line
      // width, so lines that meet it (a door, a chimney) neither bend it nor cut into the face.
      const pieces = hole.decompose().map((piece) => {
        const open = keep(piece.subtract(ink));
        if (open.area() <= 0.5 * piece.area()) return piece;
        const strokes = keep(piece.intersect(ink));
        let edge = 0;
        for (const p of strokes.toPolygons()) for (let k = 0; k < p.length; k++) {
          const a = p[k], b = p[(k + 1) % p.length];
          edge += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        const width = (2 * strokes.area()) / edge;                // area over half the edge
        const face = piece.offset(-width, "Round", 2, segments(width));
        if (face.isEmpty()) { face.delete(); return piece; }
        lines++;
        piece.delete();
        return face;
      });
      hole = keep(CrossSection.compose(pieces));
      pieces.forEach((p) => p.delete());
      if (lines) notes.push("The design's edge is a drawn line, so the cutter takes its place: it cuts along the line's inside, and the line isn't impressed.");
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
      outline = keep(CrossSection.circle(o.size / 2 - lip, segments(o.size / 2)));
    } else if (shape === "rect") {
      const b = ink.bounds(), w = b.max[0] - b.min[0] + 2 * padIn, h = b.max[1] - b.min[1] + 2 * padIn;
      const r = Math.max(0, Math.min(o.cornerRadius, w / 2 - 0.01, h / 2 - 0.01));
      outline = keep(CrossSection.square([w - 2 * r, h - 2 * r], true));
      if (r > 0) outline = round(outline, r);
      outline = keep(outline.translate([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]));
    } else {
      // follow the design: grow it by the margin and fill in its holes
      outline = filled(padIn > 0 ? round(ink, padIn) : ink);
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
    // what stands up from the face: the design, or the background round it. Cutting along a drawn
    // outline, the background runs right up to the wall, so it's built the way the design is there.
    const lineBg = lines > 0 && o.raise === "background";
    const relief = inner && o.raise === "background" && !lineBg ? inner
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
      // the edge stands `height` above the relief (at least a hair, so their tops never coincide)
      const height = o.depth + Math.max(o.cutter.height, 0.1);
      const tip = Math.min(o.cutter.tip, wall);
      top = o.base + height;
      // Plate, wall and ledge in one piece: a block carved from above. Above the relief the wall is
      // the tip's thickness, straight on both sides, for a clean straight cut; beside the relief
      // its outside widens, in layer-sized steps, to the full wall, which stands on a ledge reaching
      // `lip` past it, as thick as the base. The inside stays vertical. With an open back the face
      // is cut right through. Everything starts below the bed and is trimmed flat at the end, as
      // the relief runs into the wall and its bottoms would otherwise lie on the block's.
      const reach = lip + 1;                                       // past the ledge
      const cuts = [prism(hole, open ? -2 : o.base, top + 1)];
      if (lip > 0) cuts.push(prism(keep(round(rim, reach).subtract(rim)), o.base, top + 1));
      const flare = Math.min(12, Math.max(2, Math.round(o.depth / 0.15)));
      for (let k = 1; tip < wall && k <= flare; k++) {
        const t = wall - ((wall - tip) * k) / flare;
        cuts.push(prism(keep(round(rim, reach + 0.1 * k).subtract(round(rim, -(wall - t)))),
                        o.base + (o.depth * k) / flare, top + 1 + 0.1 * k));
      }
      // (the ledge's outline is simplified for the same reason as the rim's)
      body = keep(prism(lip > 0 ? keep(round(rim, lip).simplify(0.001)) : rim, -1, top).subtract(keep(Manifold.union(cuts))));
      if (outline !== rim) {
        // separate pieces: a plate joins their walls. Its edges run inside the walls or cross them,
        // never along a face (the hull of the walls themselves would touch them tangentially). Its
        // top is 0.01 mm under the wall's foot, which it would otherwise lie on.
        const join = keep(keep(CrossSection.hull([round(hole, wall / 2)])).subtract(round(hole, wall / 4)));
        body = keep(Manifold.union([body, prism(join, -1.2, o.base - 0.01)]));
      }
    } else {
      body = prism(round(outline, 1), 0, o.base);                   // overshoots; trimmed below
    }

    // the raised parts, as taper steps (2D regions, narrowing upwards) or, for a raised background
    // round the stamp's design, a face with grooves; `foot` is what they cover at the bottom
    const bottom = (k) => (o.cutter ? -0.5 - 0.1 * k : 0);
    let raised, foot, layers = null;
    if (edge && (o.raise === "design" || lineBg)) {
      // the face reaches the wall: it runs a little into it (further at each step, so no two steps
      // share a face) and only the gaps in it widen towards the top. A raised background stops
      // 0.1 mm short of the wall where lines meet it, rather than ending exactly on its face.
      const gaps = o.raise === "design" ? inner : keep(ink.intersect(round(hole, -0.1)));
      layers = [];
      for (let k = 0; k < steps; k++) {
        const d = (o.taper * k) / steps;
        layers.push(keep(round(hole, 0.05 * (k + 1)).subtract(d ? round(gaps, d) : gaps)));
      }
    } else if (o.raise === "background" && !edge) {
      // a raised face with the design cut in as grooves that widen towards the top
      const face = wall ? round(hole, 0.05) : round(outline, 1);    // into the wall, or past the edge
      const grooves = [];
      for (let k = 0; k < steps; k++) {
        const d = (o.taper * k) / steps;
        grooves.push(prism(d ? round(ink, d) : ink, k ? band(k) : open ? -2 : o.base - 0.5, reliefTop + 1 + 0.1 * k));
      }
      raised = [keep(prism(face, bottom(0), reliefTop).subtract(keep(Manifold.union(grooves))))];
      foot = keep(face.subtract(ink));
    } else {
      // the design (or, cutting along the design, the background inside it), its sides leaning in
      // towards the top; each step stands on the bed
      layers = [];
      for (let k = 0; k < steps; k++) {
        const d = (o.taper * k) / steps, region = d ? round(relief, -d) : relief;
        if (region.isEmpty()) break;
        layers.push(region);
      }
    }
    if (layers) {
      raised = layers.map((r, k) => prism(r, bottom(k), band(k + 1)));
      foot = layers[0];
    }

    // An open face: details that don't reach the wall are held by bars at the back, each running
    // straight across from wall to wall (0.5 mm into it) through a loose detail's centre (a line
    // through a shape's centre always crosses it), as thick as the base so clear of the clay. Of
    // 24 directions, the bar takes the one crossing the most loose details, then the shortest.
    if (open) {
      const ring = keep(rim.subtract(hole)), span = keep(round(hole, 0.5)), far = 2 * o.size;
      let loose = keep(foot.simplify(0.001)).decompose().map(keep).filter((p) => keep(p.intersect(ring)).area() <= 1e-4);
      const centre = (cs) => {
        let a = 0, x = 0, y = 0;
        for (const q of cs.toPolygons()) for (let k = 0; k < q.length; k++) {
          const [x0, y0] = q[k], [x1, y1] = q[(k + 1) % q.length], c = x0 * y1 - x1 * y0;
          a += c; x += (x0 + x1) * c; y += (y0 + y1) * c;
        }
        return [x / (3 * a), y / (3 * a)];
      };
      const dot = (c) => keep(keep(CrossSection.square([0.02, 0.02], true)).translate(c));
      const bars = [];
      while (loose.length) {
        const c = centre(loose[0]), at = dot(c);
        let best = null;
        for (let k = 0; k < 24; k++) {
          const t = (Math.PI * k) / 24;
          const strip = keep(keep(keep(CrossSection.square([far, BAR], true)).rotate((t * 180) / Math.PI)).translate(c));
          // the stretch of it inside the cutter that passes the centre
          const bar = keep(strip.intersect(span)).decompose().map(keep).find((b) => keep(b.intersect(at)).area() > 0);
          if (!bar) continue;
          const hits = loose.filter((p) => keep(bar.intersect(p)).area() > 0).length, len = bar.area() / BAR;
          if (!best || hits > best.hits || (hits === best.hits && len < best.len)) best = { bar, hits, len };
        }
        if (!best) break;
        bars.push(best.bar);
        loose = loose.filter((p) => keep(best.bar.intersect(p)).area() === 0);
      }
      if (bars.length) {
        raised.push(prism(bars.length > 1 ? keep(CrossSection.union(bars)) : bars[0], -0.95, o.base));
        notes.push(bars.length === 1 ? "Some details don't reach the cutter, so a bar across the back holds them."
                                     : `Some details don't reach the cutter, so ${bars.length} bars across the back hold them.`);
      }
    }
    body = keep(Manifold.union([body, ...raised]));
    if (!o.cutter) body = keep(body.intersect(prism(outline, -1, top + 1)));
    else body = keep(body.intersect(prism(round(outline, lip + 1), 0, top + 1)));
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
    for (const x of new Set(trash)) x.delete();   // some calls hand back an object already kept
  }
}
