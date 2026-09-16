# Erase tab — Spec

> **Status:** Implemented, unshipped (no VERSION bump yet).
> **Upstream:** Sanster/iopaint erase path (`InpaintModel.__call__` / `_pad_forward` / `_run_box`, Apache-2.0) + `InpaintRequest` erase settings verbatim. Weights: `Carve/LaMa-ONNX` (`lama_fp32.onnx`, Apache-2.0). Replaces both nuked LaMA attempts (see STATUS removal row) — no code shared with them except the weights dir.

---

## 1. Settings (iopaint verbatim, box-forced adaptations noted)

| Setting | Value | Source |
|---|---|---|
| Mask | binary exactly as painted/drawn, threshold 127 | `boxes_from_mask` / `mask < 127` paste |
| HD strategy | Original / **Crop** / Resize | `HDStrategy`, default CROP |
| Crop trigger | **800** (longer side above → crop) | `hd_strategy_crop_trigger_size` |
| Crop margin | **128** | `hd_strategy_crop_margin` |
| Resize limit | **1280** (CUBIC back, masked-only paste) | `hd_strategy_resize_limit` |
| Composite | masked area only | `_pad_forward` |
| Normalization | RGB [0,1] in, [0,255] out | `norm_img` / `forward` |

Adaptations (measured on our weights):
- **Fixed 512 canvas** (Carve README: dynamic shapes break irfft): IOPaint-style downscale-only preparation with symmetric bottom/right padding. The fixed ONNX shape is the only adaptation; no synthetic hole fill or resize heuristic is used.
- **Edge-compensated crop** (iopaint `_crop_box`): shifted to keep size at frame edges.
- fp16 IR (measured identical to fp32 on GT — no knob).

No feather/fade/sharpen/blend/upscale/precision knobs. Brush (paint/erase/undo/clear, wheel = size) + normalized rect fallback.

## 2. Contract (house rules)

- `POST /ops/erase_remove` (`app/operations/erase_ops.py`): painted `mask_b64` wins, else rect fallback (area capped 25%). Video via `run_staged_job` (dump → `erase` directory stage → encode, audio kept) + frame-range + dry-run; image single-shot in-process. Failures HTTP 200 + `ok:false` (invariant 10).
- `POST /ops/erase_setup` (download + fp16 IR + CPU smoke) + `GET /api/erase/status` (`app/routes/erase.py`).
- Outputs via `finalize_output_path` (never-overwrite `_0001`).
- Frontend `js/tabs/erase.js` (own Clean nav item, own `erase` form-state key): preview + paint canvas overlay (pointer draw, right-drag erase, wheel size, undo/clear, eraser toggle, pulsing run state) + rect fallback + HD selects + device + setup row + dry-run + tool-docs. Global Run dispatches `erase` → `erase_remove`.
- `report_progress()` every frame (invariant 9). Vanilla JS (invariant 7). `main.py` gains two include lines only.

## 3. Proof

- `tests/test_erase.py`: 15 green (HD validation/defaults, mask PNG decode, mask/window units, dry-run, fake-model Original/Crop/Resize paths, real-model 720p GT guard, registry + no-shell guards).
- User frame (DreaminaAI 960²): precise mask → text unreadable; one touch-up pass → trace gone at normal view.
- WebUI proof (Playwright clicks, invariant 12): **open at ship.**

## 4. Files

New: `app/filters/erase.py`, `app/operations/erase_ops.py`, `app/routes/erase.py`, `app/static/js/tabs/erase.js`, `tests/test_erase.py`, this spec. Wiring: `operations/__init__.py`, `filters/__init__.py`, `main.py` (2 includes), `index.html` (Clean nav), `app.js` (import/accepts/title/branch), `job-control.js` (import + dispatch).

## 5. Follow-ups (not this tab)

Custom 1024-fixed ONNX export via Carve's notebook (needs torch + RAM headroom — do NOT attempt with ~2 GB free beside the running server); moving-mark tracking; auto-detect assist.
