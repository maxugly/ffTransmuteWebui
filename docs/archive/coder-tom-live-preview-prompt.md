# Coder Prompt — Live Preview (Backend `latest_frame` Wiring)

> **Target:** ffTransmuteWebui / mtapi-project  
> **Role:** Builder (opencode / codewhale / codex)  
> **Kind:** **One-shot assignment** — product choices locked below; implement without re-opening design.  
> **Authoritative spec:** [`docs/workspace-progress-spec.md`](workspace-progress-spec.md) §3.7  
> **Verification:** WebUI smoke on every touched op. Spec writer cannot claim DONE — you own implementation + verify + VERSION.  
> **Related:** `app/job_control.py` (DirWatcher, `report_progress`, `latest_frame`), `app/static/js/job-control.js` (frontend poll + `_maybeShowLiveFrame`)

---

## What "one-shot" means (read this)

**One-shot** = the human gives you **one complete assignment** with locked scope, non-goals, defaults, and done criteria. You do **not** ping for "should we migrate facemorph?" mid-flight. If something is ambiguous, **prefer the locked defaults** and note the choice in the commit / STATUS.

You still:
1. Implement in **phased commits** (walk the op list → engines → clean up).
2. **WebUI-verify** each op you touch.
3. Stop only if a **system invariant** is at risk (shell=True, secret leakage, PngFramePipeline).

---

## MISSION

The `Live: ON/OFF` toggle (`#btnPreviewLive`) is in the UI and the frontend poll loop already listens for `latest_frame` in the job progress snapshot. But **only RIFE and dump-phase DirWatcher ops** actually populate it — because `_dir_watch_loop` → `_scan_pngs` already passes the lexicographically highest PNG to `report_progress(latest_frame=...)`.

**You need to wire `latest_frame` into every other op that generates images during a job.** When Live is ON, the user should see frames streaming in from DeepDream, img2img, txt2img, withoutbg, styletransfer, facemorph, Image Sort, and Upscale.

**Do not** touch the frontend at all — it's already done. `_maybeShowLiveFrame()` reads `snap.latest_frame`, hits `/api/image?path=`, handles cache-busting, and manages the `#mediaViewer`. The backend just needs to deliver the path.

---

## LOCKED DECISIONS (do not re-ask)

| # | Decision | Lock |
|---|----------|------|
| 1 | **Frontend is DONE** — do not touch `job-control.js`, `preview.js`, `app.js`, `index.html` | DO NOT TOUCH |
| 2 | `latest_frame` must be an **absolute filesystem path** matching what `/api/image?path=` serves | Locked |
| 3 | Per-frame Python loops: pass `latest_frame=output_png` into `report_progress` | Locked |
| 4 | Subprocess ops: either use `start_dir_watch` on the output dir, or scan after each progress tick | Locked |
| 5 | RIFE / dump phase **already work** via DirWatcher — do not re-wire | Locked |
| 6 | `video_pipeline.process()` signature stays the same — wire progress into the op's callback closure, not into `process()` itself | Locked |
| 7 | VERSION bump far-right **DD** once (at end, when all ops verified) | Locked |
| 8 | Git: **commit** after each logical group; **push only if human asked** | Locked |
| 9 | Secrets: never commit keys | Locked |

---

## WHAT ALREADY WORKS (do not redo)

### DirWatcher ops — `latest_frame` flows automatically

These use `start_dir_watch` → `_dir_watch_loop` → `_scan_pngs` → `report_progress(latest_frame=best_path)`. No changes needed:

| Op | Watch dir | Wired by |
|----|-----------|----------|
| RIFE | `frames_out` | `filters/rife.py` line 110 |
| Video dump phase | `frames_in` | `video_pipeline.py` dump (if wired) |
| Upscale (video) | `frames_out` | same pattern as RIFE |

### Frontend — already consuming `latest_frame`

| Component | File | Status |
|-----------|------|--------|
| Toggle `#btnPreviewLive` | `index.html` line 434 | ✅ |
| `togglePreviewLive()` | `job-control.js` line 43 | ✅ |
| Poll loop checks `p.latest_frame` | `job-control.js` line 191 | ✅ |
| `_maybeShowLiveFrame(snap)` | `job-control.js` line 52 | ✅ |
| `/api/image?path=` route | `routes/media.py` line 21 | ✅ |

### Backend infrastructure

| Piece | File | Status |
|-------|------|--------|
| `latest_frame` in progress snapshot | `job_control.py` line 70, 258-259 | ✅ |
| `_scan_pngs()` returns `(count, max_path)` | `job_control.py` line 289 | ✅ |
| `report_progress(latest_frame=...)` param | `job_control.py` line 217 | ✅ |
| `get_progress()` exposes `latest_frame` | `job_control.py` line 380 (`**snap`) | ✅ |
| Job endpoint returns full snapshot | `routes/meta.py` line 109 (`**snap`) | ✅ |

---

## PHASE 0 — SCOUT (read only)

