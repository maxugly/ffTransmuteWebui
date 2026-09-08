# Coder Prompt — Single-Clip VFR → CFR (+ optional RIFE)

> **Branch:** `wip` (not `main`)
> **Role:** Builder — assigned in this prompt.
> **Kind:** One-shot. Product is locked in `docs/singleclip-cfr-spec.md`.
> **As-built:** No VFR→CFR op exists. `probe` reads only `r_frame_rate`; `dump` preserves source timestamps (`-fps_mode vfr/passthrough`); RIFE assumes even-spaced input. `rife_ops.py` is the staged-job template, `speedramp_ops.py` the dual fast/RIFE + `use_rife` pattern.
> **Verification:** `AGENTS.md` invariants + WebUI proof. Click the real Single-Clip Op dropdown.

---

## MISSION

Ship one new Single-Clip Ops entry **`cfr`** ("VFR → CFR (+ optional RIFE)"): base = CFR normalize with Auto+override FPS; a RIFE toggle adds interpolation, revealing the normal RIFE controls plus a **`→ CFR First`** toggle (default ON). RIFE-off = fast single ffmpeg pass (no PNG dump).

## READ FIRST (in this order)

1. `docs/singleclip-cfr-spec.md` (whole file — the lock).
2. `mtapi-project/app/operations/rife_ops.py` (whole file, 125 lines): staged-job bookend to copy.
3. `mtapi-project/app/operations/speedramp_ops.py` lines 67–185: `use_rife` gating + `resolve_rife_bin` + multi-stage `run_staged_job`.
4. `mtapi-project/app/video_pipeline.py` `probe` (lines 34–96) + `dump` (lines 111–184, note `-fps_mode vfr/passthrough`) + `filters/rife.py` `run_rife_directory` / `make_rife_directory_fn`.
5. `mtapi-project/app/static/js/tabs/transmute.js` `transmuteOpsDetails` + `updateTransmuteExtras` + the `speed_ramp` extras/collector pair; `job-control.js` lines 636–719 (`tab==='transmute'` branch).

## LOCKED

1. Op id **`cfr`**, route `POST /ops/cfr`. Dropdown: `cfr: { summary: "VFR → CFR (+ optional RIFE)", fields: ['cfr'] }`.
2. Params: `input_path, output_path|None, target_fps|None (1–240), use_rife=False, cfr_first=True, multiplier 2–128 (2), model rife-v4.6|v4|v2.4|v2.3 (v4.6), tta/uhd False, start_frame/end_frame, dry_run`. `cfr_first` without RIFE coerces to False (or `ok:false` — pick one, test it).
3. FPS knob `0 = Auto` on the wire as `target_fps=null`. Auto = probe `avg_frame_rate` when sane (1–240), else `r_frame_rate`.
4. Three paths: **A** CFR-only = fast `ffmpeg -vf fps=<F> -fps_mode cfr -c:a aac` (no dump); **B** RIFE CFR-first = `dump → cfr stage → RIFE stage → encode`; **C** RIFE direct = `dump → RIFE → encode`. Suffixes `_cfr` / `_cfr_rife` + input self-collision guard.
5. `probe` keeps `fps` semantics untouched; adds `fps_avg`, `fps_r`, `is_vfr_guess`.
6. `app/filters/cfr.py` holds `make_cfr_directory_fn(fps)` (`fn.kind="directory"`, progress per frame). Import it in `filters/__init__.py` alongside the other stages.
7. Row 2 (`Frame ×`, model, TTA, UHD, `→ CFR First` default ON) renders **only** when `cfrUseRife == '1'`.
8. Failures are HTTP 200 + `{"ok": false}`. Subprocesses = `shell.run_command` + argv lists, never `shell=True`. No subprocess in `main.py`. No `from __future__ import annotations` in `main.py` (untouched anyway).
9. Ship: bump root `VERSION` far-right DD, STATUS top box (no digits copied), spec banner Ready→Implemented.

## FILES

| File | Change |
|------|--------|
| `app/operations/cfr_ops.py` | **New.** `CfrParams` + handler + `register(OperationSpec(id="cfr", …))` |
| `app/operations/__init__.py` | Add `cfr_ops` import |
| `app/filters/cfr.py` | **New.** `make_cfr_directory_fn(fps)` directory stage |
| `app/filters/__init__.py` | Import `cfr` stage |
| `app/video_pipeline.py` | `probe`: add `avg_frame_rate`, return `fps_avg`/`fps_r`/`is_vfr_guess` |
| `app/static/js/tabs/transmute.js` | `cfr` dropdown entry + extras (Row 1 always, Row 2 gated on RIFE) + knob wiring + tool-docs line |
| `app/static/js/job-control.js` | `activeTransmuteOp === 'cfr'` body branch |
| `tests/test_cfr.py` | **New.** ≥ 6 tests (see DONE) |
| `docs/singleclip-cfr-spec.md`, `docs/STATUS.md`, `VERSION` | Banner → Implemented, top box, DD bump |

---

## BUILD

1. Probe first, then op, then filter stage, then frontend.
2. Dry-run must print a real plan for all three paths and write nothing.
3. Playwright with a real VFR clip: ffprobe shows `r_frame_rate != avg_frame_rate` in, equal out (CFR-only). Then RIFE on with CFR-first on/off. Zero new JS errors — curl is not UI proof.
4. Full pytest green before claiming DONE.

## DO NOT

- Touch Speed tab, Sequence Instant RIFE, `transmute` CLI, or `main.py` routing.
- Change `probe["fps"]` semantics or `dump`'s default timestamp behavior.
- Add npm / frameworks; vanilla JS + knobs only.
- Merge to `main` unless the human asked.

---

## DONE

- [ ] `POST /ops/cfr` CFR-only on real VFR clip → CFR output (`r == avg`), audio kept
- [ ] RIFE + CFR-first → interpolated output, no fast-pan timestamp artifacts path exercised
- [ ] RIFE direct (`cfr_first=False`) → legacy behavior, output exists
- [ ] `tests/test_cfr.py` ≥ 6 green (Auto/explicit resolve, validator, 3 dry-runs, registry, suffix); full suite green
- [ ] Clicked Single-Clip dropdown → Row 2 gating works → dry run + real run → zero new JS errors
- [ ] `VERSION` + STATUS top box + spec banner; commit on `wip`
