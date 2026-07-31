# Roadmap — Filter Platform (current)

> Living destination doc. Execution detail: `TODO.md`. Agent rules: `AGENTS.md`.  
> Architecture contract: `docs/filter-platform-spec.md`.  
> Updated: 2026-07-31

---

## Where we are

Frame effects are **not** all-in-one dump/encode ops anymore. The stack is:

```text
dump (video_pipeline) → stage(s) in app/filters/* → encode (video_pipeline + convert_presets)
```

| Layer | Location | Status |
|-------|----------|--------|
| Bookends | `video_pipeline`, `convert_presets`, `JobWorkspace` | ✅ |
| Stages | `app/filters/` (`per_frame` \| `directory`) | ✅ rife, deepdream, withoutbg, styletransfer |
| Chain | `pipeline_chain`, `POST /ops/pipeline` | ✅ disk cascade |
| Convert / Export | `/ops/convert` + WebUI tab | ✅ codecs + frames_* + GIF |
| Thin ops | `*_ops.py` | ✅ for migrated video paths |
| `PngFramePipeline` | `png_pipeline.py` stub | ✅ **removed** (raises) |

---

## Target (unchanged intent)

1. **Filters** only transform frame sequences on disk.  
2. **Bookends** own ffmpeg I/O and codecs.  
3. **Pipeline** dumps once, runs stages, encodes once.  
4. **Convert** is user-facing bookends (Resolve intermediates, delivery, frame folders).  
5. **File-level** tools (datamosh) stay outside the PNG chain.  
6. **Model Manager** (deferred) when multi-neural chains share VRAM.

---

## Path completed (historical)

```
Phase 0–2   infrastructure, frontend modules, datamosh package, media facade work
Phase 3     VideoPipeline + JobWorkspace
Phase 4     Op-to-filter: rife (directory), deepdream/withoutbg/styletransfer (per_frame)
Phase 4.x   PngFramePipeline removal; Convert/Export
Phase 5     POST /ops/pipeline + PipelineChain (disk stages)
```

---

## Remaining focus

| Priority | Item | Notes |
|----------|------|--------|
| P1 | Multi-Pass UI tab | Backend pipeline exists; frontend queue still light |
| P1 | Model Manager | When chaining two heavy TF/neural stages |
| P2 | Facemorph multi-source stage kind | Morph is multi-still → frames; optional formal registry kind |
| P2 | scrub remaining `dream_video` call paths | Sync helper kept; prefer async filter path |
| P3 | Backlog ops | `docs/backlog/*` (ASCII, CivitAI, etc.) on filter platform |
| P3 | Planning doc hygiene | Keep this file + TODO current; archive stale debate docs |

---

## Rules for agents

- New frame effects → `app/filters/` + thin op. Never reintroduce `PngFramePipeline`.  
- New codecs / frame dumps → `convert_presets` + Convert tab.  
- Geometry → `transmute` CLI. Glitch → datamosh (file-level).  
- One commit per working slice; smoke `/tmp/teste.mp4`.
