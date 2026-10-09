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
- Cutter: inner face vertical; the outside steps in over the top BLADE_LENGTH (3 mm) to `tip`.
  Height is clamped to >= depth + 1.
- Outline shape fills holes; if the grown design is still in pieces, it uses their convex hull and says so.
- Thin-feature note: relief area lost to a 0.4 mm morphological opening > 1%.

## Performance
Pi 5: leaf example ~1.5 s, with cutter ~1.6 s; synthetic test designs 1–5 s (offsets of complex
outlines dominate). A laptop is ~4x faster.

## Ideas
- Handle/knob on the back (would need printing upside down or as a separate part).
- Air vents in the plate for cutter stamps (clay suction).
- 3D preview of the impression in clay.
- Text tool (opentype.js like gpx2stl's label) for name stamps.