| File | Why |
|------|-----|
| `app/job_control.py` | `report_progress`, `_scan_pngs`, `start_dir_watch` — understand the existing pattern |
| `app/operations/deepdream_ops.py` | `_dream_video_v2` — `process()` loop with `_progress` closure; `_dream_ouroboros_v2` — frame save loop |
| `app/filters/img2img.py` | `run_img2img_directory` — subprocess with PROGRESS parsing |
| `app/operations/img2img_ops.py` | stills path — copies to `frames_in`, runs `run_img2img_directory` |
| `app/operations/txt2img_ops.py` | subprocess with PROGRESS parsing; output dirs |
| `app/operations/withoutbg_ops.py` | `progress_cb` wrapper — per-frame via engine |
| `app/operations/styletransfer_ops.py` | `progress_cb` wrapper — per-frame via engine |
| `app/operations/facemorph_ops.py` | morph frame generator |
| `app/operations/imagesort_rife_ops.py` | RIFE phase uses DirWatcher (already wired); conform phase may want live |
| `app/operations/upscale_ops.py` | image path vs video path — video already wired? |
| `app/video_pipeline.py` | `process()` loop — understand where `dst` is known (line 316) |

**Key fact:** `video_pipeline.process()` has `dst = workspace.frames_out / src.name` on line 316 — the output path is available inside the loop. The progress callback `progress_cb(idx+1, total)` on line 319 is the signal point. You'll wire `latest_frame` into the closure that wraps this callback, not into `process()` itself.

---

## PHASE 1 — Per-frame ops using `video_pipeline.process()`

These ops call `process(ws, filter_fn, progress_cb=_progress)`. The `_progress` closure is where you'll add `latest_frame`.

### 1a. DeepDream video (`_dream_video_v2`)

File: `app/operations/deepdream_ops.py` lines 229-237

```python
# Current:
def _progress(current: int, total_n: int) -> None:
    if progress_cb:
        progress_cb(
            f"[frame {current}/{total_n}] dream",
            phase="video-frames",
            current=current,
            total=to_process or total_n,
            unit="frames",
        )
```

**Change:** Add `latest_frame=str(ws.frames_out / f"frame_{current-1:06d}.png")` to the `report_progress` call. The closure already has access to `ws`. Use the frame index (`current - 1` since `process()` passes `idx+1`) to construct the expected output filename.

> ⚠️ **Note:** With `frame_step > 1`, only every Nth frame gets a dream output — the rest are copies. The output path is still `ws.frames_out / src.name` (same name as input). The `current` index still refers to the loop iteration (1-based), so frame `current-1` works.

### 1b. withoutbg video

File: `app/operations/withoutbg_ops.py` — find the `progress_cb` closure that wraps per-frame progress and add `latest_frame`. The engine's `process_many` takes a `progress_cb` — track the current output path inside the callback.

Since withoutbg uses `wbe.process_many(images, ..., progress_cb=progress_cb)` and not `video_pipeline.process()`, you'll need to find where the output path is known. The `progress_cb` receives `(msg, **kw)` — add `latest_frame` to the `**kw` dict when the message indicates a frame was saved.

Look at how `withoutbg_engine.py` calls the callback — if it passes the output path, wire it. If not, the simplest approach: after each batch of `process_many` completes, scan the output directory for the newest file and report it. Or: pass the output path explicitly from the engine callback point.

### 1c. styletransfer video

File: `app/operations/styletransfer_ops.py` — same pattern as withoutbg. Find the `progress_cb` and add `latest_frame`.

---

## PHASE 2 — Subprocess ops (PROGRESS-parsing)

These ops spawn a subprocess that writes `PROGRESS N/T` lines to stdout. You know the output directory — scan it after each progress tick to find the newest file.

### 2a. img2img filter (`run_img2img_directory`)

File: `app/filters/img2img.py` lines 181-195

The subprocess writes to `dst_dir` (the `dst` parameter). Each frame output is a known path: `dst / frames[frame_idx].name`.

**Approach A (preferred — simpler):** After each `PROGRESS` parse in `_pump_stdout()`, scan `dst` with `_scan_pngs(dst)` or just `max(dst.glob("frame_*.png"), key=lambda p: int(re.search(r'(\d+)', p.name).group(1)))` and pass `latest_frame` into `report_progress`. You already import `job_control` (line 15).

