# Coder Prompt — Watermark LaMA Inpaint Mode (engine #2)

> **Branch:** `wip` (not `main`)
> **Role:** Builder — assigned in this prompt.
> **Kind:** One-shot. Product is locked in `docs/watermark-lama-spec.md` (Audited, 2 passes, ready for builder).
> **Phase:** Phase 1 only (manual static rectangle + LaMA via direct OpenVINO). Phase 2 Florence-2 Detect-assist (§12) is NOT in this build.
> **As-built:** Watermark tab V1 shipped (`8.069`): `watermark_ops.py` (file-to-file `gwr` CLI, engine `gemini-reverse-alpha` only), `routes/watermark.py` (`GET /api/watermark/status`), `js/tabs/watermark.js` (installer card + engine dropdown with disabled placeholders), `job-control.js:917-921` hardcodes `opId = 'watermark_remove'`. `openvino` is already a hard dep; `onnxruntime-openvino`, `torch`, standalone `transformers` are NOT deps — do not add them.
> **Audits:** `docs/watermark-lama-audit-1.md` + `docs/watermark-lama-audit-2.md` (verdict GO-WITH-CHANGES). All agreed fixes are already folded into the spec — the five audit-baked callouts below are normative, not optional.
> **Verification:** `AGENTS.md` invariants + WebUI proof. Click the real Watermark engine dropdown and the real LaMA card controls.

---

## MISSION

Ship engine #2 on the Watermark tab: **`lama-openvino`** — user draws one static normalized rectangle over a tab-local preview, backend inpaints it with LaMA (`Carve/LaMa-ONNX` → FP16 OpenVINO IR, compiled `GPU`/`CPU`) via dump → `app/filters/lama.py` (`directory`) → encode for video, single-shot in-process for images. Weights under `mtapi-project/junk/models/lama/`, setup via `POST /ops/watermark_lama_setup`, status via additive `lama` block.

## READ FIRST (in this order)

1. `docs/watermark-lama-spec.md` (whole file — the lock; §§5/6/10 are the build).
2. `docs/watermark-lama-audit-2.md` (GO/NO-GO per section + residual risks — your pre-flight checklist).
3. `mtapi-project/app/operations/watermark_ops.py` (V1 validation/naming/`_ensure_output_file`/setup-phase pattern to copy; DO NOT modify this file).
4. `mtapi-project/app/operations/cfr_ops.py` lines 325–360 (`run_staged_job` + `StageSpec("…","directory",…)` + `encode_kwargs={"mux_audio": True}` call shape) and `mtapi-project/app/staged_job.py` lines 46–120 (`StageSpec`, dry-run plan shape).
5. `mtapi-project/app/filters/cfr.py` lines ~60–90 (directory-fn skeleton: glob `frame_*.png`, per-frame loop, `report_progress` per frame, `check_cancelled`, `start_dir_watch`, return `{"frame_count": …}`).
6. `mtapi-project/app/routes/watermark.py` + `mtapi-project/app/operations/__init__.py` (one import line each for the new module).
7. `mtapi-project/app/static/js/tabs/watermark.js` (whole file, 268 lines: card markup, knob wiring, `collectWatermarkBody`, status paint) + `mtapi-project/app/static/js/job-control.js` lines 917–921 (the branch you extend).
8. `mtapi-project/app/routes/media.py` lines 126–157 (`GET /api/thumbnail` requires `?path=` or `?hash=` plus 1-based `&frame=` — the preview src pattern).
9. `mtapi-project/tests/test_watermark.py` (V1 test shape to mirror; your file is new, V1 file untouched).

## LOCKED

1. New engine id **`lama-openvino`**; `general-ai` stays disabled (diffusion future), `synthid-detect` stays report-only. `watermark_remove` keeps refusing non-`gemini-reverse-alpha` engines with the existing error.
2. New ops **`watermark_lama_remove`** + **`watermark_lama_setup`** in new `app/operations/watermark_lama_ops.py` (V1 file untouched); one import line in `operations/__init__.py`. Status gains additive `lama` block only (V1 keys byte-identical).
3. Filter `app/filters/lama.py`: `make_lama_directory(mask_rect, feather_px, device, model_dir)` → `directory` fn; shared `inpaint_image()` helper for the image path (no code fork). Mod-8 `BORDER_REFLECT` pad + crop; output dims = input dims.
4. **Audit-baked callouts (normative):**
   a. Preview `src` = `/api/thumbnail?path=<abs>&frame=N` (or `?hash=`), frame 1-based — never bare `?frame=N`, never a Wall JPEG; overlay is a positioned `<div>`.
   b. `job-control.js` `watermark` branch: branch on `document.getElementById('wmEngine')?.value === 'lama-openvino'` → new op + `collectWatermarkLamaBody()`; else existing path byte-identical.
   c. Op collects four `mask_*` floats → constructs `mask_rect` tuple at the call site; tuple never on the HTTP wire.
   d. `start_frame`/`end_frame` video-only; image path ignores them (documented, never an error).
   e. Fixed-input risk: introspect `ov.Core().read_model()` FIRST (static vs dynamic dims). If fixed 512×512, letterbox/pad full frames there and crop back — no stretch of surviving pixels (invariant 4). Document the path in ship notes.
