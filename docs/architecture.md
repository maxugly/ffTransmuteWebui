# System Architecture

> **Status:** Active Reference
> **Scope:** `/home/m/snc/cod/ffTransmuteWebui/mtapi-project`

This document maps the entire codebase for onboarding agents. It explains what each module does, how they fit together, and their dependencies.

---

## 1. Entrypoints & Core Startup

- **`run.py`**: The main entrypoint. Starts the `uvicorn` server (port 24590).
- **`app/main.py`**: Initializes the FastAPI application, sets up middleware, and includes all routers.
- **`bin/`**: Contains standalone executables and scripts.
  - `transmute`: Bash script for pixel-exact geometry ops.
  - `custom_glitch.js`: `ffglitch` ECMAScript module for vector destruction.

---

## 2. Core System (`app/`)

This layer handles the non-domain-specific infrastructure of the application.

- **`contract.py`**: Defines Pydantic models (e.g., `OperationResult`) ensuring a unified response format across all API endpoints.
- **`job_control.py`**: Manages cancellation tokens and progress state for long-running operations.
- **`pathutil.py` / `output_dir_ctx.py`**: Ensures output files are named uniquely without overwriting, and manages context variables for output directories.
- **`shell.py`**: Safe wrapper for spawning subprocesses (e.g., `ffmpeg`) using `create_subprocess_exec` instead of `shell=True`.
- **`probe.py`**: Wrappers around `ffprobe` for extracting media metadata (fps, dimensions, duration).
- **`watcher.py`**: Background filesystem watcher for tracking new file events.

---

## 3. Video Pipelines (3 files)

Handles the `dump -> process -> encode` pattern for neural and frame-by-frame operations.

- **`app/video_pipeline.py`**: The unified, modern pipeline (Phase 4). Handles the entire lifecycle from dumping frames to re-encoding.
- **`app/job_workspace.py`**: Manages isolated `/tmp/mtapi_jobs/{job_id}/` directories (`frames_in/`, `frames_out/`) to prevent collisions.
- **`app/png_pipeline.py`**: The legacy pipeline. Currently being migrated to `video_pipeline.py`.

---

## 4. Media Facade (`app/media/` - 8 files)

Handles the persistence, tracking, and organization of generated media.

- **`__init__.py`**: Exposes the media facade API.
- **`cache.py`**: Core caching logic.
- **`config.py`**: Media configuration constants.
- **`match.py` / `open.py`**: File matching and local opening utilities.
- **`pool.py`**: Session pool state — **videos** (`items[]`) + **stills** (`images[]`) + sequence (v2 JSON).
- **`projects.py`**: Named `.ffproject.json` files (same payload; preferred on restore).
- **`thumbnails.py`**: Absolute first/last + **per-frame** range thumbs (`range_thumbs/`) via `ffmpeg`.

---

## 5. Routes (`app/routes/`)

Maps HTTP endpoints to underlying services.

- **`media.py` / `pool.py`**: Exposes Media Facade over HTTP.
- **`browse.py` / `picker.py`**: File browsing endpoints.
- **`meta.py`**: Health checks and metadata retrieval.
- **`static.py`**: Serves the WebUI (`app/static/`).

---

## 6. Operations & Engines (`app/operations/`)

The core manipulation logic. Operations (`*_ops.py`) define FastAPI endpoints and request models. Engines (`*_engine.py`) handle the heavy lifting (loading weights, processing frames).

- **`datamosh/` (7 files)**: Advanced MPEG-2 glitching using `ffgac` and `ffedit`.
  - `classic.py`, `common.py`, `destruct.py`, `hijack.py`, `melt.py`, `mv_hack.py`.
- **`deepdream_ops.py` / `deepdream_engine.py`**: Inception-based frame dreaming (temporal blending, ouroboros).
- **`facemorph_ops.py` / `facemorph_engine.py`**: Two-input facial morphing using `dlib`.
- **`styletransfer_ops.py` / `styletransfer_engine.py`**: Neural style transfer using TF-Hub/Magenta.
- **`withoutbg_ops.py` / `withoutbg_engine.py`**: Background removal using local ONNX weights or cloud API.
- **`rife_ops.py`**: Slow-motion interpolation using `rife-ncnn-vulkan`.
- **`speedramp_ops.py`**: Variable speed remapping.
- **`transmute_ops.py`**: Basic geometry ops passing through to the `transmute` bash script.

---

## 7. Web UI (`app/static/` - 22 JS Modules)

Vanilla HTML5/CSS3/ES6 single-page application. No build step (Webpack/React).

**Structure:**
- **`index.html`**: The main interface layout.
- **`css/`**: Styling modules (`base.css`, `console.css`, `forms.css`, `layout.css`, `modals.css`, `pool.css`).

**JavaScript Modules (22 files):**
- **Core (`js/`)**:
  - `main.js`: Primary initialization.
  - `job-control.js`: Polling and cancellation of background tasks.
  - `preview.js`: Media preview player.
  - `timeline.js`: Sequence timeline management.
  - `utils.js`: Helper functions.
- **UI Components (`js/ui/`)**:
  - `knobs.js`: Custom interactive UI elements.
- **Libraries (`js/pool/`)**:
  - `grid.js` / `items.js` / `sequence.js` — **Video Pool** + sequence stitch.
  - `image-pool.js` — **Image Pool** (stills only).
  - `persistence.js` — session + project JSON v2 (`items` + `images`).
  - `constants.js` — `VIDEO_EXTS` / `IMAGE_EXTS`; `chrome.js`, `layout.js`.
  - As-built: `docs/video-image-pools-spec.md`.
- **Operation Tabs (`js/tabs/`)**:
  - `cut.js` — Cut workspace (global video + frame range + ref stills; no encode yet).
  - `datamosh.js`, `deepdream.js`, `facemorph.js`, `quick.js`, `rife.js`, `styletransfer.js`, `transmute.js`, `watcher.js`, `withoutbg.js`, `convert.js`.
  - Each file binds the form inputs for a specific operation tab to the corresponding API endpoint.
- **Global timeline (`js/timeline.js`)**: Probe + frame-range sliders; events `mtapi:frame-range` / `mtapi:video-probed`.
