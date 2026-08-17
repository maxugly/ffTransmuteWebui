# FastSAM + SAM Multimodel Spec

> **Status:** Ready for builder — execute via [coder-fastsam-multimodel-prompt.md](coder-fastsam-multimodel-prompt.md)  
> **Audience:** Builders extending FastSAM with alternative SAM-family backends  
> **Related:** `fastsam-openvino-spec.md`, `filter-platform-spec.md`, `withoutbg-spec.md`  
> **As-built today (7.001):** FastSAM-s only. No Model dropdown. `device` is already `GPU|CPU|AUTO` (default GPU).

---

## 0. Locked for the builder (do not re-open)

The sections below this box are research. **This box wins** if they disagree.

| # | Lock |
|---|------|
| 1 | **Reuse `device`.** Do **not** add `device_preference`. UI already has GPU / CPU / AUTO. Keep default **GPU**. |
| 2 | **API field:** `model_id`: `FastSAM-s` \| `FastSAM-x` \| `SAM ViT-L` \| `SAM ViT-H`. Default `FastSAM-s`. |
| 3 | **Phase 1 (must ship):** FastSAM-s unchanged + FastSAM-x. Same `ultralytics.FastSAM` class. Pass `model_id` through params → image path → `make_fastsam_directory`. |
| 4 | **Phase 2 (only if clean):** SAM ViT-L then ViT-H via **ultralytics `SAM`** (already on the FastSAM install). Normalize output to `.masks.xy` so `get_target_mask` stays untouched. |
| 5 | **Do not** add `segment-anything` / `sam2` unless ultralytics export **fails**. If it fails: ship Phase 1, mark ViT Partial, stop. Do not invent a second mask stack. |
| 6 | **Weights:** ultralytics cache or `~/.cache/mtapi/models/`. Never commit `*.pt`. Scratch downloads → `mtapi-project/junk/models/`. |
| 7 | **`keep_model_warm` stays.** Cache key = `model_id + device`. Spec §7.3 “no caching” is **void**. |
| 8 | **AUTO heuristic** only when user picked AUTO (already on the Device dropdown). GPU requested stays GPU unless OpenVINO says unavailable — then CPU + one log line. |
| 9 | FastSAM-s remains default. First heavy-model run may download + export (slow). Log `[fastsam] using …`. |
| 10 | VERSION far-right DD (`7.002` if still on 7.001). STATUS / SESSION / spec_registry. No 7.000 rewrite. |
| 11 | Video “everything” stays today’s fallback (target per frame). Do not redesign that. |

---

## 1. Goal

Allow the user to select a **heavier but more accurate** segmentation model from the FastSAM tab, while staying on the existing OpenVINO / Intel iGPU or CPU path. No NVIDIA dependency. Slower inference is acceptable if it materially improves mask quality.

This spec extends `fastsam-openvino-spec.md`; all existing behavior stays default.

---

## 2. Problem

Current default `FastSAM-s` is fast but:
- misses fine structure on complex subjects,
- leaks background into thin structures (hair, branches, glass),
- produces noisy / fragmentary masks in clutter.

The user has **headroom** when not running FastSD / heavy video jobs. We should expose stronger backends when the user explicitly chooses them.

---

## 3. Allowed Model Set

| UI label | Backend model ID | Source | Params | Notes |
|----------|------------------|--------|--------|-------|
| **FastSAM-s (default)** | `FastSAM-s.pt` | ultralytics | ~11M | Current default; fastest |
| **FastSAM-x** | `FastSAM-x.pt` | ultralytics | ~34M | ~3× slower than s; noticeably cleaner edges |
| **SAM ViT-L** | `sam_vit_l.pt` | facebook/segment-anything | ~308M | Very good boundaries; slow on CPU; needs GPU for reasonable speed |
| **SAM ViT-H** | `sam_vit_h.pt` | facebook/segment-anything | ~636M | Best quality; expect 1–3s/frame on Iris Xe; risky on 16GB shared RAM |

