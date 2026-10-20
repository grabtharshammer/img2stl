# img2stl

Turn a high-contrast image or SVG into a 3D-printable stamp for pressing designs into clay, with
an optional cookie-cutter edge that cuts the shape out in the same press.

**Use it here: <https://grabtharshammer.github.io/img2stl/>**. Nothing to install.

Everything runs in your browser; your image is never uploaded anywhere. It's a static site in
`web/` with nothing to install: serve the folder (or open it from GitHub Pages) and drop in an image.

## What it does

- Reads **SVG, PNG, JPG, GIF, WebP**: drop a file, browse, or paste from the clipboard.
- **Threshold** picks the design out of the image (set automatically, or by hand), with
  **smoothing**, **line boldness** and **speck removal** to clean it up. The design can be the dark
  or the light parts.
- **Mirrored** by default, so text and the image read the right way round in the clay.
- **Design pressed in** (the design is raised on the stamp) or **design stands out** (the
  background is raised, so the design stands up in the clay).
- Stamp shape: follows the design's **outline**, or a **rectangle** or **circle**.
- **Impression depth** and **base thickness**, and a slight **taper** on the relief so it lets go of the clay.
- **Cookie cutter**: a wall round the edge, a thin straight cutting edge above the relief that
  widens over the impression depth to a sturdier wall at the plate, standing on a flat **ledge**.
  With an **open back** there's no plate behind the design: details that don't reach the cutter are
  held by bars at the back. Set its height to your clay slab's thickness: the edge cuts through as the stamp touches down.
  It runs round the stamp's edge, or **along the design's outline**: then the piece cut out is the
  design's own shape and everything inside the outline is impressed.
- A 3D preview, a 2D preview of how the impression will look, and a watertight binary **STL**.
- **Shareable settings**: the address bar always holds a link to the current settings (only the
  ones changed from the defaults), so it can be bookmarked or sent; **Copy link** copies it. The image
  isn't part of the link. Opening a link uses its settings instead of the ones saved in your browser.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| **Design** | | |
| The design is the | Dark parts | Which side of the threshold is the design. Transparent areas count as background |
| Threshold | automatic | Otsu's method on the image; moving the slider sets it by hand |
| Smoothing | 0.15 mm | Gaussian blur before tracing; softens jagged or noisy edges |
| Line boldness | 0 mm | Grows (or shrinks) every edge of the design |
| Remove specks under | 0.5 mm² | Drops islands and holes smaller than this |
| Mirror | on | So the impression reads correctly |
| **Stamp** | | |
| In the clay | Design pressed in | Or *design stands out*: the background is raised instead |
| Shape | Outline | Outline (the design grown by the border, holes filled; separate pieces are wrapped in their convex hull), Rectangle, Circle |
| Size | 60 mm | Longest side of the whole stamp, cutter included |
| Impression depth | 1.5 mm | Height of the relief |
| Base thickness | 3 mm | |
| Border | 3 mm | Between the design and the edge (or the cutter wall) |
| Corner radius | 3 mm | Rectangle only |
| **Cookie cutter** | off | |
| Cuts along | The stamp's edge | Or *the design's outline*: the wall's inner face is the design's outer edge (holes filled), with no border. Shape and border don't apply; separate pieces each get their own wall, joined by the plate |
| Cutter height | 2 mm | Above the relief, 0–5 mm in 0.1 mm steps: the edge stands impression depth + this above the base, which is how deep it cuts |
| Open back | on | No plate behind the design: the impression details stand on the bed, and any that don't reach the cutter are held by 1.2 mm bars at the back that run straight across from wall to wall, as thick as the base (so they stay clear of the clay) |
| Ledge | 1.5 mm | A flat foot round the outside of the wall, as thick as the base |
| Wall thickness | 1.5 mm | 0.8–1.5 mm, at the plate; the outside narrows from this to the cutting edge over the impression depth |
| Cutting edge | 0.9 mm | The wall's thickness for the cutter height above the relief, straight on both sides. With a 0.4 mm nozzle and Bambu Studio's Classic wall generator, thinner edges can be skipped; Arachne prints them |
| **Advanced** | | |
| Detail | Standard | Tracing resolution: 0.2, 0.1 or 0.05 mm per pixel |
| Relief taper | 0.2 mm | How far the relief's sides lean in over its height |

## Printing and using it

Print it as it comes: face up, flat back on the bed, no supports. 0.12 mm layers keep fine detail
crisp; PLA is fine. Dust the stamp with cornstarch (or keep it slightly damp, for clay that
tolerates water) so it lets go cleanly. Lines thinner than about 0.4 mm won't print well; the
app warns about them, and *Line boldness* fixes most.

## Development

- `web/js/core/trace.js`: luminance, Otsu threshold, blur, marching squares (from gpx2stl).
- `web/js/core/stamp.js`: the geometry, with manifold-3d (WASM) loaded from jsDelivr.
- `web/js/app.js`: UI, image rasterising, 2D/3D previews. `web/js/worker.js` runs the build.
- Tests (Node 20 + Chromium): `cd tests && npm install && node stamp.mjs && node urlstate.mjs && node browser.mjs /usr/bin/chromium`.

`.github/workflows/pages.yml` deploys `web/` to GitHub Pages on pushes to `main`.
