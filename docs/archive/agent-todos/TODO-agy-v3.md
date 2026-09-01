# TODO-agy-v3 — The Filter Graph Execution Plan

> **Author**: agy · **Date**: 2026-07-27  
> **Purpose**: A stripped-down, builder-focused checklist derived from the consensus in `TODO-grok-v2.md`. All the meta-debate ("who won what", "tom vs grok") has been removed. This is the raw execution path to turn the monolith into a dynamic filter graph.
> **Rule**: One commit per item. Verify before proceeding.

---

## 🛑 Phase 0: Infrastructure Safety (Must Do First)
*If you skip this, the UI extracts will crash.*

- [ ] **0.1 Nested Static Assets**: Update `routes/static.py` to recursively serve `/css/*` and `/js/*`. 
- [ ] **0.2 ES Module Base**: Convert `app.js` to `<script type="module" src="js/main.js">`. Use standard `import/export` for state. Do not use classic multi-scripts. 
- [ ] **0.3 CSS Tokens**: Extract `:root` and resets to `css/base.css`. Link it first.

---

## 🧹 Phase 1: Easy Wins & Cleanups
*Clear the underbrush before deep refactoring.*

- [ ] **1.1 Datamosh Twins**: Delete `bin/melt.js` and `bin/no_keyframe.js`. Point `MELT_JS` and `NO_KEYFRAME_JS` in `datamosh_ops.py` to the root directory copies.
- [ ] **1.2 Cancel Audit**: Expand `check_cancelled()` to cover the shared `datamosh` pipeline stages.
- [ ] **1.3 Sync Root TODO**: Clear all phantom items (e.g., watcher split, pool routes) from the root `TODO.md` to reflect what is actually done.

---

## 📦 Phase 2: Component Isolation (Parallel Tracks OK)
*(Single builders: Do F → D → M sequentially. Teams: Parallel is fine).*

### Track F: Frontend Modularization
- [ ] **F.CSS**: Extract CSS in this order: `layout`, `forms`, `console`, `modals`, `pool`, `ops`. Delete `style.css`.
- [ ] **F.JS**: Extract JS in this order: `state`, `elements`, `knobs`, `global-inputs`, `api`, `filebrowser`, `router`, `ui/*` (neural tabs), `ui/pool/*` (grid, sequence, playback, persist, match), `run.js` (collectors), `preview.js`.

### Track D: Datamosh Split
- [ ] **D.1 Pipeline**: Extract `_execute_mosh_pipeline` and `_trim_and_mosh` to `operations/datamosh/common.py`.
- [ ] **D.2 Modes**: Split melt, classic, hijack, destruct, mv_hack into thin, individual handlers. Update the registry.

### Track M: Media Facade
- [ ] **M.1 The Facade**: Create `app/media/__init__.py` to re-export the public API. Update all routes to import from this facade so nothing breaks.
- [ ] **M.2 The Split**: Break `media_store.py` into: `cache.py`, `thumbnails.py`, `pool.py`, `match.py`, `projects.py`, and `open.py` (orchestrator). *Never put `open_media` inside `cache.py`.*

---

## ⚙️ Phase 3: The Unified Pipeline Engine
*Once the surrounding I/O is stable, kill the duplicated FFmpeg loops.*

- [ ] **3.1 JobWorkspace**: Create `app/job_workspace.py` handling `/tmp/mtapi_jobs/{job_id}/` (frames_in, frames_out, audio). Replace ad-hoc `mktemp` in one pilot operation.
- [ ] **3.2 VideoPipeline Core**: Evolve `PngFramePipeline` to handle probe → dump → loop hook → encode → mux. 
  - *Verify: Pass `/tmp/teste.mp4` through an "identity" pass (copies frames unchanged). Ensure video + audio return intact.*

---

## 🔄 Phase 4: Op-to-Filter Conversion
*Migrate the engines. Keep the old paths alive until the cutover is complete.*

- [ ] **4.1 Convert rife_ops** (Simplest fit)
- [ ] **4.2 Convert withoutbg**
- [ ] **4.3 Convert styletransfer**
- [ ] **4.4 Convert facemorph**
- [ ] **4.5 Convert deepdream** (Hardest: temporal/ouroboros)

---

## 🧠 Phase 5: Dynamic Mixing & Resource Management
*The architectural payoff.*

- [ ] **5.1 Model Manager**: Build LRU VRAM caching for heavy models. (Wait until at least two heavy models are converted to filters).
- [ ] **5.2 POST /ops/pipeline**: Create the backend endpoint that accepts a JSON array of filters, decodes once, processes through RAM, and encodes once.
- [ ] **5.3 Multi-Pass UI**: Build the frontend queue to stack operations and post to the pipeline endpoint.

---

## ✨ Phase 6: New Features
*Build on the new bedrock.*

- [ ] **6.1 CivitAI**: Cloud generation suite. (Unblocked after Track M facade).
- [ ] **6.2 ASCII Render**: Implement via the new VideoPipeline.
- [ ] **6.3 FFglitch**: Pixel sort & MV pan.
- [ ] **6.4 Speed ramp E2E**
- [ ] **6.5 Rubberband audio v2**
