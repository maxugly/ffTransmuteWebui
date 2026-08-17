# Coder Prompt — Algorithmic Glitch (`databend` & `pixelsort`)

> **Target**: ffTransmuteWebui — new standalone operations + new WebUI tab
> **Spec reference**: `docs/glitch-spec.md` (same directory)

---

## MISSION
Implement pure-Python glitch operations for `databend` (image sonification) and `pixelsort` (vectorized interval sorting) using `numpy` and `scipy`. NO FOR LOOPS OVER PIXELS PERMITTED.

## PHASE 1 — BACKEND: `glitch_ops.py`
Create `mtapi-project/app/operations/glitch_ops.py`.
Define two Pydantic schemas: `DatabendParams` and `PixelSortParams`.

**Requirements:**
1. **Dependencies**: `numpy`, `scipy`, `PIL`.
2. **Databend Implementation**:
   - Flatten image. Normalize to `[-1.0, 1.0]`.
   - Filter mode: Use `scipy.signal.butter` and `sosfilt`.
   - Delay mode: Array slicing and addition (`output[delay:] += decay * waveform[:-delay]`).
   - Bitcrush mode: Quantize via `np.round`.
3. **Pixel Sort Implementation (Vectorized Interval Sorting)**:
   - Calculate luminance. Create mask for `lum_min <= lum <= lum_max`.
   - Use `np.maximum.accumulate` to track left bounds and right bounds.
   - Generate sort keys: Boundary pixels get their original index; Masked pixels get a continuous key mapped across the interval based on luminance.
   - `np.argsort(keys)` and `np.take_along_axis(img, idx)`.
4. Return modified images.

Register operations. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `glitch` tab.
- Sub-tabs for `Databending` and `Pixel Sorting`.
- Add routing and execution logic for both endpoints.
