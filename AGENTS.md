# AGENTS.md — Root Workspace Agent Directives

> **Scope**: Root directory `/home/m/snc/cod/ffTransmuteWebui`  
> **Audience**: Autonomous AI Agents, Code Assistants, and Developer Tooling  
> **Where we are:** read **`docs/STATUS.md` first** (shipped vs partial vs spec-only). Handoff narrative: `docs/SESSION-STOPPING-STATE.md`. Doc index: `docs/README.md`.

---

## 🎯 1. Mission & System Purpose

The root workspace orchestrates a non-destructive video manipulation system. It combines raw shell-level ffmpeg/ffglitch pipelines with a typed Python HTTP server (`mtapi-project`) and an asynchronous single-page web interface.

Agents operating at this level are responsible for top-level repository integrity, cross-component interface stability, build execution, and workspace-wide documentation.

**Before coding or writing a new spec:** check `docs/STATUS.md` so you do not re-spec shipped work or implement abandoned backlog by accident.

---

## 🏗️ 2. Architectural Map & Component Roles

```
/home/m/snc/cod/ffTransmuteWebui/
├── transmute                    # Pure Bash CLI script (wraps ffmpeg for pixel-exact geometry ops)
├── datamosh.sh                  # Pure Bash CLI script (wraps ffgac/ffedit/ffmpeg for datamoshing)
├── melt.js / no_keyframe.js     # ffglitch ECMAScript modules for vector & frame destruction
├── speedramp_png.py             # PNG frame-remap speed ramp (bypasses ffmpeg setpts)
├── docs-transmute-README.md     # Reference doc for standalone transmute CLI flags
├── docs/                        # Specs, STATUS, handoffs (start: docs/STATUS.md)
│   ├── STATUS.md                # Canonical shipped / partial / spec-only
│   ├── README.md                # Doc index
│   └── video-image-pools-spec.md
├── mtapi-project/               # FastAPI backend package and WebUI client
└── AGENTS.md                    # Root agent operational directives (this file)
```

Sibling (not in this repo): `/home/m/snc/cod/tilagup` — agent tiled SD upscale; port design in `docs/tilagup-mtapi-mode-spec.md`.

### Component Breakdown
1. **`transmute`**:
   - Single-file executable Bash script. Zero dependencies beyond `ffmpeg` and `ffprobe`.
   - Rule: Never scales or interpolates pixels unless explicitly requested via stretch (`-x`) or composite modes (`-g`/`-j`).
2. **`datamosh.sh`**:
   - Orchestrates two-pass MPEG-2 video corruption using `ffgac` (MPEG-2 encoder/decoder) and `ffedit` with JavaScript glitch hooks.
3. **`mtapi-project`**:
   - Python 3.10+ FastAPI server exposing every operation as a typed HTTP endpoint.
   - Hosts `app/static/index.html` (the web application).
   - **Frame effects** use the filter platform (see below). **Codec / frame-folder I/O** use Convert/Export. **Geometry / datamosh** remain CLI wrappers where appropriate.

### Filter platform (canonical for frame effects)

Authoritative detail: `docs/filter-platform-spec.md`.

```text
dump (video_pipeline)  →  stage(s) in app/filters/*  →  encode (video_pipeline + convert_presets)
         ▲                          ▲                              ▲
    bookends only            effect only                     bookends only
```

| Layer | Location | Owns |
|-------|----------|------|
| Bookends | `app/video_pipeline.py`, `app/convert_presets.py` | probe, dump, load frames, encode presets |
| Workspace | `app/job_workspace.py` | per-job `frames_in` / `frames_out` / audio |
| Chain | `app/pipeline_chain.py`, `POST /ops/pipeline` | dump once → stages → encode once |
| Stages | `app/filters/*` | **only** frame transforms (`per_frame` or `directory`) |
| Thin ops | `app/operations/*_ops.py` | params + bookends + `OperationResult` |
| Convert UI | `POST /ops/convert`, Convert / Export tab | user-facing dump/encode only (no filters) |

