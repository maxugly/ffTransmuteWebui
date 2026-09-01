# TODO-agy-v2 — The Filter Graph Migration

> **Author**: agy · **Date**: 2026-07-27  
> **Purpose**: This plan synthesizes Grok's rigorous execution safety protocols with the ultimate architectural goal: transforming `ffTransmuteWebui` from a collection of monolithic tabs into a dynamic, composable **Filter Graph**.

---

## 🎯 The Prime Directive
We are moving from **Monoliths → Isolated Packages → Unified Pipeline → Dynamic Graph**.
To survive this transition without breaking the `main` branch, we must execute the **Grok Safety Protocols** (Phase 0 and Phase 1) before we touch a single line of FFmpeg orchestration in the engines.

---

## 🛡️ Phase 0: Infrastructure Safety (The Grok Protocol)
*Solve the execution footguns before attempting any splits.*
- [ ] **0.1 Nested Static Routing**: Update `routes/static.py` to recursively serve `/css/*` and `/js/*`. *(Verifies: `/css/_ping.css` returns 200).*
- [ ] **0.2 ES Module Strategy**: Convert `app.js` to `<script type="module" src="js/main.js">`. Establish global state (`window.state`, `window.elements`) before splitting files so scoping doesn't break.
- [ ] **0.3 CSS Base Extraction**: Extract `:root` tokens and resets to `css/base.css` to preserve the cascade before chopping up layout files.

---

## 📦 Phase 1: Component Isolation (Tracks M, D, F)
*Chop the 1,000+ line monoliths into packages safely. These can be parallelized.*

### Track M: Media Facade (Backend Risk #1)
- [ ] Create `app/media/__init__.py` as a facade that re-exports `media_store.py`'s current API.
- [ ] Split `media_store.py` into `cache.py`, `thumbnails.py`, `pool.py`, `projects.py`, and `open.py`. *(Crucial: `open_media` must not live in `cache.py`).*

### Track D: Datamosh Package
- [ ] Extract the shared FFmpeg orchestration (`_execute_mosh_pipeline`, `_trim_and_mosh`) into `operations/datamosh/common.py`. Add cancel hooks (`job_control`).
- [ ] Split the 5 modes (melt, classic, hijack, etc.) into separate thin handlers.

### Track F: Frontend Modules
- [ ] Extract CSS progressively (`layout`, `forms`, `console`, `pool`, `ops`).
- [ ] Extract JS modules sequentially, leaving `ui/pool/` (the 3k line beast) and `run.js` (the giant switch statement) for last.

---

## ⚙️ Phase 2: The Unified Pipeline (The Agy Architecture)
*Once the surrounding I/O is stable, we replace the duplicated FFmpeg logic.*

- [ ] **2.1 JobWorkspace**: Replace all random `mktemp` calls. Create `app/job_workspace.py` to enforce a standard `/tmp/mtapi_jobs/{job_id}/` structure containing `frames_in/`, `frames_out/`, and `audio.aac`.
- [ ] **2.2 VideoPipeline Core**: Build the central engine (`app/media/pipeline.py`) that probes video, dumps frames to the JobWorkspace, runs an execution loop hook, re-encodes, and muxes audio.

---

## 🔄 Phase 3: Op-to-Filter Conversion
*Migrate existing engines onto the Unified Pipeline.*

- [ ] **3.1 Convert WithoutBG**: Strip its internal FFmpeg logic. Turn it into a pure filter taking and returning a frame batch.
- [ ] **3.2 Convert StyleTransfer**: Convert to filter.
- [ ] **3.3 Convert DeepDream**: Convert to filter.
- [ ] **3.4 Convert Facemorph**: Convert to filter.
*(Note: Old loop engines coexist until fully migrated.)*

---

## 🧠 Phase 4: Dynamic Mixing & Resource Management
*The payoff. Chain filters dynamically.*

- [ ] **4.1 Model Manager**: Implement LRU cache for PyTorch/TF/dlib weights. Operations request weights from the manager, ensuring chaining `facemorph` into `deepdream` doesn't OOM the GPU.
- [ ] **4.2 The Pipeline Endpoint**: Implement `POST /ops/pipeline` taking a JSON array of filters. The `VideoPipeline` decodes *once*, streams frames through the filters in RAM, and encodes *once*.
- [ ] **4.3 Multi-Pass UI**: Build a frontend queue to stack operations sequentially and post to the pipeline endpoint.

---

## ✨ Phase 5: New Features
*Build exclusively on the new architecture.*
- [ ] **CivitAI Cloud Gen**: Implement via `docs/civitai-spec.md`. (Unblocked after Phase 1 / Track M).
- [ ] **ASCII Render**: Implement via the new VideoPipeline core.
- [ ] **FFglitch Scripts**: Implement Pixel Sort & MV Pan.
