# Vectorize Tab Spec — Raster → SVG
*Status: draft spec (builder not started). Writer hat only — docs/.*

## 1. Context & Constraints (this repo)
- Platform: FastAPI (`mtapi-project/app/main.py`, uvicorn `24590`) + vanilla HTML5/CSS3/ES6 SPA (`app/static/`). No React/Svelte/Tailwind (AGENTS.md §7).
- Filter platform invariant (§1): ops `app/operations/`, filters `app/filters/`, routes `app/routes/`. Mid-chain PNG `frame_%06d.png` if needed; here output is SVG.
- Subprocesses: `shell.run_command` / argv lists. NEVER `shell=True`. See `app/shell.py`.
- Paths: absolute I/O; `transmute` prints `Output:` / `Command:`.
- Dual pools stay separate; this is a new Image-pool operation (not video cut).
- Progress: `report_progress()` per item.
- WebUI proof: Playwright click before DONE; gate `./check-gate.sh` first (§12).
- Reference pipeline: https://github.com/akovall/Vectra (Rust CLI + WASM bindings + SVG output).

## 2. Scope
Local-only web UI tab named **"Vectorize"** (route `/vectorize`). Converts raster images (`png`/`jpg`) to SVG via pluggable engines.

### Engines (each toggleable)
1. **Vectra / VTracer** (Rust CLI `vtracer` or Python `vtracer`).
   - Options: preset (`bw`/`poster`/`photo`), color count, layering, corner threshold, path precision, speckles filter, skip black/white, tesselation, quantization (`median-cut`/`xiaolin-wu`), color distance, max iterations, min area.
   - Invocation: `python -m vtracer` or `vtracer` CLI via `shell.run_command`.
2. **Inkscape** (CLI `inkscape --export-type=svg --export-trace-*`).
   - Options: trace mode (`brightness-cutoff`/`edge-detection`/`color-quant`), colors, smooth, speckles, post-optimize/remove-overlaps, DPI, threshold.
   - Must detect `inkscape` path (`which` or `shutil.which`); fail gracefully if missing.
3. **Neural / ML (optional, GPU)**
   - Pre-proc (OpenVINO lazy): Real-ESRGAN OR U²-Net/SAM segment (ONNX → IR).
   - Core: DiffVG-style differentiable loop (PyTorch, GPU required). Options: num shapes, iterations, LR, stroke width, color quant, shape reg.
   - Auto-disable if no GPU; show UI message `"GPU not detected — neural disabled"`.

## 3. Architecture (fastapi + vanilla JS)
```
upload (drag/file picker) -> /vectorize/upload (save temp PNG)
       |
       v
orchestrator (async/threadpool) -> engine registry manifest
       |-- VTracer subprocess (output SVG)
       |-- Inkscape subprocess (output SVG)
       |-- Neural (lazy OpenVINO + PyTorch loop, only if enabled + GPU)
       |
       v
results (side-by-side SVG inline <svg> render + download + ZIP)
```

### Backend layout (`mtapi-project/app/`)
- `routes/vectorize.py` — upload, run, results, download.
- `operations/vectorize_ops.py` — orchestrator, engine registry loader.
- `filters/vectorize_engine.py` — engine manifest parser (JSON per engine).
- `media/pool.py` — pool save also writes to named project if open (`items[]` + `images[]` per invariant 5); new SVG outputs go to `images[]`.

### Engine registry (manifest per engine)
File: `mtapi-project/app/filters/vectorize_engines/vtracer.json`, `inkscape.json`, `neural.json`.
Schema per manifest:
```json
{
  "id": "vtracer", "name": "Vectra VTracer",
  "enabled_default": true,
  "dependencies": {"binary": "vtracer", "gpu": false, "openvino": false},
  "options": [
    {"key":"preset","type":"select","choices":["bw","poster","photo"],"default":"photo"},
    {"key":"color_count","type":"int","min":2,"max":64,"default":16},
    ...
  ],
  "execute": "operations.vectorize_ops.run_vtracer"
}
```

### Orchestrator (`operations/vectorize_ops.py`)
- Accept `enabled_ids[]` + per-engine option dict.
- Runs enabled engines in parallel (`asyncio.gather` or `ThreadPoolExecutor`; never `shell=True`).
- Per-engine errors caught; others continue.
- Collect outputs to temp dir; return `results[]` with `engine_id`, `svg_path`, `elapsed_s`, `bytes`.

### OpenVINO runtime
- Lazy load: first neural invocation triggers `openvino.runtime.Core` init (device `CPU` / `GPU`).
- Cache compiled IR in `mtapi-project/data/openvino/cache/`.
- Neural engine disabled if `torch.cuda.is_available()` false; UI shows disabled state.

## 4. Frontend (vanilla ES6, no framework)
New tab root: `app/static/js/tabs/vectorize.js` + `app/static/index.html` entry (tab button).