**Do not** grow new all-in-one ops that each reimplement dump/encode.  
**Do not** paste filter logic into both `*_ops.py` and `pipeline_ops.py` — one factory in `app/filters/`.

Stage kinds:

- **`per_frame`**: 1:1 `async (in_png, out_png, index)` — DeepDream video, withoutbg (target), style (target)
- **`directory`**: one call `(src_dir, dst_dir)` — RIFE (whole-folder binary)
- **File-level** (out of chain): datamosh / ffglitch on encoded bitstreams

### Operation Registry (active ops)

| op | file | filter stage | status |
|----|------|--------------|--------|
| transmute (geometry, extract, join, grid) | `transmute_ops.py` | — (CLI) | ✅ stable |
| convert / export (codecs, frames_*, GIF) | `convert_ops.py` + `convert_presets.py` | bookends | ✅ stable |
| pipeline (multi-filter chain) | `pipeline_ops.py` | registry | ✅ stable |
| datamosh (melt, classic, …) | `datamosh` / ops | file-level | ✅ stable |
| deepdream | `deepdream_ops.py` + `filters/deepdream.py` | per_frame (video) | ✅ stable |
| facemorph | `facemorph_ops.py` | multi-source | ✅ morph+encode; dream_after → filters.deepdream |
| withoutbg | `withoutbg_ops.py` + `filters/withoutbg.py` | per_frame (video) | ✅ stable |
| style transfer | `styletransfer_ops.py` + `filters/styletransfer.py` | per_frame (video) | ✅ stills + video (dump→filter→encode) |
| RIFE | `rife_ops.py` + `filters/rife.py` | directory | ✅ stable |
| speed change | `speedchange_ops.py` | setpts/atempo or dump→RIFE→encode | ✅ uniform speed + target FPS + optional RIFE |
| speed ramp | `speedramp_ops.py` + `filters/speedramp.py` | directory remap | ✅ PNG remap (not setpts); optional RIFE; audio dropped v1 |
| zoompan (pan & zoom still→video) | `zoompan_ops.py` | — (ffmpeg crop) | ✅ image + two boxes |
| image sort & RIFE | `imagesort_rife_ops.py` + `app/image_sort/` | multi-source → optional directory RIFE | ✅ radial/chain rank → conform → RIFE (M **2–128**) → encode; bottom `.tool-docs` |
| img2img (OpenVINO) | `img2img_ops.py` + `filters/img2img.py` | directory | ✅ FastSD GPU OV; mark `frame_indices`; pipeline filter `img2img` |
| txt2img (OpenVINO) | `txt2img_ops.py` + `filters/txt2img_ov_worker.py` | — (generate) | ✅ FastSD GPU OV text-to-image stills |
| agent chat / image_to_prompt | `agent_ops.py` + `app/agents/` | — (CLI vision) | ✅ grok/agy/stub + HTTP APIs; SD1.5 skill; Agent tab |
| raw transmute | `transmute_ops.py` | — | ✅ escape hatch |
| **RIFE Recoherence** | `rife_recohere_ops.py` + rife + img2img filters | compose directory stages | ✅ two stills → RIFE M=2 → img2img **every mid** (keep all) → encode (`4.62`) |
| **Prompt Library** (UI) | `static/js/ui/prompt-library.js` | — (localStorage) | ✅ save/load ± pairs on img2img / txt2img / recohere (`4.61`) |
| upscale (NCNN) | `upscale_ops.py` + `filters/upscale.py` | directory | ⚠️ **partial** — in tree + tab + bins; verify before treating as DONE |

**RIFE density:** multiplier **2–128** on Image Sort / RIFE / Speed / ramp (API + knobs). Image **list length is uncapped** (min 2). High M on large K is intentional power-user territory (2-still long morphs).

**Progress:** long ops report via `job_control.report_progress`; directory binaries (RIFE) use `start_dir_watch` on workspace frame dirs — see `docs/workspace-progress-spec.md`.

