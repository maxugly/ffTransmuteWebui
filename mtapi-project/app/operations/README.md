# operations — Operation Schemas & Handlers

Typed ops exposed by `mtapi-project`. Each module registers an `OperationSpec` into `contract.REGISTRY` at import time via `operations/__init__.py`.

**Platform direction:** frame effects are **filters** + thin ops. Bookends are **video_pipeline** / **convert_presets**. See `docs/filter-platform-spec.md` and `app/filters/AGENTS.md`.

---

## Layout

```
operations/
├── __init__.py              # Imports → populates REGISTRY
├── transmute_ops.py         # Geometry / frames / join / grid / raw CLI
├── convert_ops.py           # Convert / Export bookends
├── pipeline_ops.py          # POST /ops/pipeline — stage chain
├── rife_ops.py              # Thin → filters/rife (directory)
├── deepdream_ops.py         # Thin video path → filters/deepdream; image/ouroboros special
├── deepdream/               # TF engine (dream_image, flow helpers)
├── facemorph_ops.py         # Face morph (⚠️ peel later)
├── withoutbg_ops.py         # BG remove (⚠️ peel later)
├── styletransfer_ops.py     # Magenta style (⚠️ peel later)
├── speedramp_ops.py
└── datamosh/ …              # File-level glitch
```

Related (not under operations/):

```
app/filters/           # Stage factories (rife, deepdream, …)
app/video_pipeline.py  # dump / process / encode
app/convert_presets.py # Codec & frames_* recipes
app/pipeline_chain.py  # Multi-stage runner
```

---

## Patterns

### Frame effect (preferred)

1. `app/filters/<name>.py` — factory + `register_stage`  
2. Thin `*_ops.py` — dump → stage → encode  
3. Same factory for `/ops/pipeline`

| Op | Stage | Kind |
|----|-------|------|
| rife | `filters/rife.py` | directory |
| deepdream (video) | `filters/deepdream.py` | per_frame |
| convert | — | bookends only |
| pipeline | registry | mix |

### CLI / file-level

`transmute_ops`, datamosh — `run_command`, cwd rules, no fake filter stage.

### Still thick (migration queue)

withoutbg, styletransfer, facemorph — work, but still own more than a pure stage. Peel using RIFE/DeepDream as templates.

---

## Operations summary

### Convert (`convert_ops.py`)
- Targets: ProRes, DNxHR, H.264/AVC, H.265/HEVC, VP9, AV1, FFV1, `frames_{png,webp,jpg,tiff}`
- GIF + image-folder import; silent audio when needed
- UI: **Convert / Export** tab

### Pipeline (`pipeline_ops.py`)
- `filters: [{name, params}, …]`
- Resolves `app.filters` + local `identity`
- Directory + per_frame stages

### Transmute (`transmute_ops.py`)
- Geometry, first/last frame, audio extract, join/grid, raw flags

### Datamosh
- File-level MPEG corruption — **not** mid-chain PNG filters

### DeepDream / RIFE
- See filter modules; thin ops

### Face Morph / withoutBG / Style Transfer
- Engines present; filter peel pending

---

## Shared helpers

| Module | Role |
|--------|------|
| `app/shell.py` | `run_command`, path helpers |
| `app/pathutil.py` | never-overwrite outputs |
| `app/job_control.py` | cancel + progress |
| `app/job_workspace.py` | per-job temp tree |
| `app/video_pipeline.py` | probe / dump / process / encode |
| `app/convert_presets.py` | encode & dump presets |
| `app/png_pipeline.py` | **Deprecated** — do not use for new code |

---

## Adding an operation

1. Choose kind: frame stage / CLI / convert preset.  
2. Frame stage → `filters/` + thin ops (see `operations/AGENTS.md`).  
3. `register(OperationSpec)` + `__init__.py` import.  
4. Optional UI tab.  
5. Smoke `/tmp/teste.mp4`.  
6. Bump root `VERSION`.

Failures that are “operation failed” return HTTP 200 with `"ok": false`.
