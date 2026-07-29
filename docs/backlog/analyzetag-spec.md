# Analyze Tag Songs Operation Spec

**Author:** m (Max) via Sprinter
**Status:** DRAFT

## 1. Overview
The "Analyze Tag Songs" operation scans audio and video files to determine their **musical key** and **BPM** (beats per minute). This is an essential utility for preparing media for music video syncing, beat-matching, or audio-driven effects.

This operation wraps or emulates the logic from the `analyze-tag-songs` script but adapts it for the ffTransmuteWebui pipeline. It accepts either a single file or a directory (with optional recursive scanning) and generates a report alongside reporting results to the UI.

## 2. Dependencies
- Python dependencies: `keyfinder`, `mutagen`, `aubio` (or similar for BPM), `ffmpeg-python`.
- System dependencies: `ffmpeg`.

## 3. Inputs & Parameters

The operation will be implemented as `analyzetag_ops.py` and exposed via the UI.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `input_path` | str | required | Path to an audio/video file, or a directory. |
| `recursive` | bool | false | If `input_path` is a directory, scan subdirectories. |
| `generate_report` | bool | true | Generate a CSV/JSON report file in the scanned directory. |
| `tag_files` | bool | false | Apply ID3/metadata tags directly to the files (v2 feature, default to false for now). |

## 4. Pipeline Execution

1. **Input Resolution:** Check if `input_path` is a file or a directory. 
2. **File Discovery:** If a directory, collect all valid media files (`.mp3`, `.wav`, `.flac`, `.m4a`, `.mp4`, `.mkv`, etc.). If `recursive` is true, walk the directory tree.
3. **Analysis Loop:**
   - Extract an audio stream to a temporary `.wav` file (required for robust aubio BPM extraction).
   - Run `aubio` or `librosa` on the `.wav` to extract BPM.
   - Run `keyfinder` to extract the musical key.
4. **Aggregation & Reporting:**
   - Yield progress updates to the UI containing the current file's Key and BPM.
   - Aggregate all results into a structured format.
   - Write a `analysis_report.json` or `analysis_report.csv` to the target directory.
5. **Cleanup:** Remove temporary `.wav` files.

## 5. UI Integration

- **Form:** A new tab or section for "Audio Analysis".
- **Inputs:** A path selector (file or folder), a toggle for `Recursive Search`.
- **Live Output:** A table or list view that populates with rows: `[Filename] | [Key] | [BPM]` as the analysis progresses.
- **Completion:** A button to download or open the generated report.

## 6. Edge Cases & Constraints

- Video files must be supported. The script should isolate the audio stream via ffmpeg rather than failing on video containers.
- Extremely long files (1hr+ DJ mixes) could cause memory issues during BPM extraction. Consider analyzing the first 5 minutes, or downsampling.
- Fallback gracefully if BPM/Key extraction fails on a specific file, rather than crashing the batch job.