`PngFramePipeline` removed (raises). Spec: `docs/filter-platform-spec.md`.

### Media libraries (WebUI) — dual pools + Cut

Canonical as-built: **`docs/video-image-pools-spec.md`**.

| Library | State | Persist key | Purpose |
|---------|-------|-------------|---------|
| **Video Pool** | `state.pool` | `items[]` | Videos, sequence stitch, send-to ops |
| **Image Pool** | `state.imagePool` | `images[]` | Stills, cut refs, image ops |
| **Cut** | `state.cut` `{refA,refB}` | (refs not yet persisted) | In/Out from **global** frame range |

- Tab ids: Video Pool=`pool`, Image Pool=`images`, Sequence=`sequence`, Cut=`cut`.  
- Cut clip = global Video bar only (no private path field).  
- Range thumbs: `/api/thumbnail?frame=N`; absolute first/last for Video Pool cards only.  
- Open project must be saved with `images[]` (quiet dual-save in `savePoolStateNow`).

---

## 🚨 3. System Invariants & Non-Negotiable Rules

When modifying files at the root level or coordinating changes across components:

1. **Pixel Integrity Guarantee**:
   - Operations in `transmute` MUST preserve native frame dimensions and aspect ratios by default using crop (`-c`, `-s`, `-z`) or letterbox (`-b`, `-S`) filters rather than scaling.
2. **Absolute Path Requirement**:
   - All API endpoints and subprocesses must be supplied with or convert arguments to absolute filesystem paths. Relative paths are ambiguous in multi-threaded API environments.
3. **Safe Subprocess Spawning**:
   - Subprocess invocations in Python MUST use `create_subprocess_exec` with explicit `argv` lists. NEVER use `shell=True` or string interpolation to execute shell commands.
4. **No External Framework Dependencies on Frontend**:
   - The WebUI in `mtapi-project/app/static` uses vanilla HTML5, CSS3, and JavaScript (ES6+). Do NOT introduce npm/webpack/React/Tailwind dependencies unless explicitly requested.
5. **Unified Pipeline Pattern (filter platform)**:
   - Frame effects: **dump → stage(s) → encode** via `video_pipeline` + `app/filters/*`. Mid-chain format: PNG `frame_%06d.png`, start_number **0**.
   - Never invent a second dump/encode stack inside an op. Convert presets live in `convert_presets.py`.
   - Geometry stays on `transmute` CLI; Resolve intermediates / delivery codecs / frame folders stay on **Convert**, not ad-hoc ffmpeg in neural ops.
6. **Dual media libraries (Video / Image)**:
   - Keep video and still libraries separate in state and JSON (`items` vs `images`).  
   - Workspace tabs that need a clip + range (e.g. Cut) use **global Video + Frame range**, not a private file picker.  
   - See `docs/video-image-pools-spec.md`.
7. **Version Bumping**:
   - Bump far-right DD in VERSION for each feature (000.000.X.DD). Commit + push per change.
   - Bump third segment (000.000.X.0) for significant releases (new ops, major UI additions).
8. **Progress Reporting (live updates)**:
   - Every long-running ops handler MUST call `job_control.report_progress()` frequently — at least once per item in any per-frame/conform loop.
   - Each call must include `phase`, `current`, `total`, and `unit` so the UI can show elapsed/ETA (phase-local rate).
   - Phase names: `conform`, `sort`, `rife`, `encode`, `dump`, etc. — short, lowercase, stable.
   - For single-call directory/binary stages that **write PNG sequences** (e.g. RIFE → `frames_out`): use **`job_control.start_dir_watch`** for the duration of the subprocess so `current` climbs; do not leave the UI on `0/N` until exit.
   - Never batch progress updates at e.g. "every 10 items" — that creates dead time where the browser sees no change. Report every iteration.
9. **Tool bottom docs (WebUI)**:
   - Long explanations live in a **`.tool-docs`** block at the **bottom** of the action panel (after knobs). Pilot: Image Sort. Pattern: `docs/tool-bottom-docs-spec.md`.