### Component tree (vanilla modules)
- `vectorize.js` — tab init, drag-drop handler, engine panel render.
- `vectorize/engines.js` — toggle UI, dependency status (calls `/vectorize/status`).
- `vectorize/options.js` — render options from manifest JSON (sliders/inputs/selects/checkboxes); dynamic per engine.
- `vectorize/run.js` — "Run" button → POST `/vectorize/run` with payload `{enables:[...], options:{...}}`; show per-engine progress (poll `/vectorize/progress/{job_id}` or use SSE; minimal: poll every 500ms).
- `vectorize/results.js` — side-by-side `<svg>` inline renders (use `fetch` → `DOMParser` → inject `<svg>` nodes, not `<img>`). Each card: engine name, time, size, download button.
- `vectorize/compare.js` — overlay/blend slider (opacity CSS on two `<svg>` elements stacked) or diff view (optional v2).
- `vectorize/export.js` — ZIP via `/vectorize/download?job_id=...` or individual buttons.
- `vectorize/log.js` — collapsible console (`<pre>`) showing stdout/stderr per engine.

### UI layout
- Left sidebar (25%): Engine toggles + dependency status + "Run".
- Center: Upload zone + progress.
- Right: Results grid (2-col default, responsive). Comparison mode activates overlay slider.

## 5. API Contract (FastAPI)
```
POST /vectorize/upload          -> {job_id, temp_png_path}
GET  /vectorize/status          -> {engines: [{id,status,available,reason}], openvino_device}
POST /vectorize/run             body={enabled:[str], options:{engine_id:{k:v}}} -> {job_id}
GET  /vectorize/progress/{job_id} -> {job_id, status, engines:[{id,state,pct,error?}], finished:boolean}
GET  /vectorize/results/{job_id} -> {results:[{engine_id,svg_path,elapsed_s,bytes}], zip_url?}
GET  /vectorize/download/{job_id}?format=zip -> file
GET  /vectorize/download/{job_id}?engine=vtracer -> file
```
Errors: HTTP 200 + `{"ok": false, "error": "..."}` per invariant 10.

## 6. Data Flow (spec artifact)
```
Upload PNG (drag/file picker) -> save temp workspace
 -> /vectorize/run (orchestrator reads manifest)
   -> VTracer CLI (subprocess) -> SVG_A
   -> Inkscape CLI (subprocess) -> SVG_B
   -> Neural (lazy OpenVINO + PyTorch) -> SVG_C (if GPU)
 -> results / download / ZIP
```

## 7. File / Temp Handling
- Temp workspace per job: `/tmp/fftransmute_vectorize/{job_id}/`.
- Inputs: `input.png`. Outputs: `{engine_id}.svg`. Clean on job complete (or keep 10 most recent).
- Pool integration: if named project open, also write SVG results to project `images[]`.

## 8. Error Handling Matrix
| Engine | Failure | Behavior | UI |
|---|---|---|---|
| VTracer | binary missing | skip, other engines run | warning badge |
| Inkscape | `inkscape` missing | skip, warning | badge + install hint |
| Neural | no GPU | auto-disable, message | disabled toggle |
| Neural | OpenVINO model missing | lazy-download once (cached) | progress bar |
| Neural | GPU OOM | retry with reduced shapes, else error | error card |
| Any | subprocess timeout (>limit) | kill, report, continue batch | error card |

## 9. Non-Functional / Invariants
- No cloud calls except model download (cached, one-time).
- All processing local; progress `report_progress()` every item.
- Subprocess: argv list only; no `shell=True`.
- Pixel integrity: SVG outputs are vector; no scaling unless asked (`-x` analog not applicable).
- If panel uses PNG intermediates for preview, use `frame_%06d.png` convention.

## 10. Tech Stack (adapted to repo)
- Backend: Python FastAPI (`mtapi-project/app/`). Subprocess via `app/shell.py`.
- OpenVINO: `openvino` pip package; lazy import.
- Neural: `torch` lazy import (only when neural enabled + GPU present).
- Vectorization CLI: `vtracer` (Rust binary), `inkscape` (system).
- Frontend: vanilla ES6 modules (`app/static/js/tabs/vectorize/`). No npm.
- Build proof: Playwright test `tests/test_vectorize.py` before claiming DONE (gate first).

## 11. Deliverables (this spec stage)
- [ ] `docs/vectorize-tab-spec.md` (this file) — done.
- [ ] `docs/filter-platform-spec.md` reference check (filter/op/route split) — done.
- [ ] Manifests: `app/filters/vectorize_engines/*.json` (builder stage).
- [ ] API: `app/routes/vectorize.py` (builder stage).
- [ ] Ops: `app/operations/vectorize_ops.py` (builder stage).
- [ ] UI: `app/static/js/tabs/vectorize.js` + sub-modules (builder stage).
- [ ] Tests: `mtapi-project/tests/test_vectorize.py` (builder stage, gate required).

## 12. References
- Vectra pipeline: https://github.com/akovall/Vectra (Rust CLI, WASM bindings).
- OpenVINO docs: https://docs.openvino.ai/
- DiffVG: https://github.com/Bearwithme/DiffVG (differentiable vector graphics — loop only, not inference).
- AGENTS.md: filter platform, dual pools, webUI proof, deprecations, versioning.
