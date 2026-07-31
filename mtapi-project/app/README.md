# app — Core FastAPI Server Package

Python package for `mtapi-project`: dynamic OpenAPI routes, operation contracts, filter platform bookends, media cache, job control, and static WebUI.

---

## Layout

```
app/
├── main.py              # FastAPI, /ops/*, media, static
├── contract.py          # OperationResult, OperationSpec, REGISTRY
├── shell.py             # Async subprocess (argv only)
├── video_pipeline.py    # probe → dump → process → encode
├── convert_presets.py   # Codec / frames_* recipes
├── job_workspace.py     # /tmp/mtapi_jobs/{id}/
├── pipeline_chain.py    # Multi-stage filter chain
├── filters/             # Stage factories (per_frame | directory)
├── operations/          # Thin HTTP ops + engines
├── media/               # Cache, pool, thumbs, projects
├── job_control.py       # Cancel + progress
├── pathutil.py          # Never-overwrite outputs
└── static/              # WebUI
```

**Architecture doc for agents:** `AGENTS.md` here and `docs/filter-platform-spec.md` at repo root.

---

## Module overview

### Bookends
- **`video_pipeline`**: shared dump/encode; `process` for per_frame filters  
- **`convert_presets`**: ProRes, DNxHR, H.264/AVC, HEVC, VP9, AV1, FFV1, frames_*  
- **`job_workspace`**: isolated frames_in / frames_out / audio  

### Stages
- **`filters/`**: RIFE (directory), DeepDream (per_frame), …  
- **`pipeline_chain`**: dump once → stages → encode once  

### Ops & HTTP
- **`operations/`**: register handlers; prefer thin wrappers over all-in-ones  
- **`contract.py`**: `OperationResult` / `OperationSpec` / `REGISTRY`  
- **`main.py`**: mounts `POST /ops/{id}` from registry  

### Jobs & media
- **`job_control`**: tokens, cancel, progress  
- **`pathutil`**: unique output paths  
- **`media/`**: pool, cache, projects  

### Deprecated
- **`png_pipeline.py`**: legacy dump/encode — do not use for new features  

---

## Subpackages

- [operations README](operations/README.md) · [operations AGENTS](operations/AGENTS.md)  
- [filters AGENTS](filters/AGENTS.md)  
- [static README](static/README.md) · [static AGENTS](static/AGENTS.md)  
