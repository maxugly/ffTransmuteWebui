# AGENTS.md — mtapi-project Backend & Web Server Agent Directives

> **Scope**: Subdirectory `<workspace-root>/mtapi-project`  
> **Audience**: Autonomous AI Agents working on the FastAPI app, dependencies, and execution entrypoints.  
> **Where we are:** repo `docs/STATUS.md` (canonical) · `docs/SESSION-STOPPING-STATE.md` · `docs/README.md` · root `AGENTS.md`

---

## 1. Mission & Purpose

`mtapi-project` transforms CLI video tools and neural/frame pipelines into a typed REST microservice. It serves the vanilla SPA WebUI, OpenAPI (`/openapi.json`), async jobs (cancel/progress), media pool/cache, and the **filter platform** (dump → stages → encode).

**Read `docs/STATUS.md` before inventing ops or redoing Image Sort / RIFE / progress.**

---

## 2. Directory Architecture

```
mtapi-project/
├── run.py                 # uvicorn :24590; TFHUB_CACHE_DIR etc.
├── requirements.txt
├── AGENTS.md              # This file
├── junk/                  # THROWAWAY ONLY (gitignored except .gitkeep)
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
**Read first for audio/variant features (Phase 1 & 2):** root `audio_stretch_engine_spec.md`, `audio_pipeline_architecture_spec.md`, `sequence_clip_variant_registry_spec.md`.  
**Read first for sequence exports/RIFE:** root `sequence_codec_export_spec_2.0.md`, `sequence_rife_interpolation_spec.md`.  
**Read first for “what’s done”:** repo `docs/STATUS.md`.

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
7. **Progress** — `report_progress` every loop item; **dir watch** for opaque writers that fill `frames_in`/`frames_out` (RIFE already wired). Spec: `docs/workspace-progress-spec.md`.
8. **RIFE multiplier** — API/UI range **2–128** (not list length). Image Sort list min 2, no max count.
9. **WebUI long docs** — bottom of panel (`.tool-docs`); Image Sort is the pilot (`docs/tool-bottom-docs-spec.md`).
10. **Junk drawer (`junk/`)** — all throwaways go here (gitignored). That includes:
    - screenshots / Playwright / browser captures (`*.png` snaps of the UI)
    - scratch/test scripts, extracted frames, model weights, binary backups
    - Write under `mtapi-project/junk/` immediately — never repo root, never next to `app/`.
    - Full policy: root `AGENTS.md` §3.11.

---

## 4. Common Agent Tasks

### Builder agents

| Agent | CLI | Browser |
|-------|-----|---------|
| **CodeWhale** | `codewhale` | Playwright MCP |
| **OpenCode** | `opencode` | Playwright MCP |

One agent per file at a time. Never use `web_search` / `web.run` for localhost WebUI tests.

### A. Run the server

**CRITICAL WARNING:** The default `python run.py` entrypoint does **NOT** hot-reload code changes! If you modify any backend Python files while the user is running `run.py`, your changes will not take effect until the server process is killed and restarted.

For development with hot-reloading, run the server using uvicorn directly:
```bash
.venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 24590
```

*Note: If the user is running the server themselves via `python run.py`, you MUST instruct them to restart it so your backend fixes take effect! Do not assume your code is active!*

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

## 5. WebUI Testing (MANDATORY — every time, no reminder required)

**After any change to ops, static JS/CSS/HTML, pool/sequence, jobs, or server
routes that the UI hits:** run a browser smoke **before** you say it works.
The human should not have to ask. This is the default builder gate.

Use Playwright MCP when available; otherwise local Playwright + Chromium
(`~/.cache/ms-playwright`).  
**Never** `web.run` / `web_search` for localhost.  
**Never** claim DONE from curl, unit tests, or `page.evaluate`-only “tests”
that never click a real control.

**Minimum path (every ship):**

1. Navigate to `http://127.0.0.1:24590/`  
2. **Click** the tab you changed  
3. Exercise the control (Run / Stitch / Format / Instant / match / etc.)  
4. Wait for success; check console; verify output or the fixed behavior  
5. Only then report DONE  

Details and test assets: root `AGENTS.md` §D.  

**Screenshots / captures:** only under `junk/` (e.g. `junk/playwright/…`).
Never drop PNGs at monorepo root or package root.

Tabs of note: **Convert / Export**, RIFE, **RIFE Recohere**, **Speed**, DeepDream, **Image Sort**, **Img2img**, **Txt2img**, **Agent**, **Upscale**, **Cut** (encode), **Jobs** (queue), **Video Pool**, **Image Pool**, Sequence, Watcher.

**OpenVINO / FastSD:** img2img + txt2img + recohere mid-frame need `MTAPI_FASTSD_ROOT` (GPU). **Prompt Library** saves ± pairs via `localStorage`. **Job queue:** Add to Queue + Jobs tab (`job_queue.py`, in-memory v1).

**Roadmap (not done):** full universal desk persistence, tilagup mode, quality rating, progress multi-phase polish — see repo `docs/STATUS.md` §4–§8.

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