10. **Ship → update STATUS**:
   - When landing a feature: bump VERSION DD, update `docs/STATUS.md`, set the feature spec banner to Implemented/Partial, refresh `docs/SESSION-STOPPING-STATE.md` on meaningful stops.

---

## 🛠️ 4. Agent Workflows & Action Protocols

### A. Testing the Entire Stack
1. Ensure `ffmpeg`, `ffprobe`, `ffgac`, `ffedit`, and `rife-ncnn-vulkan` are on `$PATH`.
2. Check backend server startup:
   ```bash
   cd mtapi-project
   python run.py
   ```
3. Test API responsiveness:
   ```bash
   curl -s http://localhost:24590/health | jq .
   ```

### B. Adding a New Operation

**Frame effect (neural / per-frame / directory tool)** — preferred path:

1. Add stage factory under `mtapi-project/app/filters/<name>.py` with correct `kind` (`per_frame` or `directory`). Register via `register_stage`.
2. Thin `*_ops.py`: dump → stage → encode (or call pipeline); return `OperationResult`.
3. Ensure `/ops/pipeline` can resolve the same factory (no paste).
4. Import ops module in `operations/__init__.py`; UI tab if needed.
5. Update this registry table + `docs/filter-platform-spec.md` if new stage kind.
6. Bump VERSION (far-right DD).

**CLI wrapper (geometry / file-level glitch)** — still valid:

1. `*_ops.py` + Pydantic + `register(OperationSpec)` → shell via `run_command`.
2. Import in `__init__.py`; UI; registry table; VERSION.

**Bookends only (new codec / dump format)**: extend `convert_presets.py` + Convert UI — not a new neural op.

Canonical docs: `docs/filter-platform-spec.md`, `docs/resolve-transcode-spec.md`, `mtapi-project/app/operations/README.md`.

### C. Your Role

This project has different agents doing different jobs. Find your role below.
You can read the whole file, but **only do the work your role says to do.**

#### Spec Writer (agy, grok, bones)

Your job is research and specification. You do NOT write code. You do NOT edit
files outside `docs/`.

- **Read `docs/STATUS.md` first.** Do not re-spec Implemented features without
  a human asking for a redesign.
- Research: search the web, read the codebase, compare approaches.
- Write specs: create `docs/<feature>-spec.md` with the problem, approach,
  files to touch, pattern to follow, pitfalls, and verification steps.
- Keep **STATUS / SESSION-STOPPING-STATE / docs/README** accurate when the
  product picture changes (status banners, new docs).
- Review: read other specs and note conflicts, missing edge cases, or
  contradictions with existing code.
- Post findings to `docs/` or tell the user directly.

**You never claim DONE in the verification sense — your deliverable is a spec
document, not working code.**

#### Builder (codewhale, codex, opencode)

Your job is implementation. You read specs and turn them into working code.

- **Read `docs/STATUS.md` first.** Implement only prioritized open work; do not
  randomly pick `docs/backlog/*` unless assigned.
- Prefer as-built specs over Legacy/Gemini drafts when both exist.
- Follow §D (Verification) for every change — WebUI test with test clips.
- Follow §B (Adding a New Operation) for new ops.
- Follow §3 (System Invariants) for all code.
- On ship: VERSION DD + `docs/STATUS.md` + feature-spec banner.
- Commit after each working sub-step. Push only when asked.
- If a spec is unclear or missing, ask — don't guess.

#### Reviewer (agy when reviewing, grit)

Your job is finding what the builder missed.

- Read the diff. Read the spec. Check that every file the spec said to touch
  was actually touched.
- Check edge cases: empty input, missing files, cancelled operations.
- Check conventions: did they follow the pattern from the spec? Did they
  import correctly? Did they register the op?
- Report what you found. Don't fix it — that's the builder's job.

#### Human (max)

You're the decider. You say what to build and why. The rest of us make it real.