5. Rect validation: all in `[0,1]`, `w/h > 0`, area ≤ 25% of frame → else `ok:false` (hard refuse, per human decision). `feather_px` 0–8, `device` GPU|CPU|AUTO (confirmed `['CPU','GPU']` on this box; AUTO fallback logged + meta-recorded).
6. IR conversion (`ov.convert_model` → FP16 save) runs ONCE in setup; runtime only compiles + infers. Compile-smoke on CPU in setup phase 3. Lazy per-device cache, max ~2 entries, no pre-compile at boot.
7. Failures HTTP 200 + `{"ok": false}`. OV is in-process API; only subprocesses are ffmpeg bookends inside `run_staged_job` + stdlib-`urllib` download. `shell.run_command` argv only, never `shell=True`. No `main.py` changes.
8. Ship: bump root `VERSION` far-right DD, STATUS top box (no digits copied), spec banner → Implemented, `docs/archive/changelog.md` entry.

## FILES

| File | Change |
|------|--------|
| `app/filters/lama.py` | **New.** `make_lama_directory()` directory stage + `inpaint_image()` helper |
| `app/operations/watermark_lama_ops.py` | **New.** `WatermarkLamaRemoveParams` + `WatermarkLamaSetupParams` + handlers + 2 `register(OperationSpec…)` |
| `app/operations/__init__.py` | Add `watermark_lama_ops` import (one line) |
| `app/routes/watermark.py` | Additive `lama` block in status payload |
| `app/static/js/tabs/watermark.js` | LaMA card (preview + rect knobs + device + setup row) + `collectWatermarkLamaBody()` + engine-gated rows |
| `app/static/js/job-control.js` | `watermark` branch: engine-aware dispatch (extend, don't append) |
| `tests/test_watermark_lama.py` | **New.** ≥ 8 tests (see DONE) |
| `docs/watermark-lama-spec.md`, `docs/STATUS.md`, `VERSION` | Banner → Implemented, top box, DD bump |

## BUILD

1. Setup op first (download → convert → CPU smoke), then filter stage, then remove op, then frontend. Prove `ov.Core().available_devices` + `read_model()` shapes in the build log before writing inference math.
2. Dry-run prints a real plan and writes nothing (both ops).
3. Playwright on isolated port with real clicks: engine switch reveals LaMA card, frame pick re-assigns preview once, knobs move overlay + readout, dry-run echoes, real image Remove → cleaned file + preview + pool auto-add (when enabled), real short video → per-frame progress + audio kept, missing-IR → inline `ok:false`. Zero new JS errors — curl is not UI proof.
4. Full pytest green (V1 `test_watermark.py` still green) before claiming DONE.

## DO NOT

- Touch `watermark_ops.py`, V1 status keys, `general-ai`/`synthid-detect` placeholders, `main.py`, `transmute`/`bin/transmute`, or any non-watermark tab.
- Build Phase 2 (Florence-2), ProPainter, SD2/GenAI, tracked/multi-rect masks, or auto-detect.
- Add npm / frameworks / `onnxruntime-openvino` / `torch`; vanilla JS + existing knob/run helpers only.
- Vendor `D-Ogi/WatermarkRemover-AI` or `iopaint`; replicate nothing GPL — workflow inspiration only, and that's Phase 2 anyway.
- Merge to `main` unless the human asked.

---

## DONE

- [ ] `POST /ops/watermark_lama_setup` (dry-run + real) → ONNX + FP16 IR under `junk/models/lama/` + CPU smoke in meta
- [ ] `POST /ops/watermark_lama_remove` image → cleaned file, dims preserved, meta `{device_settled, mask, frame_count}`
- [ ] Same op on real short video → per-frame progress, audio kept, output non-empty, rect static across frames
- [ ] `tests/test_watermark_lama.py` ≥ 8 green (rect matrix, >25% refuse, rel-path reject, output exclusivity, no-clobber, dry-run, mod-8 round-trip, missing-IR hint, no-`shell=True` guard); full suite green
- [ ] Clicked Clean → Watermark → `lama-openvino` → card → preview → knobs → Remove → pool auto-add; V1 `gemini-reverse-alpha` path re-proven unchanged; zero new JS errors
- [ ] `VERSION` + STATUS top box + spec banner + changelog; commit on `wip`
