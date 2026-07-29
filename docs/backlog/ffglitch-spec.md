# Spec: ffglitch-scripts Integration

> **Version**: 000.000.5.00 (next major feature bump)
> **Status**: Proposed
> **Author**: Spec agent
> **Scope**: New operation `ffglitch_ops.py`, new JS files in `mtapi-project/bin/`, and WebUI integration

---

## 1. What It Does

Integrates advanced video corruption scripts from the community repository `ffglitch-scripts` (by Ramiro Polla) into the `ffTransmuteWebui`. 

While the source repository relies heavily on MIDI controllers and real-time execution (`fflive`), this integration adapts the core destruction logic (Pixel Sorting, Motion Vector Panning) for our stateless, batch-oriented HTTP API.

---

## 2. Core Scripts to Port

We will select the most visually distinct and stable scripts from the repository and adapt them to accept `args.params` (via `ffedit -sp`) instead of MIDI events.

1. **Pixel Sort (`pixelsort.js`)**: 
   - Uses `ffgac.pixelsort()` on decoded frames.
   - Requires the video to be processed as raw frames in a specific pixel format (e.g., `yuv444p` or `gbrp`).
2. **Motion Vector Pan (`mv_pan.js`)**:
   - Adds a constant X/Y pan to all forward motion vectors.
3. **Motion Vector Sink & Rise (`mv_sink_and_rise.js`)**:
   - Zeros out horizontal (or vertical) motion vectors, causing the image motion to "sink" in one axis.

*(Note: `mv_average.js` from the repo is already implemented natively in our stack via `melt.js` and `datamosh_melt`).*

---

## 3. Implementation Plan

### A. Porting the JS Scripts
Create adapted scripts in `mtapi-project/bin/`:
- `bin/pixelsort_static.js`: A modified version of `free-for-all/vf_script/pixelsort_yuv444p.js` that parses thresholds and sorting order from `args.params` rather than MIDI.
- `bin/mv_pan_static.js`: A modified version of `tutorial/scripts/mpeg4/mv_pan.js` that takes `pan_x` and `pan_y` from `args.params`.

### B. Python API (`mtapi-project/app/operations/ffglitch_ops.py`)

Create a new operations file to keep the `ffglitch` manipulations distinct from the structural `datamosh_ops.py`.

```python
from pydantic import BaseModel, Field
from typing import Literal
from ..contract import OperationResult, OperationSpec, register

class FFglitchPixelSortParams(BaseModel):
    input_path: str = Field(...)
    output_path: str | None = Field(None)
    threshold_low: float = Field(0.25, description="Low threshold (0.0 to 1.0)")
    threshold_high: float = Field(0.80, description="High threshold (0.0 to 1.0)")
    order: Literal["vertical", "horizontal"] = Field("vertical")
    sort_by: Literal["y", "u", "v"] = Field("y", description="Channel to sort by")
    # Supports timeline slicing
    start_frame: int = Field(1)
    end_frame: int = Field(999999)

class FFglitchMvPanParams(BaseModel):
    input_path: str = Field(...)
    output_path: str | None = Field(None)
    pan_x: int = Field(1, description="Horizontal MV addition")
    pan_y: int = Field(0, description="Vertical MV addition")
    start_frame: int = Field(1)
    end_frame: int = Field(999999)
```

### C. Execution Pipeline
The pipeline is identical to `datamosh_ops.py` (`_execute_mosh_pipeline`), but with crucial differences for **Pixel Sorting**, which operates on decoded pixels rather than MPEG-2 macroblocks:

**For Pixel Sorting:**
1. **ffgac prep**: Decode to raw `yuv444p` video.
   `ffgac -i <input> -vcodec rawvideo -pix_fmt yuv444p -y prepped.avi`
2. **ffedit glitch**: Run the pixel sort JS filter.
   `ffedit -i prepped.avi -f script=pixelsort_static.js -sp "[threshold_low, threshold_high, order_idx, sort_idx]" -o glitched.avi`
3. **ffmpeg final**: Re-encode back to shareable H.264 mp4.

**For MV Pan:**
Follows the exact same `mpeg2video` + `+nopimb+forcemv` pipeline as `datamosh_ops.py`.

---

## 4. WebUI Integration

### File: `app/static/app.js` & `index.html`
- Create a new tab **"FFglitch Scripts"**.
- Add a dropdown to select the script: `[Pixel Sort, MV Pan]`.
- Expose the relevant parameters dynamically based on the dropdown selection (Thresholds for Pixel Sort; X/Y for MV Pan).
- Bind to the new endpoints `/ops/ffglitch_pixelsort` and `/ops/ffglitch_mv_pan`.

---

## 5. Pitfalls & Known Edge Cases

1. **Performance**: Pixel sorting via JavaScript in `ffedit` on every frame is **very slow** compared to binary filters. The `yuv444p` pipeline creates massive temporary files. The `tmpdir` implementation must ensure sufficient disk space, and timeouts might need to be extended.
2. **Parameter Passing**: `ffedit -sp` requires parameters to be formatted as a valid JSON array string (e.g., `"[0.25, 0.8, 0, 1]"`). Booleans and strings can be tricky to pass via `-sp`; converting everything to numerical indices (e.g. `0` for horizontal, `1` for vertical) inside the Python layer is much safer.
3. **Feature Exclusivity**: Like other ffglitch tools, never request multiple exclusive features (like `mv` and `q_dct` or `vf_script`) in the same JS `setup()` function.

---

## 6. Verification Steps (MANDATORY)

1. Boot the server and load the WebUI.
2. Navigate to "FFglitch Scripts".
3. Provide `/tmp/teste.mp4` as input.
4. Run "Pixel Sort" with default thresholds. 
5. Confirm no JS errors in the browser console.
6. Check server logs: `ffgac` -> `ffedit` -> `ffmpeg` must complete sequentially without syntax errors in the `-sp` parser.
7. Repeat the same test for "MV Pan".
