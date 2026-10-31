# Photo → SVG Icon Workbench — Spec

> Status: Proposed
> Kind: A (image batch — single-image op; stills variant of the filter-platform pattern, no video bookends)

## Problem

Turning a photo into a usable SVG icon is manual tedium: flatten/simplify the
image in one tool, trace it in another, then repeat the whole thing at several
simplification levels for different icon sizes. Existing tracers (Vector Magic,
vectorizer.ai, Illustrator Image Trace, vtracer) are faithful converters, not
icon generators — none take a photo in and emit an icon family at multiple
detail levels. The flattening judgment (which colors merge, how much detail
survives) is where quality lives, and today it has no workbench.

## Goals / Non-goals

**Goals**

- One tab: photo in, family of SVG icons out at 3 detail levels (high/med/low).
- Live slider preview of the flatten step (<500ms re-render); vectorize only on
  explicit commit.
- Reuse existing segmentation: rembg subject mode, SAM scene mode, full frame.
- vtracer as the only new dependency (`pip install vtracer`).
- House rules honored: absolute paths, `OperationResult`, no `shell=True`,
  never overwrite outputs.

**Non-goals**

- No diffusion/GPU generation in the flatten path (v1 is deterministic CPU).
- No SVG post-editing after trace (not a vector editor).
- Video input (stills only).

## User story

1. User opens the Icon tab; picks an image from the Image Pool (global image bar).
2. Chooses segmentation mode: full frame / subject (rembg) / scene (SAM).
3. Drags flatten sliders (color count, smoothing); raster preview re-renders live.
4. Picks trace options (curve mode, speckle filter); hits **Vectorize**.
5. Server runs vtracer at 3 detail presets; three SVGs render inline
   (high/med/low), each with a download link.
6. Cancel button aborts a long vectorize; partial outputs are discarded.

## Classification

Kind **A**, image batch (precedent: `withoutbg` image mode — `docs/withoutbg-spec.md`).
No dump/encode bookends (still image, not video); follows op conventions
(absolute paths, `OperationResult`, argv-only subprocesses, unique outputs).

## Data & params (JSON)

`POST /ops/svg_icon_preview` — flatten only, returns raster PNG (base64).
`POST /ops/svg_icon_vectorize` — full run, returns SVG strings + file paths.

```json
{
  "image_path": "/abs/path/photo.jpg",
  "mode": "full | subject | scene",
  "flatten": {
    "engine": "opencv | imagemagick",
    "colors": 8,
    "bilateral_d": 9,
    "bilateral_sigma_color": 75,
    "bilateral_sigma_space": 75
  },
  "trace": {
    "curve_mode": "pixel | polygon | spline",
    "filter_speckle": 4,
    "color_precision": 6,
    "hierarchical": "stacked | cutout"
  },
  "detail_levels": ["high", "med", "low"],
  "preview_width": 400
}
```

Validation: `colors` 2–16; `image_path` absolute and exists; `mode=scene`
requires GPU (else honest `ok:false`).

## Architecture

- **Reuse first:** Image Pool input; `filters.withoutbg` (rembg); SAM masks from
  the Vision tab; `OperationResult`; `shell.run_command`; unique output paths.
- **New:** `svg_icon` op module. Flatten stage (OpenCV bilateral + k-means;
  PIL median-cut for the fast preview path; ImageMagick `-paint`/`-posterize`
  as the artsy alternative) → vtracer via Python API
  (`convert_pixels_to_svg`, no subprocess; CLI fallback if import missing).
- Preview route returns PNG; vectorize route writes
  `*_icon_{high,med,low}.svg` beside the input (never overwrite) and returns
  the SVG strings for inline render.
- Long vectorize runs through existing job control (cancel/progress).

## Files to touch

- backend: `mtapi-project/app/operations/svg_icon_ops.py` (new),
  `mtapi-project/app/routes/svg_icon.py` (new)
- frontend: `mtapi-project/app/static/js/tabs/svgicon.js` (new),
  `mtapi-project/app/static/css/svgicon.css` (new), `index.html` (nav),
  `app.js` (wiring)
- docs: `docs/photo-to-svg-icon-workbench-spec.md` (this file)
- tests: `mtapi-project/tests/test_svg_icon.py` (new)

## UI sketch

- Tab placed near Image Pool / Vision tabs.
- Left: mode radio (full/subject/scene) + flatten sliders (colors, smoothing)
  + trace selects (curve mode, speckle, precision).
- Center: live raster preview, debounced ~200ms POST on slider input.
- Right: **Vectorize** button → three inline SVG previews (high/med/low) +
  download link each.
- Empty state: "Pick an image from the Image Pool." Error state: `ok:false`
  message surfaced, never silent.
- Input comes from the global image bar — no private path field (house rule).

## Edge cases

- Huge input → downscale working copy for preview; commit on full res with progress.
- No GPU → scene (SAM) mode disabled with an honest message; subject/full work.
- vtracer not installed → `ok:false` naming the pip package.
- 1–2 color input → still valid; icon family may collapse (acceptable).
- Tiny input (<64px) → upscale warning; pixel curve mode recommended.
- Cancel mid-vectorize → partial outputs discarded, workspace clean.
- Video file supplied → rejected with message (stills only).

## Acceptance tests

- Backend: `/tmp/teste.png` smoke — preview returns PNG in <500ms; vectorize
  returns 3 valid SVGs with path counts strictly decreasing high → low;
  `ok:false` when vtracer is missing (mocked import).
- WebUI: tab renders, sliders re-render preview, Vectorize submits, 3 SVGs
  inline + downloads, **zero JS console errors** (Playwright real clicks).
- Gate: 5/5 per house `./check-gate.sh`.

## Out of scope / follow-ups

- SAM tuning UI (points-per-side, stability threshold, min mask area).
- Canny edge overlay as a separate SVG layer.
- Palette locking across the icon family.
- Per-region variable flattening ("smash" controls).

## Risks

- vtracer Python API vs CLI drift across versions — pin the version in
  requirements; prefer API with CLI fallback.
- SAM scene-mode VRAM on small GPUs — cap mask input resolution, document it.
- k-means nondeterminism run-to-run — seed it; preview (median-cut) vs commit
  (k-means) may differ slightly, which is acceptable and documented.
