# Watermark LaMA Spec — Audit #1

**Verdict:** APPROVE-WITH-CHANGES

## Findings

| # | Severity | Location | Claim vs evidence | Fix direction |
|---|---|---|---|---|
| 1 | MAJOR | Spec §6.5, `job-control.js:918` | Spec invents `collectWatermarkLamaBody()`; V1 exports `collectWatermarkBody()` from `watermark.js:76`. The `watermark` branch at `job-control.js:918` hardcodes `opId = 'watermark_remove'` with no engine branching. | Rename to `collectWatermarkBody()` extended with lama params, or add engine-aware dispatch inside the existing `watermark` branch. |
| 2 | MAJOR | Spec §6.3, `media.py:123-157` | Spec says "Source: `/api/thumbnail?frame=N`-style frame export" but `GET /api/thumbnail` requires `?path=` or `?hash=` alongside `&frame=N` (1-based, confirmed at `media.py:126-157`). | Add `?path=` or `?hash=` to the spec's preview src pattern so the frontend wiring is unambiguous. |
| 3 | MAJOR | Spec §5.1 vs §5.2 | Filter factory signature takes `mask_rect: tuple[float,float,float,float]` (§5.1:83) but the op sends four separate `mask_x/y/w/h` floats (§5.2:114-115). The op→filter wiring is not shown. | Show the collection point in §5.2 where four floats become the tuple passed to `make_lama_directory`. |
| 4 | MINOR | Spec §5.1 para 4 | Per-frame `report_progress(phase="lama", current=i+1, ...)` inside a `run_staged_job` directory stage double-reports: `staged_job.py:168-171` already emits stage progress with `phase=stage.name` and `total=prog_total`. | Either rely on `run_staged_job` built-in progress or suppress the filter's per-frame reports. |
| 5 | MINOR | Spec §5.2 params | `start_frame`/`end_frame` are video-only but the params model doesn't enforce this; image path ignores them silently. | Add `validate` guard or doc that these apply to video only. |

## Invariant checklist

| # | Status |
|---|---|
| 1 Filter platform | Hold — `directory` stage via `run_staged_job` matches contract (`filter-platform-spec.md` §3.2, §10). |
| 2 argv-only subprocesses | Hold — OV is in-process API; stdlib `urllib` for download; no subprocess in `main.py`. |
| 3 Absolute I/O | Hold — all paths absolute throughout. |
| 4 Pixel integrity | Hold — pad/reflect + crop only, no rescale. |
| 5 Dual pools | Hold — auto-add via `maybeAutoAddOpOutput` (existing funnel). |
| 6 Wall/preview | Hold — spec explicitly forbids Wall JPEG; overlay is positioned `<div>`. |
| 7 Vanilla JS | Hold — no npm, reuses existing knob/run helpers. |
| 8 Junk weights | Hold — `mtapi-project/junk/models/lama/`. |
| 9 Progress | Hold-with-caveat — see finding #4. |
| 10 HTTP 200 + ok:false | Hold — §5.2 validation returns `OperationResult(ok=False)`. |
| 11 main.py untouched | Hold — no `main.py` changes claimed. |
| 12 Playwright proof | Hold — §7 includes real-click plan. |

## Residual-risk list (round-2 hit list)

1. **Carve/LaMa-ONNX asset name, license, sha256, input signature** (names, NCHW/NHWC, 0–1 vs 0–255, mask polarity) — §2, §5.1 para 6, §10 item 1. Not verifiable from this box; builder must introspect with `ov.Core().read_model`.
2. **Florence-2-base model facts** (§12): 0.23B param count, MIT license, 4-part conversion claim (image encoder + input embedding + encoder + decoder) — no local copy or citation to verify.
3. **OpenVINO `ov` API compatibility** with installed `2026.3.1-22476` — `ov.convert_model`, `compress_to_fp16=True`, `core.compile_model` all need to match the installed API surface.
4. **GPU plugin availability** on this box — spec targets Intel iGPU; `ov.Core().available_devices` would show `GPU` or not. Currently unverifiable (OpenVINO Core import failed in audit environment).
5. **25% area cap quality cliff** — §5.2 validation refuses >25% but the number is asserted, not measured against a real sample.
6. **FP16 IR vs FP32 quality** — §10 item 5; needs real corner-watermark screenshot pair.
7. **Engine dispatch collision** in `job-control.js:918` — the existing `watermark` branch must be extended, not appended; round 2 should verify the exact branching logic doesn't break V1 `gemini-reverse-alpha` Run.
