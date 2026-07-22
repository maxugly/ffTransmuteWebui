# app — Core FastAPI Server Package

Python package for `mtapi-project`: dynamic OpenAPI routes, operation contracts, subprocess helpers, media cache, job control, and static WebUI delivery.

---

## Layout

```
app/
├── main.py           # FastAPI app, /ops/*, media/pool/project APIs, static
├── contract.py       # OperationResult, OperationSpec, REGISTRY
├── shell.py          # Async subprocess + binary checks
├── media_store.py    # BLAKE2b media registry, thumbs, projects, frame export
├── job_control.py    # Cancel tokens + progress snapshots for long jobs
├── pathutil.py       # Sequential never-overwrite output paths
├── operations/       # All POST /ops/* handlers
└── static/           # WebUI
```

---

## Module overview

### `contract.py`
- `OperationResult`: `ok`, `operation`, `output_path`, `dry_run`, `command`, `stdout`, `stderr`, `error`
- `OperationSpec` + global `REGISTRY`

### `main.py`
- Mounts `POST /ops/{id}` from the registry
- Media: probe, thumbnail, pool state, project save/load
- Jobs: `POST /api/cancel`, `GET /api/job/{token}`
- UI: `/`, `/app.js`, `/style.css`

### `job_control.py`
Long-running ops (DeepDream, morph, withoutBG, style transfer) bind a token, report progress, and honor cancel.

### `pathutil.py`
`unique_output_path` / `unique_related_paths` — first free name stays clean; further runs get `_0001`, `_0002`, … Related files (cutout + mask + bg) share one sequence.

### `media_store.py`
`~/.cache/mtapi/media/` content-addressed store; first/last thumbs; `.ffproject.json` project payloads.

### `shell.py`
`run_command`, `check_tools` for ffmpeg / ffglitch binaries.

---

## Subpackages
- [operations README](operations/README.md)
- [static README](static/README.md)
