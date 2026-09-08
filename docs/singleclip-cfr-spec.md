# Single-Clip Ops: VFR → CFR (+ optional RIFE) — Spec

> **Status:** Implemented (Paths A–D) · bump root `VERSION` far-right DD on ship
> **Related:** `docs/pts-aware-rife-spec.md` (Path D algorithm spec — read first), `app/operations/rife_ops.py` (RIFE directory stage template), `app/operations/speedramp_ops.py` (dual fast/RIFE path + `use_rife` pattern), `app/video_pipeline.py` (`probe`/`dump`/`encode`/`pts_map`), `app/staged_job.py`, `docs/filter-platform-spec.md`
> **Scope:** one new Single-Clip Ops dropdown entry (`cfr`) + one new `POST /ops/cfr` + `avg_frame_rate` probe extension + one `app/filters/cfr.py` directory stage. No changes to Speed tab, Sequence Instant RIFE, or `transmute` CLI.

## 1. Purpose

Phone / screen-capture footage is often **VFR** (uneven time deltas between frames). RIFE assumes even-spaced input — fed raw VFR timestamps it misbehaves on fast pans because the "right intermediate" depends on knowing real elapsed time. Forum practice is to normalize **VFR → CFR first**, then interpolate.

This op makes that a one-click single-clip operation: base = CFR normalize; an optional **RIFE toggle** adds interpolation afterwards, with a **`→ CFR First` toggle** (visible only when RIFE is on, default ON) controlling whether the CFR normalize happens before RIFE or RIFE runs direct on the source timestamps.