**Rule:** Only offer models that can realistically run on this machine. Do **not** add `SAM ViT-B` unless requested; it offers little benefit over FastSAM-x for this use case.

---

## 4. Architecture Changes

### 4.1 Shared contract

All backends must produce the **same output shape** as current FastSAM code:
- Image input → one or more transparent PNGs with alpha mask.
- Video input → encoded video with alpha channel.
- Fallback on no-mask → copy original unchanged.

The polygon-contour extraction path in `filters/fastsam.py` is backend-agnostic once a `results_obj` with `.masks.xy` exists. Each backend exporter must normalize its inference result into that shape.

### 4.2 Model registry

Add a small registry in `filters/fastsam.py`:

```python
MODEL_REGISTRY = {
    "FastSAM-s": "FastSAM-s.pt",
    "FastSAM-x": "FastSAM-x.pt",
    "SAM ViT-L": "sam_vit_l.pt",
    "SAM ViT-H": "sam_vit_h.pt",
}
```

The registry maps the UI label to the filename that `ensure_openvino_model()` will export.

### 4.3 `ensure_openvino_model()` extension

Current signature: `ensure_openvino_model(model_id: str = "FastSAM-s.pt", device: str = "GPU")`.

New behavior:
1. If `model_id` is a **UI label** (`FastSAM-x`, `SAM ViT-L`, `SAM ViT-H`), translate via `MODEL_REGISTRY`.
2. If the corresponding `_openvino_model` directory does **not** exist next to the `.pt`, run export:
   - FastSAM family: `model.export(format="openvino", half=True, dynamic=True)`
   - SAM family: use `segment-anything` export path → OpenVINO IR via `ov.save_model()` from the exported TorchScript.
3. Return the path to the exported IR directory.

**Constraint:** `dynamic=True` is FastSAM-specific. SAM export uses fixed input shape or explicit dynamic axes on the ONNX/OV path. Keep the two export branches separate.

### 4.4 Device fallback

New parameter: `device_preference: str = "GPU"` with values `GPU`, `CPU`, `AUTO`.

Behavior:
- `GPU`: try Iris Xe first; if OpenVINO reports `GPU` unavailable or memory pressure is high, fall back to `CPU` for this run.
- `CPU`: force CPU even if GPU is free.
- `AUTO`: probe available VRAM / system RAM; pick GPU only if enough headroom remains.

**AUTO heuristic (simple):**
- If `/proc/meminfo` `MemAvailable` < `4 GB`, force CPU regardless.
- If `GPU` and available RAM > `6 GB`, use GPU.
- Otherwise use CPU.

No need for a long-running monitor. This is a per-job decision at op start.

---

## 5. Backend Changes

### 5.1 `filters/fastsam.py`

- Add `MODEL_REGISTRY`.
- Update `get_target_mask(results_obj, img_shape, mode, target_x, target_y)` to **not** depend on which backend produced the masks. It already uses `.masks.xy`, which both FastSAM and SAM provide via their respective result wrappers.
- Update `make_fastsam_directory()` signature:
  ```python
  async def make_fastsam_directory(
      model_id: str = "FastSAM-s.pt",
      conf: float = 0.4,
      iou: float = 0.9,
      device: str = "GPU",
      mode: str = "target",
      target_x: float = 0.5,
      target_y: float = 0.5,
  ):
  ```
- Inside the closure, translate UI label → filename, call `ensure_openvino_model(model_id, device)`, instantiate the correct model class, run inference, normalize output to `results_obj.masks.xy`.

### 5.2 `operations/fastsam_ops.py`

Add new fields to `FastSAMParams`:

```python
model_id: Literal[
    "FastSAM-s", "FastSAM-x", "SAM ViT-L", "SAM ViT-H"
] = Field("FastSAM-s", description="Segmentation backend")

device_preference: Literal["GPU", "CPU", "AUTO"] = Field(
    "AUTO", description="Device selection strategy"
)
```

