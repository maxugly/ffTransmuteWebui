# PTS-Aware RIFE Interpolation for VFR Sources — Spec

> **Status:** Implemented · bump root `VERSION` far-right DD on ship
> **Related:** `docs/singleclip-cfr-spec.md` (first consumer: `cfr` Path D), `app/filters/rife.py` (`resolve_rife_bin`, `normalize_frame_sequence`, single-flight lock), `app/video_pipeline.py` (`probe`/`dump`/`encode`), `app/staged_job.py`, `docs/filter-platform-spec.md`
> **Scope:** one new `app/filters/rife_pts.py` directory stage + one `video_pipeline.pts_map()` helper. No changes to `dump`, Speed tab, Sequence Instant RIFE, or `transmute` CLI. First (only) consumer is the `cfr` op.

## 1. Problem

Our pipeline receives MP4s nominally 24fps that are genuinely VFR (`vfrdet` ≈ 1.0, per-frame duration swinging 1x–1.5x nominal). CFR-first normalize (`-fps_mode cfr`) is **lossy** for these: it duplicates frames (compressing true time gaps) or drops them (widening gaps). RIFE is a black box — it cannot detect duplicates or recover true PTS, so it interpolates at the wrong position on the motion path. Ghosting/smearing worse than the original judder.

The shipped `cfr` Path B (CFR-first → RIFE) is exactly this wrong approach; it stays only as a legacy compare (human decision). The correct default interpolates from the **true timestamps**.

## 2. Proven capability (do not re-prove, do regression-test)

`rife-ncnn-vulkan` single-pair mode is the `rife_infer(a, b, t)` primitive — **no new ML dependencies** (no torch in `.venv`, iGPU-only box):

```
rife-ncnn-vulkan -0 A.png -1 B.png -o OUT.png -s <t 0~1> -m <model> [-x] [-u]
```

Verified 2026-09-08 on Intel Iris Xe, model `rife-v4.6`: red box centers 35.0 → 115.0; `-s 0.1/0.5/0.9` → 47.0 / 74.4 / 103.7 (expected 43 / 75 / 107). Monotonic, near-linear, correctly bracketed — the "HD models ignore `t`" worry does **not** apply to this combo. Builder regression-tests `-s` placement on all four shipped models (`rife-v4.6`, `rife-v4`, `rife-v2.4`, `rife-v2.3`); any model that fails the monotonicity check is rejected for the PTS path with `ok:false` (test pins v4.6 at minimum).

## 3. PTS sidecar — `video_pipeline.pts_map()`

