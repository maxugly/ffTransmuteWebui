# Roadmap — Phase 2: Filter Graph Architecture

> Vision document. This is the destination — what we're building toward.
> Execution plan: TODO.md. Progress tracking: AUDIT.md.

---

## The Problem

Every neural/video op recycles the same lifecycle: ffmpeg probe + extract
frames → Python loop processes frames → ffmpeg re-encode → cleanup tempdir.
Ops can't be chained. Each manages its own ffmpeg, tempdirs, and models.

## The Target

Move from "Monolithic Operations" to "Filter Graph / Pipeline."

Operations become Filters exposing `process_frame(image_array)`. The
VideoPipeline handles video I/O once. Chaining becomes a JSON array:

```json
POST /ops/pipeline
{ "steps": [{"op": "withoutbg"}, {"op": "deepdream", "blend": 0.5}] }
```

## The Pieces

### 1. Unified Pipeline Engine (Phase 3)
Evolve PngFramePipeline into a VideoPipeline that owns decode→frame-loop→encode.
Ops stop knowing about videos or tempdirs.

### 2. Op-to-Filter Conversion (Phase 4)
Migrate engines one at a time. Each becomes a pure filter. Old engines coexist
until all are migrated. Order: rife → withoutbg → styletransfer → facemorph → deepdream.

### 3. Model Manager (Phase 4, deferred)
LRU cache for PyTorch/TF/dlib weights. Built when two heavy models share a chain.
Ops request weights through the manager — never load GPU memory directly.

### 4. Standardized Job Workspace (Phase 3.1)
Replace scattered mktemp with `/tmp/mtapi_jobs/{job_id}/` containing
frames_in/, frames_out/, audio.aac, metadata.json. Failed jobs preserve
workspace for debugging.

### 5. Dynamic Mixing (Phase 5)
POST /ops/pipeline endpoint. VideoPipeline decodes once, streams through
filter chain in RAM, encodes once. Multi-Pass UI tab for queuing filters.

### 6. UI Evolution (Phase 5.2)
Multi-Pass tab → stack operations, reorder, hit run. Future: node-based
editor (Blender compositor / ComfyUI style).

---

## The Path (from final plan)

```
Phase 0    Infrastructure safety (nested routing, ES modules, CSS tokens)
Phase 1    Easy wins (melt twins, cancel audit)
Track F    Frontend modularization (style.css → app.js split)
Track D    Datamosh split (5 mosh modes → per-file handlers)
Track M    Media facade + split (cache → thumbnails → pool → projects)
Phase 3    VideoPipeline + JobWorkspace
Phase 4    Op-to-Filter conversion (rife → withoutbg → styletransfer → facemorph → deepdream)
Phase 5    Dynamic mixing (POST /ops/pipeline + Multi-Pass UI)
Phase 6    New features (CivitAI, ASCII, FFglitch, speed ramp, rubberband)
```

## Progress

| phase | status |
|-------|--------|
| 0.1 nested static routes | ✅ done |
| 0.2 ES module entry | next |
| 1.2 datamosh twins | ✅ done |
| everything else | pending |

---

## Rules

- One commit per item. Verify before next.
- Frontend before backend engines. CSS before JS.
- Facade before internal split. Old paths coexist during migration.
- Model Manager deferred until needed. Don't build infrastructure without a caller.
