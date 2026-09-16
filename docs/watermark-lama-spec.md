# Watermark tab — LaMA inpaint mode (engine #2) — Spec

> **Status:** Audited (2 passes: `watermark-lama-audit-1.md`, `watermark-lama-audit-2.md`, verdict GO-WITH-CHANGES) — finalized, ready for builder.
> **Hat:** Spec writer. Do not re-spec shipped V1 (`watermark-tab-spec.md`, Shipped `8.069`).
> **Upstream model:** `Carve/LaMa-ONNX` (`lama_fp32.onnx`, LaMA Big-LAMA ONNX export) + OpenCV Zoo LaMA sample as shape reference.
> **Target hardware:** Intel iGPU (i5-1335U / Iris Xe class), no NVIDIA dependency.
> **Decision:** Direct OpenVINO IR (primary). `onnxruntime-openvino` fallback (optional). OpenVINO GenAI SD2-inpainting explicitly deferred.

---

## 1. Problem & intent

V1 (`gemini-reverse-alpha`) is pixel-exact but only matches the known Gemini bottom-right logo pattern. Any other watermark — corner bugs, semi-transparent overlays, burned-in text, unknown-vendor logos — fails/skips by design.

**Goal:** a second engine on the same Watermark tab that inpaints a **user-drawn static rectangle** with LaMA, accelerated on the Intel iGPU via OpenVINO:

1. User frames the watermark once with an x/y/w/h rectangle over a tab-local preview.
2. Backend builds one fixed binary mask from that rectangle and runs LaMA per frame (video) or once (image).
3. Output is a cleaned file with the standard `*_clean` naming + pool auto-add funnel.

**Explicitly not this spec:** automatic watermark detection/segmentation, tracking a moving watermark, multi-rectangle masks, diffusion inpainting (SD2/OpenVINO-GenAI), ProPainter video propagation, hosted APIs.

---

## 2. Engine decision (read before building)

| Option | Verdict |
|---|---|
| **A. Direct OpenVINO** (`ov.convert_model(lama_fp32.onnx)` → IR → `compile_model(..., "GPU"/"CPU")`) | **Primary.** `openvino` is already a hard dep (`requirements.txt`); zero new Python deps; best iGPU performance; converted IR is cacheable on disk. |
| **B. `onnxruntime-openvino`** (`providers=["OpenVINOExecutionProvider","CPUExecutionProvider"]`) | **Fallback only.** Easiest drop-in but adds a new dep (`onnxruntime-openvino`) not in `requirements.txt`. Builder wires it as a try/except fallback when direct OpenVINO compile fails, or documents why it was skipped. Do not install both paths as equals. |
| OpenVINO GenAI `InpaintingPipeline` (SD2-inpainting) | **Out.** Overkill for small static watermarks; new heavy dep (`openvino_genai`); keep `general-ai` dropdown placeholder for this future. |
| ProPainter / WatermarkRemover-AI / iopaint | **Out.** PyTorch-only, no OpenVINO path, wrong weight class for a corner bug. |