Image path:
- After loading the model, if `device_preference == "AUTO"` resolve to concrete `GPU`/`CPU` using the heuristic in §4.4.
- Pass `device=` to both FastSAM and SAM inference calls.

Video path:
- Same translation pass-through to `make_fastsam_directory()`.

### 5.3 `docs/fastsam-openvino-spec.md`

Update:
- §2 Technical Requirements: list the full model set and export requirements for SAM.
- §4.2 / §4.3: update signatures and add model selection code.
- §6 Verification: add one verification item per new backend.

---

## 6. Frontend Changes

### 6.1 `js/tabs/fastsam.js`

Add a new form row above Mode:

```html
<div class="form-row">
  <label for="fastsamModel">Model</label>
  <select id="fastsamModel">
    <option value="FastSAM-s" selected>FastSAM-s (default)</option>
    <option value="FastSAM-x">FastSAM-x (slow, accurate)</option>
    <option value="SAM ViT-L">SAM ViT-L (very accurate)</option>
    <option value="SAM ViT-H">SAM ViT-H (best quality)</option>
  </select>
  <p class="form-row-hint">Heavier models use more RAM and run slower. AUTO picks GPU only if enough memory is free.</p>
</div>
```

Add a device dropdown next to Device, or extend the existing Device dropdown with `AUTO` as the new default.

### 6.2 `collectFastSAMBody()`

Add:
```js
model_id: (document.getElementById('fastsamModel') || {}).value || 'FastSAM-s',
device_preference: (document.getElementById('fastsamDevice') || {}).value || 'AUTO',
```

If the existing device dropdown already contains `AUTO`, make it the **selected default** instead of `GPU`.

---

## 7. RAM / UX Guardrails

1. **Warn on first use of heavy model.** When `model_id != "FastSAM-s"`, append a terminal line:
   ```
   [fastsam] Using SAM ViT-L on CPU; expected ~1.2s/frame on this hardware.
   ```
2. **Do not silently downgrade.** If `device_preference == "GPU"` and OpenVINO falls back, surface it in terminal output:
   ```
   [fastsam] GPU requested but unavailable; falling back to CPU for this run.
   ```
3. **No model caching across runs.** Each job re-export checks the `_openvino_model` directory; if present, reuse. If the user swaps models mid-session, the next export runs once and is then cached.

---

## 8. Dependencies

No new top-level pip dependency. Ultralytics already handles FastSAM export. For SAM ViT-L/H we need `segment-anything` or `sam2` installed.

Acceptable approach:
- Vendor a small `sam_ov.py` helper under `app/filters/` that loads `sam_vit_l.pt`, traces / exports to ONNX → OpenVINO IR.
- Alternatively, use the existing `segment-anything` pip package if already present; if not, fall back to a lightweight ONNX export path.

**Minimum new requirement:** `segment-anything` package for ViT-L/H export.

---

## 9. Verification Steps (Definition of Done)

1. Start server, open FastSAM tab.
2. Verify the new **Model** dropdown contains `FastSAM-s`, `FastSAM-x`, `SAM ViT-L`, `SAM ViT-H`.
3. Select `SAM ViT-L`, run `/tmp/teste.png` in `everything` mode.
4. Assert backend terminal shows model load + inference timing.
5. Verify `_assets/` directory is created with segmented PNGs.
6. Repeat with `device_preference = CPU` explicitly; verify terminal notes CPU fallback.
7. Select `FastSAM-s` again; verify it still runs and outputs match previous behavior.
8. No JS console errors during any run.

---

## 10. Risks

- **SAM ViT-H on 16GB shared RAM**: may trigger OOM if browser + pool state are large. Mitigation: AUTO heuristic + explicit CPU option.
- **SAM export complexity**: SAM-to-OpenVINO is not as clean as FastSAM’s built-in `.export()`. May require manual ONNX export + `openvino.convert_model()`.
- **Speed regression for default path**: FastSAM-s must remain the default UI choice; heavier models are opt-in only.
