# Coder Prompt — Optical Flow Maps (`opticalflow`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/opticalflow-spec.md` (same directory)

---

## MISSION
Implement an "Optical Flow" operation that computes dense motion vectors using OpenCV DISOpticalFlow and encodes them into an RGB video.

## PHASE 1 — BACKEND: `opticalflow_ops.py`
Create `mtapi-project/app/operations/opticalflow_ops.py`.
Define Pydantic schema `OpticalFlowParams` with `scale` (default 0.5) and `max_speed` (default 15.0).

**Requirements:**
1. **Engine**: Use `cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_FAST)`. Do NOT use deep learning models (no RAFT) to ensure CPU efficiency.
2. **Inference Loop**:
   - Read video via OpenCV.
   - For each frame, convert to grayscale.
   - Resize grayscale image by `scale` parameter.
   - Compute flow: `flow = dis_engine.calc(prev_gray, curr_gray, None)`.
   - Resize flow back to original resolution. Multiply vector magnitudes by `(1.0 / scale)`.
3. **RGB Mapping**:
   - `mag, ang = cv2.cartToPolar(flow[..., 0], flow[..., 1], angleInDegrees=True)`
   - Map to HSV: `H = ang/2.0`, `S = 255`, `V = np.clip((mag / max_speed) * 255.0, 0, 255)`
   - Convert HSV to BGR.
4. **Write**: Output using OpenCV `VideoWriter` or pipe to `ffmpeg`.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `opticalflow` tab under "Video AI".
- Form: Continuous Knobs for `scale` (0.1 to 1.0, step 0.1) and `max_speed` (1.0 to 50.0, step 1.0).
- Add routing and execution logic.