### D. Verification — MANDATORY BEFORE CLAIMING DONE

#### Test Assets

| file | what | size |
|------|------|------|
| `/tmp/teste.mp4` | 2s video, 320×240, 24fps, audio | 47KB |
| `/tmp/teste.png` | 1-frame still, 320×240 | 2KB |

Both process in under 5 seconds. If missing:

```bash
ffmpeg -y -f lavfi -i "testsrc=duration=2:size=320x240:rate=24" \
  -f lavfi -i "sine=frequency=440:duration=2" \
  -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 64k -shortest \
  /tmp/teste.mp4

ffmpeg -y -f lavfi -i "testsrc=duration=1:size=320x240:rate=1" \
  -vframes 1 /tmp/teste.png
```

#### How to Test (use the WebUI — not curl)

Testing through the API proves the backend works. Testing through the WebUI
proves the whole stack works — the form collects the right params, the button
fires the POST, the response displays correctly, and no JS errors swallow the
result. **Use the WebUI for all verification.**

Start Playwright once per session:

```
start_mcp_server with @playwright/mcp
```

Then for each op you touched:

1. **`browser_navigate`** to `http://localhost:24590/`
2. **`browser_click`** the tab for the op you changed (e.g. "RIFE Slow-Mo")
3. **`browser_snapshot`** — verify the form rendered with all controls
4. **`browser_type`** into the input field: `/tmp/teste.mp4` (or `.png` for image ops)
5. **`browser_click`** the Run Operation button
6. **`browser_console`** — check for JS errors
7. Watch the terminal output — the server now streams ffmpeg progress in real-time

**You are testing ONE thing: does it run without choking?** Not output quality.
Not correctness. Just: the form submits, the server accepts it, ffmpeg runs,
and you get an `ok: True` response with no JS errors in console.

If the form doesn't render, the button does nothing, or the console shows
errors — fix before continuing. The server terminal will show ffmpeg
progress and any subprocess failures as they happen.

Clean up test outputs: `rm -f /tmp/teste_rife.mp4 /tmp/teste_crop.mp4 /tmp/teste_withoutbg.png`

#### Quick Backend-Only Check (when the WebUI is not available)

If you can't use the browser for some reason, fall back to curl:

```bash
curl -s -X POST http://localhost:24590/ops/<op_id> \
  -H "Content-Type: application/json" \
  -d '{"input_path":"/tmp/teste.mp4"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok'), d.get('error',''))"
```

But prefer the WebUI path — it catches form and JS bugs that curl can't.

**No agent claims DONE without running `/tmp/teste.mp4` (or `.png`) through
the WebUI form for every op touched, with zero JS console errors.**

---

## ⚡ 5. Troubleshooting & Known Edge Cases

- **Path Spacing**: Always wrap file variables in quotes within bash scripts (`"$INPUT"`).
- **FastAPI Postponed Evaluation Issue**: `from __future__ import annotations` in `app/main.py` breaks FastAPI's dynamic route parameter extraction. Keep it removed in `main.py`.
- **ffglitch Feature Exclusivity**: In `ffedit`, requesting incompatible features simultaneously (e.g., `mv` and `q_dct`) causes hard crashes. Request ONLY the required feature in `setup(args)`.
- **RIFE / rife-ncnn-vulkan**: Installed via AUR (`rife-ncnn-vulkan-bin`). Uses Vulkan GPU (Intel Iris Xe). Binary at `/usr/bin/rife-ncnn-vulkan`. Models: rife-v4.6 (best), rife-v4, rife-v2.4, rife-v2.3.
- **setpts expressions**: `N`-based setpts expressions (e.g. `(0.5 + 0.0036*N)*PTS`) are unreliable across ffmpeg builds. Prefer `PTS*TB`-based or PNG frame-remap for variable-speed effects.
- **Stale .pyc**: If code changes don't take effect, run `find mtapi-project -name '__pycache__' -exec rm -rf {} +` before restarting the server.
