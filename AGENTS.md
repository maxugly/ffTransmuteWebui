# AGENTS.md — Root Workspace Agent Directives

> **Scope**: Root directory `/home/m/snc/cod/ffTransmuteWebui`
> **Audience**: Autonomous AI Agents, Code Assistants, and Developer Tooling

---

## 🎯 1. Mission & System Purpose

The root workspace orchestrates a non-destructive video manipulation system. It combines raw shell-level ffmpeg/ffglitch pipelines with a typed Python HTTP server (`mtapi-project`) and an asynchronous single-page web interface.

Agents operating at this level are responsible for top-level repository integrity, cross-component interface stability, build execution, and workspace-wide documentation.

---

## 🏗️ 2. Architectural Map & Component Roles

```
/home/m/snc/cod/ffTransmuteWebui/
├── transmute                    # Pure Bash CLI script (wraps ffmpeg for pixel-exact geometry ops)
├── datamosh.sh                  # Pure Bash CLI script (wraps ffgac/ffedit/ffmpeg for datamoshing)
├── melt.js / no_keyframe.js     # ffglitch ECMAScript modules for vector & frame destruction
├── speedramp_png.py             # PNG frame-remap speed ramp (bypasses ffmpeg setpts)
├── docs-transmute-README.md     # Reference doc for standalone transmute CLI flags
├── docs/                        # Specs, failure reports, debug notes
├── mtapi-project/               # FastAPI backend package and WebUI client
└── AGENTS.md                    # Root agent operational directives (this file)
```

### Component Breakdown
1. **`transmute`**:
   - Single-file executable Bash script. Zero dependencies beyond `ffmpeg` and `ffprobe`.
   - Rule: Never scales or interpolates pixels unless explicitly requested via stretch (`-x`) or composite modes (`-g`/`-j`).
2. **`datamosh.sh`**:
   - Orchestrates two-pass MPEG-2 video corruption using `ffgac` (MPEG-2 encoder/decoder) and `ffedit` with JavaScript glitch hooks.
3. **`mtapi-project`**:
   - Python 3.10+ FastAPI server exposing every operation as a typed HTTP endpoint.
   - Hosts `app/static/index.html` (the web application).
   - Operations follow a unified pipeline: **dump PNGs → tool → re-encode**. This pattern is used by deepdream, facemorph, withoutbg, style transfer, RIFE, and speed ramp.

### Operation Registry (active ops)

| op | file | status |
|----|------|--------|
| transmute (geometry, extract, join, grid) | `transmute_ops.py` | ✅ stable |
| datamosh (melt, classic) | `datamosh_ops.py` | ✅ stable |
| deepdream | `deepdream_ops.py` | ✅ stable |
| facemorph | `facemorph_ops.py` | ✅ stable |
| withoutbg | `withoutbg_ops.py` | ✅ stable (video mode spec'd) |
| style transfer | `styletransfer_ops.py` | ✅ stable |
| RIFE interpolation | `rife_ops.py` | ✅ stable in 000.000.3.0 |
| speed ramp | `speedramp_ops.py` + `speedramp_png.py` | ⚠️ in progress |
| raw transmute | `transmute_ops.py` | ✅ escape hatch |

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
5. **Unified Pipeline Pattern**:
   - New neural/video ops follow: ffmpeg dump PNGs → tool/engine processes frames → ffmpeg re-encode. Never invent a new I/O pattern.
6. **Version Bumping**:
   - Bump far-right DD in VERSION for each feature (000.000.X.DD). Commit + push per change.
   - Bump third segment (000.000.X.0) for significant releases (new ops, major UI additions).

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
1. Create `mtapi-project/app/operations/<name>_ops.py` following the Pydantic + async handler + register() pattern.
2. Add import to `mtapi-project/app/operations/__init__.py`.
3. Add UI entry in `mtapi-project/app/static/app.js`.
4. Update this AGENTS.md ops registry table.
5. Bump VERSION (far-right DD).

### C. Working Together

You may be working alongside other agents or the user. Communicate directly —
say what you're doing, ask questions when stuck, and report what you found.
No formal protocol required. If there are `.coms.md` or `.presence.json` files
in the repo, they're legacy from an earlier coordination experiment — you can
read them for context but don't feel obligated to maintain them.

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

#### How to Test

**Test ONLY the specific operations you touched.** Not the whole server.
Not every tab. Just the ops whose code, engine, or route you changed.

For a video op (rife, transmute, deepdream, datamosh, etc.):

```bash
curl -s -X POST http://localhost:24590/ops/<op_id> \
  -H "Content-Type: application/json" \
  -d '{"input_path":"/tmp/teste.mp4"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok'), d.get('error',''))"
```

For an image op (withoutbg, styletransfer, facemorph):

```bash
curl -s -X POST http://localhost:24590/ops/<op_id> \
  -H "Content-Type: application/json" \
  -d '{"input_path":"/tmp/teste.png"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok'), d.get('error',''))"
```

**You are testing ONE thing: does it run without choking?** Not output quality.
Not correctness. Just: `ok: True` with no error. If ffmpeg crashes, the op
handler throws, or the subprocess hangs — you'll see it here in seconds.

- `ok: True` → passed. Delete the output file and move on.
- `ok: False` → read `error` and `stderr`. Fix before continuing.
- Timeout → server crashed. Check the server terminal for the traceback.

Clean up: `rm -f /tmp/teste_rife.mp4 /tmp/teste_crop.mp4 /tmp/teste_withoutbg.png`

#### Browser Verification (only for changes in `app/static/`)

If you touched HTML, CSS, or JS, also verify in a real browser after the
backend test passes. Start Playwright once per session:

```
start_mcp_server with @playwright/mcp
```

Then: `browser_navigate http://localhost:24590/` → `browser_console` (ZERO
errors) → click the tab you changed → verify the form rendered → `browser_screenshot`.

If you added a new form or tab: click it and verify every control renders
(textbox, select, knob, button). Run the op with `/tmp/teste.mp4` through
the form — not dry_run — and check the terminal output for errors.

**No agent claims DONE without both: backend test passed AND (if frontend
touched) browser clean with zero console errors.**

---

## ⚡ 5. Troubleshooting & Known Edge Cases

- **Path Spacing**: Always wrap file variables in quotes within bash scripts (`"$INPUT"`).
- **FastAPI Postponed Evaluation Issue**: `from __future__ import annotations` in `app/main.py` breaks FastAPI's dynamic route parameter extraction. Keep it removed in `main.py`.
- **ffglitch Feature Exclusivity**: In `ffedit`, requesting incompatible features simultaneously (e.g., `mv` and `q_dct`) causes hard crashes. Request ONLY the required feature in `setup(args)`.
- **RIFE / rife-ncnn-vulkan**: Installed via AUR (`rife-ncnn-vulkan-bin`). Uses Vulkan GPU (Intel Iris Xe). Binary at `/usr/bin/rife-ncnn-vulkan`. Models: rife-v4.6 (best), rife-v4, rife-v2.4, rife-v2.3.
- **setpts expressions**: `N`-based setpts expressions (e.g. `(0.5 + 0.0036*N)*PTS`) are unreliable across ffmpeg builds. Prefer `PTS*TB`-based or PNG frame-remap for variable-speed effects.
- **Stale .pyc**: If code changes don't take effect, run `find mtapi-project -name '__pycache__' -exec rm -rf {} +` before restarting the server.
