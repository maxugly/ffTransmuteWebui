# FFmpeg File-to-File Transcode Architecture

> **Status:** Implemented (`000.000.5.00`)  
> **Core Files:** `app/video_pipeline.py` (`transcode_with_preset`, `concat_clips`), `app/operations/transmute_ops.py` (`_join_with_preset`)

## 1. The Problem

The core `mtapi-project` architecture relies on the **Filter Platform** (`dump → app/filters/* → encode`). This pipeline dumps an input video into an intermediate directory of `.png` frames, processes those frames via Python stages (like DeepDream, FastSAM, or RIFE), and then re-encodes the frames back into an `.mp4`. 

While this is required for neural frame-by-frame effects, it is a massive I/O and CPU waste for operations that `ffmpeg` can handle natively—such as joining clips together, changing codecs (Convert/Export), or geometry crops.

## 2. The Solution (file→file transcode)

For pure ffmpeg operations (e.g., Sequence Join, Convert tab), the system now bypasses the PNG dump entirely. It uses a direct file-to-file transcode pipeline.

### `concat_clips` (Python Filter Graph)
When joining multiple clips, `video_pipeline.concat_clips` generates the necessary `ffmpeg -filter_complex` graph to reconcile different aspect ratios, resolutions, and frame rates. Instead of writing frames to disk, it produces a neutral, near-lossless intermediate video file (e.g., `joined_tmp.mkv`).

### `transcode_with_preset`
Located in `app/video_pipeline.py`, this function takes a muxed video file and an `EncodePreset` (from `app/convert_presets.py`) and executes a direct ffmpeg pass:
`demux → decode → encode → mux`

It applies all the preset parameters (codec, crf, bitrates, audio config) directly to the video without extracting a single PNG.

## 3. Rules & Boundaries

To prevent regressions, the following invariants apply to all future operation designs:

1. **Neural/Frame Ops (DeepDream, Style, RIFE):** 
   - MUST use the standard Filter Platform (`dump → app/filters/* → encode`).
   - If you need to touch the pixels in Python, you must use a PNG dump.
2. **Codec / Geometry / Stitching Ops:** 
   - MUST use `file→file` transcode (e.g., `_join_with_preset` and `transcode_with_preset`). 
   - Never instantiate a PNG dump solely to transcode a file to a new format like ProRes or DNxHR.
3. **Audio:** 
   - The file-to-file path naturally preserves and transcodes audio streams. The PNG filter platform drops audio natively (unless multiplexed back at the very end). Use the file path when audio is essential to the immediate operation.