**Rework (Path D, default RIFE path):** CFR-first is lossy for genuinely VFR sources (duplicates compress true gaps, drops widen them — RIFE can't recover the timing). The default RIFE path is now **PTS-aware bracketing** per `docs/pts-aware-rife-spec.md`: real per-frame PTS → bisect bracketing pair per output timestamp → single-pair `rife-ncnn-vulkan -s t_q` with user-configurable `t_step` quantization (default 0.25). Paths B/C stay as **legacy compare** behind the toggles. Path A (no RIFE involved) is unaffected.

## 2. Frontend (`js/tabs/transmute.js`)

### 2.1 Dropdown

```
cfr: { summary: "VFR → CFR (+ optional RIFE)", fields: ['cfr'] }
```

### 2.2 Extras (all rendered when `fields.includes('cfr')`)

- **Row 1 (always visible):**
  - `cfrFps` knob: `0 = Auto`, range 0–120 step 1 (default 0). Legend: "0 = Auto (avg_frame_rate, fallback r_frame_rate). Set an explicit rate to force it."
  - `cfrUseRife` binary knob Off/On (default Off).
- **Row 2 (visible only when `cfrUseRife == '1'`):**
  - `cfrRifeMult` knob 2–128 step 1 (2); `cfrRifeTta` / `cfrRifeUhd` binary knobs (Off); `rifeModelSelectHtml('cfrRifeModel')` (same model list as ramp: rife-v4.6 default).
  - `cfrPtsAware` binary knob Off/On (**default On**). Legend: "True-timestamp interpolation (bracket + `-s t`) — the correct VFR path. Off = legacy CFR-first / direct switch below."
  - `cfrTStep` knob 0–1 step 0.05 decimals 2 (default 0.25). Legend: "Quantize the RIFE timestep: 0.25 → 5 grid points, error ≤ step/2 × frame gap. 0 = exact (slower, no copy-throughs). Timing stays exact regardless."
  - `cfrCfrFirst` binary knob Off/On (**default On**, legacy only — ignored while PTS-aware is on). Legend: "Legacy compare: normalize to CFR before interpolation. Off = legacy direct-RIFE on source timestamps."
- Show/hide Row 2 on `cfrUseRife` change (same pattern as `zoomCustomSizeRow`). `setupContinuousKnob` / `setupBinaryKnob` for each knob.
- Tool-bottom docs one-liner stating the VFR gotcha (per `tool-bottom-docs-spec.md`).

### 2.3 Collector (`js/job-control.js`, `tab==='transmute'`, op `cfr`)

`opId='cfr'`. Body:

```
input_path (transmuteInput), output_path (transmuteOutput | null),
dry_run, start_frame/end_frame (globalInputs, 1 / 999999 defaults),
target_fps (null when cfrFps == 0, else float),
use_rife (bool), pts_aware (bool, default ON — only meaningful when use_rife),
t_step (float 0–1, default 0.25),
cfr_first (bool, legacy only — ignored while pts_aware, only meaningful when use_rife),
multiplier (int), model (string), tta/uhd (bool)
```

Numeric parsing with knob defaults, same style as the `speed_ramp` branch.

## 3. Backend (`app/operations/cfr_ops.py`, op id `cfr`)

Params (pydantic): `input_path, output_path|None, target_fps|None (ge=1, le=240), use_rife=False, pts_aware=True, t_step (ge=0, le=1, default 0.25), cfr_first=True, multiplier (2–128, default 2), model (rife-v4.6|rife-v4|rife-v2.4|rife-v2.3, default rife-v4.6), tta=False, uhd=False, start_frame/end_frame, dry_run`.

Behavior:

- Validate input is a file; else `ok:false` (HTTP 200 per invariant §10).
- Validators: `pts_aware=True` / `cfr_first=True` with `use_rife=False` are meaningless → coerce to `False` (tested). While `pts_aware` is on, `cfr_first` is ignored (record both in `meta`).
- If `use_rife`, resolve the RIFE binary first (`resolve_rife_bin`, same as `speedramp_ops.py:80`) → missing binary is `ok:false`, not a crash.
- FPS resolve: explicit `target_fps` wins; else Auto = probe `avg_frame_rate` when sane (1–240), else `r_frame_rate` fallback (§4).
- Output: `finalize_output_path(... default_suffix="_cfr"` when no RIFE, `"_cfr_rife"` legacy RIFE, `"_cfr_pts"` PTS-aware RIFE, `allowed_exts=VIDEO_EXTS)`, plus the `rife_ops.py:55` self-collision guard (never encode onto the input).
- **Path A — CFR-only (`use_rife=False`): fast ffmpeg pass, no PNG dump.** `ffmpeg -i IN -vf fps=<F> -fps_mode cfr [-ss/-to for frame range] -c:a aac OUT` (argv list, never `shell=True`). Audio re-encoded (timeline rebuilt; no stream-copy). Unchanged by the rework.
- **Path D — PTS-aware RIFE (`use_rife=True`, `pts_aware=True`, the default):** per `docs/pts-aware-rife-spec.md` §§3–5: `pts = await pts_map(input, start_frame, end_frame)` → `run_staged_job(op_id="cfr", prefix="cfr_", dump_kwargs={start_frame,end_frame}, stages=[rife_pts stage], encode_fps=F, encode_kwargs={"mux_audio": True})`. Assert PTS count == dumped count, else `ok:false`. `multiplier` is unused on this path (output count comes from the timeline, not `N×M` — record that in `meta`, ignore the knob rather than erroring).
- **Path B — RIFE + CFR-first (legacy compare):** `run_staged_job(op_id="cfr", prefix="cfr_", dump_kwargs={start_frame,end_frame}, stages=[CFR stage, RIFE stage], encode_kwargs={"mux_audio": True, ...fps override when target_fps})`. CFR stage = `make_cfr_directory_fn(fps)` from §5; RIFE stage = existing `make_rife_directory_fn(...)`. Encode fps: explicit `target_fps` wins, else staged-job default (dump_fps × out/in ratio). Unchanged, kept for A/B against Path D.
- **Path C — RIFE direct (`cfr_first=False`, legacy compare):** today's behavior: `stages=[RIFE]`, same encode rule as B. Unchanged.
- `dry_run` → `ok:true`, nothing written; `command` = argv preview (Path A) or human plan lines (Paths B/C, same shape as `staged_job` dry-run; Path D per `pts-aware-rife-spec.md` §5 with real PTS-derived counts).
- Progress: fast path is one ffmpeg pass (single encode-phase report); staged paths use `report_progress()` per item (RIFE M stays 2–128 on legacy paths; Path D reports per output frame).
- Failures (`ok:false`): bad input, unresolvable FPS, empty dump/stage output, PTS/PNG count mismatch (Path D), RIFE binary missing. Never invent a second dump/encode stack (invariant §1).

## 4. Probe extension (`app/video_pipeline.py:probe`)

Today `probe` reads only `r_frame_rate` and exposes `fps`. Add `avg_frame_rate` to the same `-show_entries` call and return `fps_avg`, `fps_r` (keep `fps` semantics untouched so `dump` and all callers are unaffected). Also return `is_vfr_guess` (`r ≠ avg` beyond epsilon) for logs/UI. CFR Auto target = `avg` if 1–240 else `r`.

## 5. CFR directory stage (`app/filters/cfr.py`) — legacy, untouched

`make_cfr_directory_fn(fps)` → async `(src, dst)` with `fn.kind = "directory"`: `ffmpeg -framerate <dump_fps> -i src/frame_%06d.png -vf fps=<F> dst/frame_%06d.png` (+ `report_progress` per item / `start_dir_watch`, `normalize_frame_sequence` if the shared helper applies). Pure resample — duplicates/drops frames to even spacing. No second dump/encode stack; lives under `app/filters/*` per invariant §1. Kept solely for legacy Path B compare; Path D does not use it.

## 6. Verification

- `tests/test_cfr.py` ≥ 8 green (existing 12 stay green): Auto resolve (avg wins; garbage avg → r fallback), explicit fps wins, `pts_aware`/`cfr_first`-without-RIFE coercion, dry-run plan for all four paths, `t_step` validator bounds, PTS/PNG count-mismatch → `ok:false`, registry contract (`cfr` in REGISTRY with params model), suffixes (`_cfr` vs `_cfr_rife` vs `_cfr_pts`) + self-collision guard. Plus `pts-aware-rife-spec.md` §6 unit set: bracketing on synthetic uneven PTS, quantization grid + exact-`0`, endpoint copy-through, discontinuity copy (spawn mocked), `-s` monotonicity regression on `rife-v4.6`.
- Playwright (curl is not UI proof, invariant §12): Single-Clip tab → `Op = VFR → CFR` → Row 1 visible, Row 2 hidden → toggle RIFE on → Row 2 (mult/model/TTA/UHD/PTS-aware default ON/`t_step` 0.25/legacy `→ CFR First`) appears → dry run → real VFR clip CFR-only (ffprobe `r_frame_rate != avg_frame_rate` in, equal out) → PTS-aware run (output gaps all exactly `1/target_fps` per the awk check) → legacy CFR-first on/off compare runs → zero new JS errors. Builder reports Path D wall time on the proof clip.
- Ship: bump root `VERSION` far-right DD + update `docs/STATUS.md` top box (no digits copied), per `AGENTS.md` §3.
