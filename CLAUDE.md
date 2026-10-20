# img2stl — project notes

Browser app that turns a high-contrast image or SVG into a watertight STL clay stamp, optionally
with a cookie-cutter wall. Sister project of `../gpx2stl` and built the same way: static site in
`web/`, no build step, plain ES modules, three.js 0.186.1 and manifold-3d 3.5.4 (WASM) from
jsDelivr at pinned versions. This PC has no Node; tests run on mythpi1 (`/usr/bin/chromium`,
Node 20; `~/img2stl-test/repo/tests/node_modules` is a symlink to the gpx2stl test deps).

## Pipeline
1. `app.js` rasterises the image on a canvas over a white (dark design) or black (light design)
   background, so transparency is background. SVGs are drawn through `<img>` (scripts don't run)
   at the exact size needed; an SVG without a viewBox gets one from width/height.
2. A PREVIEW_PX (700) copy gives the Otsu threshold, the design's bounding box and the 2D inset
   ("as it will look in the clay": un-mirrored when the stamp is mirrored).
3. Builds are automatic (250 ms debounce, one at a time, latest settings win). The build crops
   round the design and rasterises it at size/cell px (max 2400 px across the design, 4096 for the
   whole image), then the worker blurs it (smoothing, in px) and makes the field: >= 0 is design.
4. `core/stamp.js` `buildStamp`: marching squares (`traceLevel`, closed loops) -> DP simplify to
   0.01 mm -> CrossSection EvenOdd (manifold fixes nesting/orientation) -> drop polygons under
   `despeckle` mm² -> scale so the WHOLE stamp is `size` (pad = margin + wall + boldness; circle uses
   the farthest design point from the bbox centre) -> mirror (reverse point order to keep winding).

## Geometry rules (stamp.js)
- Never union solids that share a face exactly: that left slivers / non-manifold edges (found by
  `tests/stamp.mjs`'s edge check, which merges vertices by position like a slicer does). Instead:
  overshoot the edge by 1 mm and trim with a prism at the end (no cutter), carve plate + wall out
  of one block, keep every cutting tool reaching past what it cuts, offset/raise tops by 0.1*k.
- Relief taper: TAPER_STEPS (4) stacked extrusions, each stands on the bed; design mode shrinks
  the design, background mode widens the grooves.
- Cutter: `tip` thick from the relief top up, both faces vertical (user wants a straight cut);
  over the impression depth the outside widens in ~0.15 mm steps (2–12) to `wall` at the plate.
  The inside is always vertical.
  Height is above the relief top (top = base + depth + height), 0–5 mm in the UI, engine floor
  0.1 so the wall and relief tops never coincide. Wall 0.8–1.5 mm.
  The multi-piece join plate's top is base - 0.01 so it doesn't lie on the wall's foot.
- Ledge (`cutter.ledge`, default 1.5): the block is rim grown by the ledge (simplified 0.001, same
  float32 reason as the rim), cut back to the rim above the base. Included in the fit's `pad`
  (circle radius is size/2 - ledge; rect/outline grow by padIn = margin + wall).
- Open back (`cutter.open`, default on): the hole cut goes through the bed. Any cutter now builds
  from z = -1 and is trimmed at z = 0 (raised steps bottom at -0.5 - 0.1k, bars at -0.95). `foot`
  = the raised parts' bottom region; pieces of it not overlapping rim - hole are loose, and get
  BAR (1.2 mm) bars from z -0.95 to base, wall to wall for strength: a strip through a loose
  piece's area centroid (always crosses it), clipped to hole + 0.5 (so 0.5 mm into the wall), the
  stretch containing the centroid; of 24 directions the one hitting most loose pieces, then the
  shortest. Repeat until none are loose. Trash is freed via a Set (some calls return kept objects).
- Cutting edge default 0.9: with a 0.4 nozzle, Bambu's Classic wall generator needs ~0.82 mm for a
  closed band's two walls and drops 0.8 entirely (user hit this). Arachne prints thinner.
- Preview ground: 250 mm dark plane at z -0.2, 1 cm GridHelper (240/24, lines through the origin)
  at z -0.1, so the model's bottom doesn't z-fight it.
- Drawn outlines along the design (`lines`): hole = filled piece moved in by the average line
  width (2 * stroke area / stroke edge length), when the open space is > half the piece. A raised
  background there is built like the design (round(hole, 0.05(k+1)) - grown lines kept 0.1 mm
  inside the hole), since it reaches the wall.
- Outline shape fills holes; if the grown design is still in pieces, it uses their convex hull and says so.
- Cutter along the design (`cutter.along: "design"`): hole = design with holes filled, rim = hole
  grown by the wall (simplified 0.001 mm: offsets of jagged corners left points a hair apart that
  became open edges as float32), `inner` = background inside. Design mode raises hole + 0.05*(k+1)
  minus the widening `inner` (runs into the wall); background mode raises `inner` like a design.
  Everything starts below z=0 and is trimmed flat at the end (coplanar bottoms left open edges).
  Separate pieces: walls carved per piece, joined by a plate = hull(hole + wall/2) - (hole + wall/4),
  whose edges cross the walls; carving between pieces from a hull block left tangent slivers.
- Thin-feature note: relief area lost to a 0.4 mm morphological opening > 1%.

## Performance
Pi 5: leaf example ~1.5 s, with cutter ~1.6 s; synthetic test designs 1–5 s (offsets of complex
outlines dominate). A laptop is ~4x faster.

## Ideas
- Handle/knob on the back (would need printing upside down or as a separate part).
- Air vents in the plate for cutter stamps (clay suction).
- 3D preview of the impression in clay.
- Text tool (opentype.js like gpx2stl's label) for name stamps.

## Settings in the URL (web/js/urlstate.js)
App-agnostic, meant to be copied unchanged into gpx2stl. The app passes a schema (number with
min/max, bool, enum) built from SLIDERS plus the seg buttons' `data-v` values (so choices can't
drift), its defaults, and keys to omit (`threshold` while automatic). `save()` calls `writeUrl`
on every change; only non-default settings are written (`?size=80&cutterOn=1`), via
`history.replaceState` batched to ~150 ms (Safari throws after 100 calls in 30 s). On load a URL
with any valid setting wins over localStorage and keys it leaves out are DEFAULTS (so a shared
link reproduces exactly); junk and out-of-range values are dropped or clamped. `shareUrl()`
flushes and returns the link for the Copy link button; `copyText` falls back to execCommand.
The image is never in the URL.
Back-porting to gpx2stl: build its schema the same way; keep per-route state (map area override,
label text/position, trim) out of it unless that's wanted, since it only makes sense for one GPX.
