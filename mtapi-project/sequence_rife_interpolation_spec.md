# Sequence RIFE Interpolation Spec

> **Status:** Spec (corrected)
> **Companion:** `sequence_codec_export_spec_2.0.md` (Join codec export — this feature
> layers ON TOP of it). Both touch `join()` in `app/operations/transmute_ops.py`.
> **Verified against tree @** `mtapi-project` (paths/functions below confirmed to exist).

---

## 1. Goal

When stitching clips into a sequence that has a target frame rate, or when a clip is
artificially slowed via the `durations` parameter, FFmpeg would normally **duplicate
frames** to hit the target fps — which looks like a stutter, not smooth motion.

This spec says: intercept clips that would suffer frame duplication and apply **RIFE AI
interpolation** to them *before* the final stitch, raising their frame rate smoothly.
Clips that already meet or exceed the target frame rate pass through untouched.

RIFE (rife-ncnn-vulkan) works on PNG frame folders and produces a higher-frame-count
folder. It is video-only — it has no audio. This spec handles that explicitly (§4, §6).

---

## 2. Triggering Logic & Target FPS

**Target FPS rule:**
- If the frontend provides `target_fps` in the payload, use it.
- Otherwise `target_fps = max(native_fps of all input clips)`.

**Per-clip effective fps** (mirrors `concat_clips`' `_time_factor`, video_pipeline.py:633):
- No duration stretch: `effective_fps = native_fps`
- Duration stretch (slowed): `effective_fps = native_fps * (native_duration / requested_duration)`

**RIFE condition:** if `effective_fps < target_fps - ε` (small float tolerance), the clip
needs RIFE. Otherwise leave it alone.

---

## 3. The RIFE Multiplier Math (CORRECTED)

RIFE multiplies frame *count* by an integer power of two (2x, 4x, 8x, …). The original
spec used `ceil(target_fps / effective_fps)`, which is **wrong** — for 24fps → 60fps it
yields `ceil(60/24)=3x=72fps`, and then assumed "excess frames dropped during stitch."
Dropping 12 of every 72 frames is a 1-in-6 stutter, not smoothness.

**Correct rule:**
```
multiplier = smallest power of two (2,4,8,16,…) such that (effective_fps * multiplier) >= target_fps
multiplier = max(multiplier, 2)   # RIFE requires >= 2
```
- Example: 30fps → 60fps ⇒ 2x (60). Good.
- Example: 24fps → 60fps ⇒ smallest 2^k≥2.5 ⇒ 4x (96fps). Then resample to **exactly 60**
  at the final encode (§5). 96→60 is a clean uniform decimation (every 1.6th frame), far
  smoother than 72→60 drop-and-stutter.

The key: **always overshoot to the next 2^k, then resample DOWN to the exact target_fps
at the final encode.** Never let 72fps (or any non-target rate) reach the deliverable.

---

## 4. Backend Architecture (Integration with codec-export v2.0)

**Primary location:** `app/operations/transmute_ops.py` — RIFE pre-processing runs
*inside* `join()` (or the `_join_with_preset` helper), BEFORE `concat_clips`, and feeds
the codec-export path. It must compose with the `target` codec param, not replace it.

### 4.1 Probe phase
For each `p.input_paths[i]`:
- `native_fps = await probe_fps(path)` (`app/probe.py:29` — real)
- `native_duration = await probe_duration(path)` (`app/probe.py:15` — real)
- compute `effective_fps` per §2.
Determine `target_fps` (payload or max of natives).

### 4.2 Pre-processing loop
For each clip where `effective_fps < target_fps - ε`:
1. Create a temporary sub-workspace for this clip.
2. `await dump(ws, clip_path)` → PNG frames in `ws.frames_in` (video_pipeline.py:111 — real).
3. `multiplier = pow2 >= target_fps/effective_fps` (§3).
4. `await run_rife_directory(ws.frames_in, rife_out, multiplier=multiplier)`
   (`app/filters/rife.py:62` — real; signature `(src_dir, dst_dir, *, multiplier, model, …)`).
5. Encode RIFE frames → a **video-only** intermediate at `effective_fps * multiplier`
   (e.g. `encode(ws, rife_video, fps=effective_fps*multiplier, …)` with a neutral
   libx264 crf18 — same neutral recipe `concat_clips` uses).
6. Record two things:
   - `processed_paths[i] = rife_video` (the smooth high-fps video)
   - `audio_sources[i] = ORIGINAL clip_path` (its audio — RIFE has none)

Clips that don't need RIFE: `processed_paths[i] = original`, `audio_sources[i] = original`.

### 4.3 Stitch phase — KEEP ORIGINAL AUDIO
Pass `processed_paths` as the video inputs and `audio_sources` as the audio inputs to
`concat_clips`. **This requires extending `concat_clips`** (video_pipeline.py:673) with an
optional kwarg:

```python
async def concat_clips(
    workspace, inputs, output_path, *,
    mode="pad", aspect="auto", durations=None,
    audio_inputs: list[str | Path] | None = None,   # NEW: audio source per input
    target_fps: float | None = None,                 # NEW: tag output at exact fps
) -> dict:
```

- When `audio_inputs` is given (same length as `inputs`), the `[a{i}]` fragments source
  audio from `audio_inputs[i]` while video comes from `inputs[i]`. This lets a silent RIFE
  clip carry its original clip's audio. Default `None` ⇒ audio from `inputs` (unchanged).
- When `target_fps` is given, force the stitched intermediate to that fps via
  `-r target_fps` (or `-fps_mode cfr` + output `-r`), so the intermediate is tagged at the
  exact sequence fps — NOT at 72 or 96. This prevents the wrong fps from leaking into the
  final encode.

So the call from `join()` becomes:
```python
stitched = await concat_clips(
    ws, processed_paths, intermediate,
    mode=p.mode, aspect=p.aspect, durations=p.durations,
    audio_inputs=audio_sources, target_fps=target_fps,
)
```

### 4.4 Final encode — exact fps
From the codec-export v2.0 path: `dump(intermediate)` → `encode(..., encode_preset=ep)`.
`encode` (video_pipeline.py:331) takes `fps: float` and currently receives the probed
intermediate fps. **Pass `fps=target_fps`** so the deliverable is exactly the sequence fps
(clean 60, not 72/96). The intermediate is already tagged at `target_fps` (§4.3), so this
is consistent; specify it explicitly to be safe.

If `p.target` is None (legacy H.264 path): RIFE still works — after `concat_clips` with
`target_fps`, encode to a neutral H.264 CRF18 at `target_fps` (do NOT call bash `transmute`,
which can't consume the RIFE'd inputs). NOTE: confirm with the op owner whether legacy+RIFE
is in scope; if not, return a clear error `"use_rife requires a target preset"`.

---

## 5. Frontend Updates (separate pass — DEFER)

**Locations:** `app/static/js/tabs/transmute.js` (Multi mode) + `app/static/js/pool/grid.js`
(Pool Sequence Builder). Do NOT implement alongside the backend.

- Checkbox labeled **"Smooth missing frames (RIFE)"** → payload `use_rife: boolean`.
- Optional numeric **"Sequence Target FPS"** → payload `target_fps: float | null`
  (empty = "Auto (Max of clips)").
- Both accompany the existing `target` (codec) dropdown from the v2.0 spec.
- Send in `POST /ops/join` body. `job-control.js` / `pool/persistence.js` already build that
  body (persistence.js POSTs `/ops/join` ~line 570).

---

## 6. Edge Cases & Considerations (CORRECTED)

- **Audio is the headline risk.** RIFE is frames-only. The original spec said "bake audio
  into the .mkv intermediate" — but that step would run *after* the clip is already
  video-only, and `concat_clips` would then see a silent input. **Correct approach (§4.3):**
  keep `audio_sources[i] = original clip` and feed it to `concat_clips` via `audio_inputs`.
  Audio is never separated from its owning clip; it just rides alongside the RIFE video.
- **Exact fps, not "drop excess."** Always overshoot to 2^k then resample to `target_fps`
  at encode (§3, §4.4). Never ship a non-target rate.
- **RIFE binary missing.** `run_rife_directory` → `resolve_rife_bin()` can fail if
  rife-ncnn-vulkan isn't installed. Raise a clear error (`"RIFE binary not found; install
  rife-ncnn-vulkan"`) — no stack trace, no half-written output.
- **Processing time / UX.** RIFE is GPU-heavy. If N of M clips need it, the job runs longer.
  The frontend (deferred) should show a clear "RIFE interpolating clip i/N" log; backend
  already has `job_control.start_dir_watch` progress for RIFE frames (rife.py:109).
- **`durations` interaction.** A slowed clip has lower `effective_fps`, so it's more likely
  to need RIFE — and the RIFE multiplier math (§3) already accounts for `effective_fps`.
  `concat_clips` applies `setpts` tempo from `durations`; RIFE runs on the *native-rate*
  frames first, then the slowed tempo is applied at stitch. Order is: dump (native) → RIFE
  (native×mult) → concat (apply duration stretch via setpts). Confirm this order at impl.

---

## 7. Summary of changes

| Layer | Change |
|-------|--------|
| `app/video_pipeline.py` | Extend `concat_clips` with `audio_inputs` + `target_fps` kwargs (video_pipeline.py:673). |
| `app/operations/transmute_ops.py` | Add `use_rife`, `target_fps` to `JoinParams`. Add `_rife_preprocess(...)` helper. In `join()`/`_join_with_preset`, run RIFE pre-processing before `concat_clips`; pass `processed_paths` + `audio_sources`; call `encode(..., fps=target_fps)`. |
| `app/filters/rife.py` | No change (already has `run_rife_directory`). |
| `app/probe.py` | No change (`probe_fps`/`probe_duration` real). |
| `app/static/js/**` | DEFERRED — checkbox + target_fps input (separate frontend pass). |

**Corrections vs original spec:**
1. Multiplier = smallest 2^k ≥ target/effective (was `ceil`, which over/undershoots and
   stutters on decimation). Resample to exact `target_fps` at encode (was "excess dropped
   during stitch" — wrong).
2. Audio: `concat_clips` pulls audio from ORIGINAL clips via new `audio_inputs` kwarg (was
   "bake audio into RIFE .mkv" — impossible, RIFE output is video-only and would lose audio).

**Backward compatibility:** `use_rife` defaults false ⇒ identical to today (codec-export
v2.0 behavior, or legacy H.264). No existing flow changes.
