# TODO — Architectural Roadmap

> "Demonolith, modularize, and dynamically mix."
> Pick one. Do it. Check it off. Next.

## ✅ Done
- [x] PNG pipeline: rife_ops + speedramp_png
- [x] PNG pipeline: facemorph_engine
- [x] PNG pipeline: deepdream_engine
- [x] ffprobe consolidation → app/probe.py
- [x] datamosh twins: bin/datamosh.sh deleted, shell.py → root
- [x] Static routes: extract 3 file-serving endpoints → routes/static.py
- [x] Global inputs bar: 4-input UI (video, image, pathIn, pathOut)
- [x] Global inputs: multi-file sequential processing
- [x] main.py route split: browse, media, picker

---

## 🏗️ Phase 0: The Execution Fixes (Addressing Grok's Review)
*Before doing major backend refactoring, fix the immediate footguns holding back the UI/Route split.*
- [ ] **Static Assets Routing:** Extend `routes/static.py` (or mount `StaticFiles`) to handle nested `/css/*` and `/js/*` files so the UI split doesn't 404.
- [ ] **JS Module Architecture:** Convert `app.js` to an ES module (`<script type="module">`). Establish how global state will be shared before splitting files, preventing scoping breaks.
- [ ] **CSS Extraction:** Extract `:root` variables to `base.css` first to preserve the cascade, then split layout and components.

## 🗄️ Phase 1: Unified I/O & Media Facade
*Stop haphazard temporary directories and circular imports.*
- [ ] **Media Store Facade:** Split `media_store.py` logically (cache → thumbnails → pool → projects) but maintain a unified facade (`media/__init__.py`) so routes don't break.
- [ ] **Standardized Job Workspace:** Replace arbitrary `mktemp` usage across operations with a central `JobWorkspace` class.
  - Automatically handles `/tmp/mtapi_jobs/{job_id}/`
  - Separates `frames_in/`, `frames_out/`, and `audio.aac`.
  - Ensures clean state recovery and debugging.

## ⚙️ Phase 2: The Pipeline Engine (De-monolithing Ops)
*Stop recycling the `ffmpeg` frame extraction logic in every neural/video engine.*
- [ ] **Build `VideoPipeline` Core:** Create a central pipeline class that handles:
  - FFmpeg probe & audio extraction.
  - Dumping frames to the `JobWorkspace`.
  - Managing the execution loop (parallel or sequential).
  - FFmpeg frame re-assembly and audio muxing.
- [ ] **Convert Ops to "Filters":** Refactor `deepdream_engine`, `styletransfer_engine`, and `withoutbg_engine` to remove their internal FFmpeg logic. They should become pure functions/classes that take `(frame_array)` and return `(frame_array)`.

## 🧠 Phase 3: Resource Management
*Prepare for dynamic mixing without crashing the GPU.*
- [ ] **Centralized Model Manager:** Implement an LRU cache for PyTorch/TensorFlow weights. Operations request models from the manager instead of loading them independently, preventing OOM errors when chaining effects.

## 🔀 Phase 4: Dynamic Mixing (The True Goal)
*Chain operations together dynamically.*
- [ ] **Backend Pipeline Endpoint:** Create `POST /ops/pipeline` that accepts an array of operations (e.g., `[RemoveBG, DeepDream, PixelSort]`). The `VideoPipeline` decodes the video *once*, streams frames through the filter chain, and encodes *once*.
- [ ] **UI Evolution:** 
  - Add a "Multi-Pass" UI to queue up operations sequentially.
  - *Future:* Transition from the "Tab-per-operation" paradigm to a Node-based editor for true composability.

## ✨ Phase 5: New Features & Specs
*Build on top of the modular architecture.*
- [ ] **CivitAI Cloud Gen:** Implement `civitai_ops.py` (Spec: `civitai-spec.md`).
- [ ] **FFglitch Scripts:** Implement Pixel Sort & MV Pan in `ffglitch_ops.py` (Spec: `ffglitch-spec.md`).
- [ ] **ASCII Render:** Implement `ascii_ops.py` via the new Pipeline Engine (Spec: `ascii-spec.md`).
- [ ] **Speed Ramp E2E:** Full speedramp integration (M4).
- [ ] **Rubberband Audio v2:** Enhanced audio stretching (M6).

## 🧹 Housekeeping
- [ ] Global inputs: status indicators (✅ ❌ ✔️)
- [ ] Global inputs: Path in directory scanning, Path out output override
- [ ] Global inputs: file existence verification before processing
- [ ] Global inputs: stop between iterations
- [ ] main.py route split: pool routes (state, save, load, last, match, scan)
- [ ] main.py route split: watcher, jobs, health