New async helper (do **not** change `dump`'s behavior or signature):

```
pts = await pts_map(input_path, start_frame=1, end_frame=999999)
# → {"pts": [t0, t1, ...], "unit": "s", "count": N}
```

- `ffprobe -v error -select_streams v:0 -show_frames -show_entries frame=pts_time -of json`.
- Parse `pts_time` floats; drop frames with missing/negative PTS; **sort ascending by PTS** (presentation order — never trust container order with B-frames).
- Apply the same 1-based inclusive `[start_frame, end_frame]` slice `dump` uses (`sf<1→1`, `ef<sf→ef=sf`).
- Return plain seconds list. The stage asserts `len(pts) == dumped PNG count`, else `ok:false` (the PNG-index ↔ sorted-PTS mapping is load-bearing and must be asserted, not trusted).

## 4. Bracketing algorithm — `app/filters/rife_pts.py`

`make_rife_pts_directory_fn(*, target_fps, pts, model="rife-v4.6", tta=False, uhd=False, t_step=0.25)` → async `(src, dst)` with `fn.kind = "directory"`, registered as stage `"rife_pts"`.

- Timeline: `start = pts[0]`, `dur = pts[-1] - pts[0]`, `num = max(1, int(round(dur * F)))`, targets `T_i = start + i/F`, `i = 0..num-1`. Output `dst/frame_%06d.png` written **in target order** (no renumber helper needed).
- Per target: `bisect` the pts array for the bracketing pair `(a, b)`; `t = (T - a)/(b - a)` in [0,1].
- **Quantized timestep:** `t_step` ∈ [0,1] (default 0.25, user knob). `t_step == 0` → exact `t`. Else `t_q = clamp(round(t/step)*step, 0, 1)`. Error bound `step/2 × inter-frame gap` goes in the tool legend. Quantization moves *where on the motion path* the sample lands; output timing stays exactly on the `1/F` grid (no stutter reintroduced).
- **Copy-through (no inference):** `t_q == 0` → `shutil.copy2(a)`; `t_q == 1` → `shutil.copy2(b)`. Exact PNG copy, never re-encoded.
- **Inference:** `rife-ncnn-vulkan -0 <a> -1 <b> -o <dst/frame_%06d.png> -s <t_q:.4g> -m <model> [-x if tta] [-u if uhd]` via `shell.run_command` (argv list, never `shell=True`), under the shared RIFE single-flight lock (import from `filters.rife` — never run two GPU densifies at once). One per-pair failure aborts the stage with `ok:false` (no silent skip-and-copy).
- **Memo (SHOULD, cheap):** dict on `(a_idx, b_idx, t_q)` → already-written output; copy instead of re-inferring. Rarely hits, costs nothing.
- **Discontinuities:** gaps `> 4 × median_gap` are segment boundaries (cuts/edits). A target falling inside a boundary gap copies the nearest endpoint — never morph across a cut. Threshold is a module constant (`PTS_GAP_SEGMENT_FACTOR = 4.0`), unit-tested.
- **Progress/cancel:** `report_progress()` per output frame (`phase="rife_pts"`); `check_cancelled()` before each spawn. Single opaque loop — per-item reports, no dir watch needed.
- Returns `{frame_count_in, frame_count_out, inferences, copies, command}` for logs; stage log line format `rife_pts: {in} → {out} frames ({inferences} inferred, {copies} copied, t_step={step})`.

## 5. Op wiring (consumer contract — `cfr` Path D implements this)

- Resolve binary first (`resolve_rife_bin` → `ok:false` when missing, even for dry-run — same as `speedramp_ops.py:80`).
- `run_staged_job(op_id, prefix, dump_kwargs={start_frame,end_frame}, stages=[rife_pts], encode_fps=F, encode_kwargs={"mux_audio": True})`. Encode rate is **always** the resolved `F` the timeline was built at (not the staged-job ratio default).
- Output suffix for the PTS path: `_cfr_pts` (family prefix kept; distinct from `_cfr` / `_cfr_rife`).
- `dry_run` → `ok:true`, nothing written; `command` = summary, `stdout` = plan lines (`N targets @ F`, `K inferences / C copies`, `t_step`, model, output). Counts are computed from the real PTS map (probe + bisect run, binary never spawned).
- Failures are HTTP 200 + `{"ok": false}`: bad input, unresolvable FPS, empty dump, PTS/PNG count mismatch, RIFE binary missing, per-pair inference failure.

## 6. Verification

- Unit (in op's test file): bracketing (`bisect` picks the true pair, `t` exact on synthetic PTS incl. uneven gaps); quantization (`t_step=0.25` grid, `0` exact, endpoint snap); discontinuity (boundary gap → copy, no inference spawned — mock the spawn); count-mismatch → `ok:false`.
- `-s` monotonicity regression test on `rife-v4.6` (two-box fixture, three `t` values, assert ordered placement).
- Playwright (curl is not UI proof, invariant §12): real VFR clip in (`r_frame_rate != avg_frame_rate`) → PTS run → out (`r == avg`) **plus** the gap-uniformity check: `ffprobe -show_frames … pts_time` gaps all exactly `1/target_fps`. Zero new JS errors.
- Perf is measured, not asserted: builder reports wall time for the proof clip (spawn-per-frame is the known cost; a persistent-worker optimization is explicitly out of scope).
- Ship: bump root `VERSION` far-right DD + update `docs/STATUS.md` top box (no digits copied), per `AGENTS.md` §3.

## 7. Non-goals

Speed tab, Sequence Instant RIFE, `transmute` CLI, new models/backends, persistent RIFE worker, cross-cut morphing. `filters/cfr.py` (legacy compare) is untouched by this spec.