Model file: `lama_fp32.onnx` from `Carve/LaMa-ONNX` (builder verifies exact filename + license + input names/shapes at build time against the downloaded file and the OpenCV Zoo sample — do not trust §5's sketches blindly).

---

## 3. Scope

**In:**

- Engine id `lama-openvino` enabled in the Watermark tab dropdown (takes the "general-AI remover" slot from V1 §3 concretely; `general-ai` stays as a disabled diffusion-future placeholder, `synthid-detect` stays report-only).
- `POST /ops/watermark_lama_remove` (image + video, filter-platform path — §5).
- `POST /ops/watermark_lama_setup` (download ONNX → convert to IR; tab-local installer row).
- `GET /api/watermark/status` extended with a `lama` block (no contract break: additive key only).
- Tab-local preview + rectangle card (§6).

**Out (named follow-ups, not built):**

- Phase 2 Detect-assist (§12) — manual rectangle is Phase 1 and stays as the fallback.
- Moving/tracked masks, per-frame keyframed rects, multi-rect masks (one static rect, §6.2).
- SD2/OpenVINO-GenAI diffusion mode (stays behind the disabled `general-ai` placeholder).
- Browser-side canvas inpainting (invariant 7 — no npm in SPA).

V1 contract untouched: `watermark_remove` keeps accepting only `gemini-reverse-alpha` and keeps refusing `lama-openvino` with the existing planned-engine error; global Run dispatches `lama-openvino` → the new op (§6.5).

---

## 4. Weights & file layout (invariant 8)

Weights/throwaways live under `mtapi-project/junk/` **only** — never `tools/` (vendored code), never `app/models_openvino/`:

```
mtapi-project/junk/models/lama/
  lama_fp32.onnx            # downloaded, byte-pinned (sha256 recorded in setup meta)
  lama_fp32_fp16.xml/.bin   # converted IR (compile target), written by setup
```

- No new Python dep for download: stdlib `urllib` in the setup op.
- IR conversion (`ov.convert_model` + `ov.save_model(..., compress_to_fp16=True)`) runs **once in setup**, not per request. Runtime only does `core.compile_model(ir, device)` + inference.
- In-memory compiled-model cache: lazy per `device` key, small LRU (1–2 entries) — 16 GB shared-RAM box, do not pre-compile at boot (same posture as `amused-openvino-spec.md` §11).

---

## 5. Backend contract

### 5.1 New filter `app/filters/lama.py` — `directory` kind (invariant 1)

V1 was deliberately file-to-file (not filter-platform). LaMA returns to the platform: **dump → `app/filters/lama.py` → encode**, mid-chain PNG `frame_%06d.png` start `0`, no second dump/encode stack.

```python
async def make_lama_directory(
    *, mask_rect: tuple[float, float, float, float],  # normalized x,y,w,h (§6.2)
    feather_px: int = 1,
    device: str = "GPU",        # GPU | CPU | AUTO
    model_dir: Path,            # junk/models/lama (absolute, resolved server-side)
    margin_px: int = 32,        # context-crop margin (0 = full-frame fallback)
    **kwargs,
) -> DirectoryFn: ...
```

Directory-fn duties (all inside the stage, platform owns bookends):

1. Compile once per call (or hit the lazy cache): `core.read_model(ir) → compile_model(ir, device)`. `AUTO` tries `GPU`, falls back to `CPU` with a one-line log (unlike generative compare-modes, silent fallback is acceptable here — record the settled device in the returned meta dict).
2. Fixed mask: rasterize the normalized rect against the **first frame's W×H** (§6.2), dilate by `feather_px`, keep single-channel `uint8` (255 = inpaint).
3. Per frame `i`: read PNG → context-crop around the feathered mask bbox expanded by `margin_px` per side (clamped; full-frame fallback when `margin_px <= 0`, mask empty, or crop covers the frame) → BGR `float32/255` + mask → fixed-512 canvas (downscale-only + `BORDER_REFLECT_101` pad; FFC mod-8 satisfied inside the 512 canvas) → OV infer → unpad → resize back → composite-only-inside-mask (`out = src*(1-m) + model*m`, feathered `m`; exact-zero pixels are source-exact) → paste crop at origin → write `dst_dir / frame_%06d.png` (start 0, continuous). **Model-bound mask is binarized at 0.5** — feeding the feathered float mask collapses the fill toward mid-intensity (root-caused 2026-09-16: flat-red hole fills 130 soft vs 254 binary, same image; regression test `test_flat_field_fills_to_background_real_model`).
4. `report_progress(phase="lama", current=i+1, total=N, unit="frames")` every frame (invariant 9); `check_cancelled()` between frames. No double-report: `staged_job.py` emits only a single `0/total` kickoff for a directory stage, never per-frame progress (audit-2 verified) — the filter's per-frame reports are the real progress. `start_dir_watch` applies where the platform provides it.
5. Return `{"frame_count": N, "device": settled, "mask": {...}}` for the op's meta. The op (§5.2) collects the four `mask_x/y/w/h` floats and constructs the `mask_rect` tuple at the call site before invoking `make_lama_directory` — the tuple is never on the HTTP wire.

Image inputs: the thin op (§5.2) runs the same compiled model once in-process (no dump) and writes the output image directly — same mask/pad/crop math, no code fork (share a `inpaint_image()` helper with the directory fn).

Input-name/shape (resolved, was audit-2 finding 6): `Carve/LaMa-ONNX` is `image` (N,3,512,512) f32 [0,1] RGB + `mask` (N,1,512,512) f32 **binary**, 1 = hole; output `output` (N,3,512,512) f32 [0,255]. Spatial dims STATIC 512 — the filter letterboxes (downscale-only, never upscale) into the 512 canvas and composites the hole back at full res; surviving pixels are never stretched (invariant 4). No guessed constants in the shipped code (`introspect_ir` refuses non-static/non-square graphs).

### 5.2 `POST /ops/watermark_lama_remove`

New module `app/operations/watermark_lama_ops.py` (V1 file untouched), registered by side effect. Params:

```json
{
  "input_path": "/abs/in.mp4",
  "output_path": "/abs/out.mp4 | null",
  "out_dir": "/abs/dir | null",
  "overwrite": false,
  "engine": "lama-openvino",
  "mask_x": 0.82, "mask_y": 0.86, "mask_w": 0.15, "mask_h": 0.10,
  "feather_px": 1, "grow_px": 0,
  "margin_px": 32,
  "device": "GPU", "precision": "fp16",
  "blend": "linear", "sharpen": 0.0, "sharpen_radius": 1.0,
  "color_match": false, "mask_thresh": 0.5, "upscale": 1.0,
  "start_frame": 1, "end_frame": 999999,
  "dry_run": false
}
```

Finish pipeline (all composite-aware, applied in order): `blend` linear (alpha) | poisson (seamlessClone) | mono (monochrome transfer — fill texture, source color; the lighter-box fix); `sharpen` 0–2 unsharp amount on the filled region (+ `sharpen_radius` 0.5–3 sigma, Advanced); `color_match` fits the fill's per-channel mean/std to the surrounding ring (Advanced); `grow_px` 0–16 hard-dilates the mask first (swallows antialiased text halos); `upscale` 1–4 lets small crops upscale into the 512 canvas (CUBIC) for extra model detail; `mask_thresh` 0.1–0.9 is the model-bound mask binarization (Advanced); `precision` fp16 (default) | fp32 (setup builds both IRs; fp32 = slower, less banding).

Validation (fail = `OperationResult(ok=False)`, never HTTP 4xx — invariant 10):

- `input_path` absolute + exists; `engine` must be the literal `lama-openvino` (anything else → `ok:false`, pointing at the tab dropdown).
- `mask_*` all in `[0,1]`, `mask_w/h > 0`, rect area > 0 and ≤ 25% of frame (refuse full-frame "removals" — LaMA hallucinates at that scale; point at `general-ai` future).
- `feather_px` in `0–8`; `margin_px` in `0–256` (default 32; 0 = full-frame inference); `device` in `GPU|CPU|AUTO`; `start/end_frame` 1-based inclusive (`frame-range-spec.md`), **video-only** — the image path ignores them (documented, never an error); `output_path` ⊕ `out_dir` mutually exclusive; defaults mirror V1 (`<stem>_clean.<same ext>` image, `<stem>_clean.mp4` video); `overwrite=false` + existing target → `ok:false` naming the file.
- Model IR present under `junk/models/lama/` else `ok:false` with the setup hint (`Clean → Watermark → LaMA Setup`, i.e. `watermark_lama_setup`).

Execution:

- Video: `run_staged_job(op_id="watermark_lama_remove", …, dump_kwargs={start_frame, end_frame}, stages=[StageSpec("lama","directory",…)])`, audio muxed through (watermark is pixels, never a reason to drop audio).
- Image: single-shot in-process inference, same helper.
- Dry-run: `ok:true, output_path:null, command:<human-readable summary, no subprocess>, meta.dry_run=true`, writes nothing.
- Result meta: `{engine, device_settled, mask:{x,y,w,h,px:{...}}, frame_count}`; `command` echoes the summary; output verified exists + non-empty before `ok:true` (same `_ensure_output_file` posture as V1).

### 5.3 `POST /ops/watermark_lama_setup` + status

`{ action: "install" | "update", dry_run }` — phases: (1) download `lama_fp32.onnx` if absent/byte-mismatched, (2) `ov.convert_model` → FP16 IR save, (3) compile-smoke on `CPU` (tiny synthetic input, no media needed). One `report_progress` per phase, cancel-safe between phases, `dry_run` prints phases and changes nothing. Ends with fresh `GET /api/watermark/status` payload in `meta` + `recommend_restart: false`.

Status gains one additive block (V1 keys byte-identical):

```json
{ "lama": { "onnx_present": true, "ir_present": true, "sha256": "…", "devices": ["CPU","GPU"] } }
```

---

## 6. Frontend — LaMA card on the existing Watermark tab

Vanilla only (invariant 7). Reuse `knobUnitHtml`/`setupContinuousKnob`, `bestInput()`, `runOpWithCancel`/`displayOpResult`, `maybeAutoAddOpOutput`, `tool-docs` — zero new infra. No new nav, no new tab.

### 6.1 Layout (the user's ask, refined)

A **tab-local `LaMA inpaint` card**, visible only when Engine = `lama-openvino` (gwr-only bitrate/timeout rows hide in this mode and vice versa):

```
[Engine: lama-openvino ▾]
┌ LaMA inpaint ─────────────────────────────┐
│ ┌ Preview ──────────────┐  Frame: [First▾]│
│ │ <img id=wmLamaPrev>   │  (First/Last/   │
│ │ <div id=wmLamaRect>   │   Mid/N + num)  │
│ └───────────────────────┘                 │
│ X [knob 0–1]  Y [knob 0–1]                │
│ W [knob 0–1]  H [knob 0–1]  Feather [0–8] │
│ 640×360 px readout · 12.0% of frame       │
│ Device [GPU▾]  [Setup] [Refresh] status…  │
│ [Remove with LaMA]  (global Run = same)   │
└───────────────────────────────────────────┘
```

### 6.2 Rectangle semantics (normative)

- Four continuous knobs `mask_x/y/w/h`, range `0–1`, step `0.005`, plus a live pixel readout (`x,y,w,h px` + `% of frame`) computed against the preview frame's natural size.
- **One static rect for the whole job**, rasterized against the first decoded frame's W×H; same pixel box (clamped per frame) applied to every frame. Moving watermarks are out of scope (§3) — say so in the card hint.
- Clamp to frame bounds; zero/negative area refused client-side with an inline message (server re-validates, §5.2).
- Defaults: bottom-right `x=0.80 y=0.84 w=0.17 h=0.12` (typical corner bug; user adjusts).

### 6.3 Preview (hard rules — invariant 6)

- Source: `GET /api/thumbnail?path=<abs>&frame=N` (or `?hash=<hash>&frame=N`; `frame` is 1-based — `app/routes/media.py:126-157`) for the current global input, or first/last PNG extraction — **never** a Wall JPEG, never the global preview element.
- `<img>` gets `src` assigned **once per frame-pick**; never clear `img.src` because a shell was reused; overlay is a positioned `<div>` (outline + dim outside), not a second video element, not canvas pixel surgery.
- Frame picker: First / Last / Mid / N (numeric). Changing frame re-assigns `src` once; rect knobs are resolution-independent (normalized) so they survive frame switches.
- Mask overlay preview is rect-outline only (no fake inpaint preview — LaMA preview = the real op).

### 6.4 Buttons & flows

- **Remove with LaMA** (primary) + global **Run** (when engine is `lama-openvino`) → `watermark_lama_remove` → `displayOpResult` → `maybeAutoAddOpOutput` (file outputs only; Detect/Inspect never touch pools — invariant 5 unchanged).
- **Setup / Refresh** drive §5.3 + status block; busy disables the card; missing-IR state shows the setup hint inline and refuses Remove with `ok:false` (not a modal).
- `tool-docs` append: what LaMA is (Fourier-conv inpainting, fills from surrounding pixels — not pixel-exact like reverse-alpha), when to use which engine (known Gemini logo → reverse-alpha; everything else small + static → LaMA; large/complex → wait for `general-ai`), mod-8 pad note, weights path + source.

### 6.5 Dispatch (`job-control.js`)

The existing `watermark` branch (`job-control.js:918`) hardcodes `opId = 'watermark_remove'` — extend it, do not append beside it. Branch on the live dropdown value: `document.getElementById('wmEngine')?.value === 'lama-openvino'` → `watermark_lama_remove` + `collectWatermarkLamaBody()`; otherwise → existing `watermark_remove` + `collectWatermarkBody()` unchanged (V1 `gemini-reverse-alpha` path byte-identical behavior).

---

## 7. Test plan

**Unit (`tests/test_watermark_lama.py`, new — V1 file untouched):** rect validation matrix (out-of-range, zero-area, >25% refuse, rel-path reject, output/output-dir exclusivity, no-clobber); margin default/validation + crop-box matrix + crop-vs-full fake-model consistency; dry-run writes nothing; mod-8 pad/crop round-trip on odd dims; flat-field fill regression (`test_flat_field_fills_to_background_real_model` — guards the 2026-09-16 soft-mask root cause); still-fixture outside-mask-unchanged (real model); missing-IR → `ok:false` + setup hint; no `shell=True` grep guard (only the stdlib download + OV API; ffmpeg only inside `run_staged_job` bookends).

**API:** monkeypatched stage fn: `ok:true` + absolute `output_path` + meta (`device_settled`, `mask`, `frame_count`); cancel mid-batch → `Cancelled by user`; failures always HTTP 200 + `ok:false`.

**Playwright (WebUI proof — click the real control, invariant 12):** Clean → Watermark → Engine `lama-openvino` reveals LaMA card; frame pick re-assigns preview `src` once with rect overlay; knobs move overlay + pixel readout; dry-run echoes command, no file; real image Remove → cleaned file + preview + pool auto-add (when enabled); real short video → per-frame progress, audio kept, output non-empty; missing-model path shows inline `ok:false`; zero new console errors.

---

## 8. Files touched (build hint)

- `app/filters/lama.py` — **new** `directory` stage + shared single-image helper.
- `app/operations/watermark_lama_ops.py` — **new** (`watermark_lama_remove`, `watermark_lama_setup`); one import line in `app/operations/__init__.py`.
- `app/routes/watermark.py` — additive `lama` block in status (V1 keys untouched).
- `app/static/js/tabs/watermark.js` — LaMA card + `collectWatermarkLamaBody()` + engine-gated rows (no new tab module).
- `app/static/js/job-control.js` — engine-aware dispatch.
- `tests/test_watermark_lama.py` — **new**.
- Ship: root `VERSION` far-right DD bump + STATUS top box + `docs/archive/changelog.md` (not this spec).

## 9. Invariants honored

1. Filter platform: dump → `app/filters/*` (`directory`) → encode, `frame_%06d.png` from 0. 2. `shell.run_command` argv only (no subprocess in `main.py`; OV is in-process API). 3. Absolute I/O. 4. Pixel integrity: no rescale — pad/reflect + crop only, output dims = input dims. 5. Pools via existing auto-add funnel. 7. Vanilla, no npm. 8. Weights under `junk/models/lama/`. 9. `report_progress()` every frame/phase. 10. Failures HTTP 200 + `ok:false`. 12. Playwright clicks, not curl.

---

## 10. Builder verify-before-code list (resolved 2026-09-16 unless noted)

1. `Carve/LaMa-ONNX` exact asset name, license (Apache-2.0), sha256 (`1faef530…`, full hash in setup meta + ship notes) — confirmed.
2. Real OV input signature via `read_model` introspection — confirmed: `image` NCHW f32 [0,1] RGB, `mask` binary 1 = hole, `output` [0,255]; static 512×512.
3. `GPU` plugin: confirmed present on this box (`available_devices == ['CPU','GPU']` per audit-2); `AUTO` fallback still logged + meta-recorded.
4. Large-mask quality cliff: validate the 25% cap against one real watermark sample (adjust the number, never drop the cap silently).
5. FP16 IR vs FP32 quality on a real corner watermark (one screenshot pair in the ship proof).
6. Florence-2-base facts (Phase 2 only): 0.23B params, MIT — confirmed via search per audit-2; 4-part OV conversion still needs proving at Phase-2 build time.

## 11. Follow-ups (not this spec)

Tracked/multi-rect masks, SD2 diffusion mode behind `general-ai`, ProPainter temporal propagation (needs CUDA — not this box).

## 12. Phase 2 — Detect-assist (Florence-2-base, optional, after Phase 1 ships)

Borrow WatermarkRemover-AI's **workflow, not its stack**: detect → preview boxes → user accepts → LaMA inpaints. Do not vendor `D-Ogi/WatermarkRemover-AI`, do not add PyTorch/`iopaint`/PyWebview deps.

- **What it is:** `microsoft/Florence-2-base` (0.23B, MIT) via prompt-grounding (`<OPEN_VOCABULARY_DETECTION>watermark`), converted to OpenVINO IR per the official OpenVINO Florence-2 notebook (4-part split: image encoder + input embedding + encoder + decoder). Base only — large (0.77B) is out.
- **Why optional/second:** it is a generative seq2seq model (autoregressive decode, not one forward pass), so conversion is fiddlier than LaMA and CPU inference is slow per frame (upstream and Roboflow both say GPU-recommended). Detection quality on ambiguous overlays is hit-or-miss by their own admission.
- **How it plugs in (preview-first, same card):** new `POST /ops/watermark_lama_detect` runs detection on **1–3 sampled frames only** (first/mid/last — never every frame), returns candidate boxes + scores; the LaMA card draws them as clickable outlines over the tab-local preview; clicking one fills the §6.2 rect knobs (user still adjusts + confirms). Boxes over the §5.2 area cap are shown rejected, same as their `max-bbox-percent` gate. Manual rect stays available when detection finds nothing.
- **Weights:** `mtapi-project/junk/models/florence-2-base/` (IR only, converted at setup). Setup extends §5.3 with a `florence` phase; status `lama` block gains `florence_ir_present`.
- **Kill criteria (write into the builder ticket):** if base-model CPU detect on one frame exceeds ~60 s wall or needs `transformers`+`torch` beyond what the project already pulls via `diffusers`, stop — manual rect remains the shipped story and Phase 2 is dropped, not forced.