**Approach B:** Pre-compute the expected output path from the progress tick. When `PROGRESS done/total` is parsed, `done-1` maps to the index in the `marked` list (`marked[done-1]` if it's 0-based). The output path is `marked[done-1][1]`. This is tighter but depends on the worker processing in order.

Pick **Approach A** — it's robust even if the worker reorders.

### 2b. txt2img ops

File: `app/operations/txt2img_ops.py` lines 169-196

The subprocess writes to output files. The `_pump` coroutine parses `PROGRESS N/T` lines from stdout. The output paths are pre-computed in `outputs` list (line 131). After each progress tick, the latest output is `outputs[done-1]` if `done > 0`.

**Change:** In the `_pump` inner function, after the `PROGRESS` parse and `report_progress` call (around line 184), add `latest_frame=str(outputs[done-1])` to the report_progress kwargs.

---

## PHASE 3 — Engine-driven per-frame (special loops)

### 3a. DeepDream Ouroboros (`_dream_ouroboros_v2`)

File: `app/operations/deepdream_ops.py` lines 258-275+

The ouroboros loop saves frames into `ws.frames_out`. Find the loop that writes frames and add `report_progress(..., latest_frame=str(out_png))` after each write. The loop should already call `report_progress` for progress tracking — just add the `latest_frame` kwarg.

### 3b. facemorph

File: `app/operations/facemorph_ops.py` — find the frame generation loop. Face morph generates intermediate frames to a workspace or output directory. After each frame is written, pass the path as `latest_frame`.

### 3c. Upscale (still image path)

File: `app/operations/upscale_ops.py` — the video path should already work via DirWatcher. The still-image path is a single-shot — set `latest_frame` to the output path once done (or before, since it's instant). Low priority since stills are fast; wire it for completeness.

---

## PHASE 4 — Image Sort conform phase

File: `app/operations/imagesort_rife_ops.py`

The RIFE phase is already wired (DirWatcher). The conform phase saves extracted keyframes — wire `latest_frame` into the conform progress callback so the user sees keyframes as they're extracted. Find the per-frame report_progress call in the conform loop and add `latest_frame=out_path`.

---

## PHASE 5 — Docs / VERSION / hygiene

1. Bump root `VERSION` far-right DD.  
2. `docs/STATUS.md` — note live preview wired for all ops; list which were touched.  
3. `docs/workspace-progress-spec.md` §3.7 — add a note at the bottom: "Wired in VERSION X.Y.Z.DD — see coder-tom-live-preview-prompt.md".  
4. Root `AGENTS.md` — add one sentence under § Progress: "All frame-generating ops push `latest_frame` for the Live Preview toggle."

---

## PHASE 6 — VERIFY (mandatory — you are the builder)

Assets: `/tmp/teste.mp4`, `/tmp/teste.png` (create if missing per root AGENTS).

### Two-mode verification (curl + WebUI)

#### Mode A: Curl (fast, per-op)

For each op, start a job from the WebUI (to get a token), then poll:

```bash
# While job runs, in another terminal:
curl -s http://localhost:24590/api/job/$TOKEN | jq '{phase,current,total,latest_frame}' 
```

`latest_frame` should be non-null once frames start generating, and should change as the job progresses.

#### Mode B: WebUI (required for DONE)

1. **Server on `:24590`**  
2. Toggle **Live: ON** (button should show "Live: ON" with `live-active` class).  
3. Run each op below — the `#mediaViewer` should show frames updating as the job runs.

### Minimum verification set

| Op | Input | What to watch |
|----|-------|---------------|
| DeepDream (video) | `/tmp/teste.mp4`, short range, 1 iter, step=1 | Frames stream in `#mediaViewer` |
| img2img (video) | `/tmp/teste.mp4`, short range, prompt="cyberpunk" | Frames update as worker progresses |
| txt2img | batch=3, prompt="test" | Output images appear as generated |
| withoutbg (video) | `/tmp/teste.mp4`, short range | Frames update |
| upscale (still) | `/tmp/teste.png` | Output shown once completed |
| Image Sort | 3 stills + RIFE ×2 | Conform frames then RIFE frames |

### Negative verification

| Check | Expected |
|-------|----------|
| Live: OFF + run any op | `#mediaViewer` should NOT update during job |
| Job finishes | `#mediaViewer` should keep last frame (not flicker/clear) |
| No `latest_frame` in response | `_maybeShowLiveFrame` short-circuits — no error |

---

## ANTI-PATTERNS

- Touching the frontend (it works)  
- Re-wiring RIFE or dump DirWatcher (already done)  
- Modifying `video_pipeline.process()` signature (wire into the closure)  
- Using `shell=True` anywhere  
- "Big bang" refactor of all engines — touch only the progress callback points  
- Changing op JSON field names or HTTP routes  
- Commit secrets  
- Push without human ask  

---

## DONE means

- [ ] Every op in the verification table returns non-null `latest_frame` during execution  
- [ ] Live: ON shows streaming frames in `#mediaViewer` for video/image-gen ops  
- [ ] Live: OFF suppresses updates  
- [ ] No frontend code touched  
- [ ] VERSION + STATUS + spec note updated  
- [ ] WebUI verification green for minimum set  
- [ ] Commits with clear messages  

---

## Handoff note for the human (morning)

Builder should leave in STATUS or SESSION-STOPPING-STATE:

- Which ops wired  
- Any that were skipped and why (e.g., engine doesn't expose output path mid-loop)  
- Any behavior surprises  
- VERSION  

**This prompt is the assignment.** Spec writer does not claim DONE.
