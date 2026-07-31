# AGENTS.md — mtapi-project Backend & Web Server Agent Directives

> **Scope**: Subdirectory `/home/m/snc/cod/ffTransmuteWebui/mtapi-project`  
> **Audience**: Autonomous AI Agents working on the FastAPI app, dependencies, and execution entrypoints.

---

## 1. Mission & Purpose

`mtapi-project` transforms CLI video tools and neural/frame pipelines into a typed REST microservice. It serves the vanilla SPA WebUI, OpenAPI (`/openapi.json`), async jobs (cancel/progress), media pool/cache, and the **filter platform** (dump → stages → encode).

---

## 2. Directory Architecture

```
mtapi-project/
├── run.py                 # uvicorn :24590; TFHUB_CACHE_DIR etc.
├── requirements.txt
├── AGENTS.md              # This file
├── app/
│   ├── main.py            # Dynamic /ops/* from REGISTRY; media; static
│   ├── contract.py        # OperationResult / OperationSpec
│   ├── shell.py           # run_command (argv only, never shell=True)
│   ├── video_pipeline.py  # probe, dump, process, encode  ← BOOKENDS
│   ├── convert_presets.py # Encode/dump presets for Convert + encode()
│   ├── job_workspace.py   # /tmp/mtapi_jobs/{id}/ frames_in|out
│   ├── pipeline_chain.py  # Multi-stage chain (per_frame + directory)
│   ├── filters/           # Stage factories only (rife, deepdream, …)
│   ├── operations/        # Thin HTTP ops + engines still migrating
│   ├── media/             # Cache, dual pool (video+images), thumbs, projects
│   └── static/            # WebUI (tabs: convert, rife, deepdream, Video/Image Pool, Cut, …)
└── bin/                   # transmute copy for API (keep in sync with root)
```

**Read first for frame work:** repo `docs/filter-platform-spec.md` and `docs/resolve-transcode-spec.md`.  
**Read first for libraries / Cut:** repo `docs/video-image-pools-spec.md` (as-built handoff).

---

## 3. Architectural Rules & Invariants

1. **Self-Contained Binaries**  
   - CLI tools default to `bin/` via `MTAPI_BIN_DIR` / `shell.py`. Keep `bin/transmute` in parity with root when changing transmute.
2. **Unified Response Model**  
   - Ops return `OperationResult`. Operational failures: HTTP **200** + `"ok": false`. 4xx/5xx only for bad requests / crashes.
3. **No subprocess in `main.py`**  
   - Use `shell.run_command` or op handlers.
4. **Filter platform (mandatory for new frame effects)**  
   - Stages live in `app/filters/`. Ops are thin bookends.  
   - One factory shared by named op and `POST /ops/pipeline`.  
   - Mid-chain: PNG `frame_%06d.png`, start **0**.  
   - Stage kinds: `per_frame` | `directory` (see filter-platform-spec).  
   - **Convert** (`/ops/convert`) = bookends UI only — codecs, frames_*, GIF. Not a place to hang neural effects.
5. **Do not use `PngFramePipeline`**  
   - Removed (raises). Use `video_pipeline` + `JobWorkspace`, or `dump_frames_sync` / `encode_frames_sync` for rare sync helpers.
6. **Absolute paths** for all media I/O.

---

## 4. Common Agent Tasks

### Builder agents

| Agent | CLI | Browser |
|-------|-----|---------|
| **CodeWhale** | `codewhale` | Playwright MCP |
| **OpenCode** | `opencode` | Playwright MCP |

One agent per file at a time. Never use `web_search` / `web.run` for localhost WebUI tests.

### A. Run the server

```bash
.venv/bin/python run.py
# or
.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 24590
```

### B. Health

`GET /health` — ffmpeg / ffglitch. Neural ops need `requirements.txt` packages.

### C. New frame-effect op (preferred)

1. `app/filters/<name>.py` — `register_stage` + factory (`kind` set on callable).  
2. Thin `operations/<name>_ops.py` — dump → stage → encode.  
3. Import in `operations/__init__.py`.  
4. Optional UI tab under `static/js/tabs/`.  
5. Smoke `/tmp/teste.mp4` (and pipeline one-stage if registered).  
6. Bump root `VERSION` far-right DD.

### D. New codec / frame dump format

Extend `convert_presets.py` + Convert tab (`js/tabs/convert.js`). Do not fork ffmpeg recipes in random ops.

### E. Geometry / transmute flag

Root `transmute` + `bin/transmute` sync + `transmute_ops.py` + docs-transmute-README.

### F. Dual media libraries (Video Pool + Image Pool) + Cut

Canonical doc: **`docs/video-image-pools-spec.md`**.

| Concern | Backend | Frontend |
|---------|---------|----------|
| Video library | `items[]` in pool/project JSON | `state.pool`, `js/pool/grid.js` |
| Image library | `images[]` | `state.imagePool`, `js/pool/image-pool.js` |
| Session | `~/.cache/mtapi/pool_state.json` | `persistence.js` |
| Project | `*.ffproject.json` | same payload; quiet-save with session |
| Range frame thumb | `GET /api/thumbnail?frame=N` | Cut In/Out previews |
| Absolute first/last | `?which=first\|last` | Video Pool cards only |
| Folder scan | `/api/pool/scan?kind=video\|image\|all` | import folder buttons |

**Invariants:**

1. Do not mix stills into video pool items or videos into image pool.  
2. Cut has **no** private video path — global `Video file(s)` + frame range only.  
3. Open project must be dual-saved when pool state changes (else Image Pool dies on F5).  
4. Cut encode is **not** implemented yet; use filter-platform dump+encode when you add it.

---

## 5. WebUI Testing (MANDATORY)

Use Playwright MCP (`mcp_mcp_browser_*`) when available.  
If MCP is missing, use local Playwright + Chromium (`~/.cache/ms-playwright`) — still browser-test.  
**Never** `web.run` / `web_search` for localhost.  
**Never** claim WebUI DONE from curl alone.

Tabs of note: **Convert / Export**, RIFE, DeepDream, Single-Clip, **Video Pool**, **Image Pool**, **Cut**, Sequence, Watcher.

---

## 6. Known Hazards

- **Working directory drift**: transmute bare filenames need `cwd` = input parent.  
- **Do not** re-add `from __future__ import annotations` in `main.py`.  
- **Stale .pyc**: `find mtapi-project -name '__pycache__' -exec rm -rf {} +` after renames.  
- **RIFE**: directory stage only — do not reintroduce per-intermediate process spawns.  
- **DeepDream video**: use `filters.deepdream`; image/ouroboros stay special bookends.  
- **Pool F5 empty images**: project preferred over session without `images[]` — dual-save project (see handoff).  
- **Frame range stuck at 100**: probe never ran; video must be in global bar (`probeGlobalVideo`).  
- **Thumbnail cache**: range frames live under `by_hash/{hash}/range_thumbs/` — keep GC with hash dir.
