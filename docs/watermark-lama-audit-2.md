# Watermark LaMA Spec — Audit #2

**Verdict:** GO-WITH-CHANGES

## Findings

| # | Severity | Location | Claim vs evidence | Fix direction |
|---|---|---|---|---|
| 1 | MAJOR | Spec §6.5 | V1 exports `collectWatermarkBody()`. The `watermark` branch at `job-control.js:918` currently hardcodes `opId = 'watermark_remove'`. | confirmed: Use `document.getElementById('wmEngine')?.value` in `job-control.js` to dispatch between `collectWatermarkBody()` + `watermark_remove` and the new `collectWatermarkLamaBody()` + `watermark_lama_remove`. |
| 2 | MAJOR | Spec §6.3 | Spec says "Source: `/api/thumbnail?frame=N`-style frame export" but `GET /api/thumbnail` requires `?path=` or `?hash=` alongside `&frame=N` (1-based, confirmed at `media.py:126-157`). | confirmed: Add `?path=` or `?hash=` to the spec's preview src pattern so the frontend wiring is unambiguous. |
| 3 | MINOR | Spec §5.1 vs §5.2 | Filter factory signature takes `mask_rect: tuple[float,float,float,float]` but the op receives four separate floats. | confirmed: The builder must manually construct the `mask_rect` tuple in `watermark_lama_ops.py` before passing it to `make_lama_directory`. |
| 4 | MINOR | Spec §5.1 | Spec claims double progress reporting between `run_staged_job` and the filter. | wrong: `staged_job.py:168-171` only emits a single `0/total` kickoff message, it does not emit per-frame progress. Per-frame progress from the filter is safe and will not double-report. |
| 5 | MINOR | Spec §5.2 params | `start_frame`/`end_frame` apply only to video but validation doesn't enforce this. | confirmed: Add a validation guard or documentation stating these parameters apply to video only. |
| 6 | MAJOR | Spec §5.1 | `Carve/LaMa-ONNX` might use fixed 512x512 inputs, making padding to modulo 8 insufficient. | needs-verify: The builder must check `ov.Core().read_model()` shapes and document if resize/crop is needed instead of just padding. |

## Residual-risk list

1. **Carve/LaMa-ONNX asset name/license/inputs**: needs-verify. Search indicates it might have a fixed 512x512 input, not dynamic. Builder must verify via `ov.Core().read_model` at build time.
2. **Florence-2-base model facts**: confirmed. Search confirms 0.23B parameters, MIT license, and OpenVINO conversion capability.
3. **OpenVINO `ov` API compatibility**: confirmed. Python test in this environment succeeded and imported `openvino`.
4. **GPU plugin availability**: confirmed. `ov.Core().available_devices` returned `['CPU', 'GPU']` on this box.
5. **25% area cap quality cliff**: needs-verify. Must be measured against a real sample during build.
6. **FP16 IR vs FP32 quality**: needs-verify. Must be tested with a real corner-watermark screenshot pair during build.
7. **Engine dispatch collision**: confirmed. `job-control.js` logic must explicitly branch on `wmEngine` to prevent breaking `gemini-reverse-alpha`.

## Invariant checklist

| # | Status |
|---|---|
| 1 Filter platform | Hold — `directory` stage via `run_staged_job` matches contract. |
| 2 argv-only subprocesses | Hold — OV is in-process API; stdlib `urllib` for download; no subprocess in `main.py`. |
| 3 Absolute I/O | Hold — all paths absolute throughout. |
| 4 Pixel integrity | Hold — pad/reflect + crop only, no rescale (pending LaMa input shape verification). |
| 5 Dual pools | Hold — auto-add via `maybeAutoAddOpOutput` (existing funnel). |
| 6 Wall/preview | Hold — spec explicitly forbids Wall JPEG; overlay is positioned `<div>`. |
| 7 Vanilla JS | Hold — no npm, reuses existing knob/run helpers. |
| 8 Junk weights | Hold — `mtapi-project/junk/models/lama/`. |
| 9 Progress | Hold — verified `staged_job.py` does not double-report. |
| 10 HTTP 200 + ok:false | Hold — §5.2 validation returns `OperationResult(ok=False)`. |
| 11 main.py untouched | Hold — no `main.py` changes claimed. |
| 12 Playwright proof | Hold — §7 includes real-click plan. |

## GO/NO-GO per spec section

* **§1 Problem & intent**: GO
* **§2 Engine decision**: GO (Carve/LaMa-ONNX size/input shape needs verification)
* **§3 Scope**: GO
* **§4 Weights & file layout**: GO
* **§5 Backend contract**: GO-WITH-CHANGES (Clarify `mask_rect` tuple wiring and video-only frame params)
* **§6 Frontend**: GO-WITH-CHANGES (Fix `/api/thumbnail` URI shape, implement proper `job-control.js` branching)
* **§7 Test plan**: GO
* **§8 Files touched**: GO
* **§9 Invariants honored**: GO
* **§10 Builder verify-before-code list**: GO
* **§11 Follow-ups**: GO
* **§12 Phase 2 (Florence-2-base)**: GO
