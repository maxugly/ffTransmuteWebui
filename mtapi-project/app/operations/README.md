# operations — Operation Schemas & Handlers

The `operations` subpackage defines every tool operation exposed by `mtapi-project`. Each operation is a self-contained module registering an `OperationSpec` into the global registry via `register()` at import time.

---

## File structure

```
operations/
├── __init__.py              # Imports all *_ops modules → populates REGISTRY
├── transmute_ops.py         # transmute CLI (geometry, join, fit, frames…)
├── datamosh_ops.py          # datamosh melt / classic / hijack / residual / MV
├── deepdream_ops.py         # DeepDream image/video + ouroboros
├── deepdream_engine.py      # TF/Keras multi-model dream engine
├── facemorph_ops.py         # Face morph chain (+ optional DeepDream)
├── facemorph_engine.py      # dlib landmarks + Delaunay wrapper
├── withoutbg_ops.py         # Background removal
├── withoutbg_engine.py      # withoutbg local/API + mask/bg exports
├── styletransfer_ops.py     # Magenta arbitrary neural style transfer
└── styletransfer_engine.py  # TF-Hub stylization model
```

---

## Operations

### Transmute (`transmute_ops.py`)
Wraps `bin/transmute`. Named single-purpose ops:
- Frames / audio: `first_frame`, `last_frame`, `extract_audio`
- Geometry: `crop_16x9`, `letterbox_16x9`, `square_crop`, `square_letterbox`, `crop_exact`, `stretch_exact`, `reverse`
- Multi-clip: `join`, `grid` (pad | crop | stretch + aspect)
- Single-clip reformat: `fit` (same canvas logic as join with one file — Quick Transmute)
- Escape hatch: `transmute_raw`

### Datamosh (`datamosh_ops.py`)
Python pipeline around ffgac / ffedit / custom glitch JS:
- `datamosh_melt`, `datamosh_classic`, hijack, residual destruct, motion-vector hack

### DeepDream (`deepdream_ops.py` + engine)
- Models: InceptionV3, VGG16, ResNet50 (ImageNet)
- Layer presets, octaves, optical-flow video coherence, guided dream
- Ouroboros: still → feedback video (zoom / rotate / translate)
- Progress + cooperative cancel via `job_control`

### Face Morph (`facemorph_ops.py` + engine)
- Depends on external package at `FACEMORPH_ROOT` (default `~/snc/cod/facemorph`)
- dlib 68 landmarks + Delaunay morph video
- Detection: HOG → YuNet → content-bbox (stylized / cutout faces)
- Optional `dream_mode`: none | after | faces_first

### withoutBG (`withoutbg_ops.py` + engine)
- Local open weights (~455 MB once) or Cloud API (`WITHOUTBG_API_KEY`)
- Independent knobs: **cutout** (RGBA), **mask** (alpha L), **background** (leftover scene)

### Style Transfer (`styletransfer_ops.py` + engine)
- Magenta arbitrary stylization (TF-Hub, ~90 MB)
- Content image(s) + any style reference image
- Strength blend + max_side for RAM/speed

---

## Shared helpers

| Module | Role |
|--------|------|
| `app/shell.py` | Subprocess helpers: `run_command`, `parse_line`, `ensure_video_output_path`, `probe_duration` |
| `app/pathutil.py` | Never-overwrite outputs: `name.ext` → `name_0001.ext`, `name_0002.ext`… Related sets (cutout/mask/bg) share one sequence number |
| `app/job_control.py` | Job tokens, cancel, progress polling (`X-Job-Token`, `GET /api/job/{token}`) |
| `app/job_workspace.py` | **New.** Isolated per-job `/tmp/mtapi_jobs/{job_id}/` workspace (frames_in, frames_out, audio, metadata) |
| `app/video_pipeline.py` | **New.** Unified probe→dump→process→encode pipeline. `filter_fn` is the only thing ops provide |
| `app/png_pipeline.py` | **Deprecated.** Old pipeline still used by existing engines (deepdream, facemorph, rife, withoutbg, styletransfer). New ops use `VideoPipeline`+`JobWorkspace` |

## Dual-path coexistence

If your op uses `PngFramePipeline`, it's on the **old path**. New ops use `VideoPipeline` + `JobWorkspace`. Phase 4 will migrate engines one at a time (rife → withoutbg → styletransfer → facemorph → deepdream). Old engines remain functional during migration.

---

## Adding a new operation

1. Add `*_ops.py` (and optional `*_engine.py`) with Pydantic params + async handler → `OperationResult`.
2. `register(OperationSpec(...))` at module bottom.
3. Import the module in `__init__.py`.
4. Wire a UI tab in `static/` if users need knobs (optional — OpenAPI `/docs` always works).

Failures that are “operation failed” return HTTP 200 with `"ok": false`.
