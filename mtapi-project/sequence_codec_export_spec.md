# Sequence Export Codec Selection Spec

## Goal
Currently, sequence stitching (Join/Multi-clip) allows reconciling different resolutions and aspect ratios (`pad`, `crop`, `stretch`), but the output format is locked to the default encoding of the `transmute` bash script (usually H.264). We need to support exporting stitched sequences to professional delivery and intermediate formats, specifically DaVinci Resolve-compatible DNxHR (e.g., `dnxhr_hq`, `dnxhr_sq`, `dnxhr_lb`).

## Architecture

We already have a robust format definition map in `app/convert_presets.py` containing presets for intermediate editing (ProRes, DNxHR), delivery (H.265, AV1, VP9), and frames (PNG sequences). 

The goal is to wire these presets into the Sequence (Join) operations.

### 1. Frontend Updates
**Locations**: `app/static/js/tabs/transmute.js` (Multi mode) and `app/static/js/pool/grid.js` (Pool Sequence Builder).
- **New UI Element**: A "Target Format" dropdown (`<select id="multiCodec">`) placed next to the Reconcile (Mode/Aspect) dropdown.
- **Population**: The dropdown will pull from `ENCODE_PRESETS` (which we can fetch from the `/api/meta` endpoint, as is done in the Convert tab).
- **Default**: `h264_avc` (or empty string implying native output) to preserve backward compatibility.
- **Payload Construction**: Update `job-control.js` and `persistence.js` to include the `target` codec string in the `POST /ops/join` payload.

### 2. Backend Updates (`JoinParams`)
**Location**: `app/operations/transmute_ops.py`
Update `JoinParams` to accept the new optional parameter:
```python
class JoinParams(BaseModel):
    input_paths: list[str] = Field(..., min_length=2)
    mode: JoinGridMode = Field("pad")
    aspect: str = Field("auto")
    target: str | None = Field(None, description="Preset ID from ENCODE_PRESETS (e.g., 'dnxhr_hq')")
    durations: list[float | None] | None = None
    output_path: str | None = None
    dry_run: bool = False
```

### 3. Execution Logic
The `join` operation currently directly wraps the `/usr/local/bin/transmute` bash script via `_run_transmute(...)`. The bash script builds a complex `ffmpeg -filter_complex` graph to stitch the clips. 

To support custom codecs, we have two options. **Option B is recommended** because it reuses our Python-based preset engine:

**Option A (Bash Script Update)**:
- Modify `transmute` bash script to accept an `-E <codec_preset>` flag.
- Manually map DNxHR FFmpeg args inside bash.

**Option B (Python Pipeline Integration - Recommended)**:
1. In `transmute_ops.py` -> `join()`, if `p.target` is provided and exists in `ENCODE_PRESETS`, we intercept the output.
2. We create a temporary `JobWorkspace`.
3. We run the normal `_run_transmute` stitch command, but force its output to a high-quality intermediate inside the workspace (e.g., lossless `ffv1` or visually lossless H.264 CRF 12).
4. We then pass that stitched intermediate file to `video_pipeline.encode(..., encode_preset=ENCODE_PRESETS[p.target])`.
5. Finally, we move the result to the user's `output_path` and clean up the workspace.

## Summary of Changes
1. **Frontend**: Add "Target Format" dropdown to sequence forms; append `target` to POST payload.
2. **Backend Config**: Add `target` to `JoinParams`.
3. **Backend Logic**: If `target` is passed, run the stitch to a temp file, then use `video_pipeline.encode()` to transcode the stitched sequence to the requested preset (e.g., `dnxhr_hq` for DaVinci Resolve).
