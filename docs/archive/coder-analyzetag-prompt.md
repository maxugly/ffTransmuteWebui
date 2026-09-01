# Prompt for Codewhale: Analyze Tag Songs Operation

**Target:** `analyzetag_ops.py` (new file)
**Context:** Music Video / Audio pipeline

Codewhale, we need a new operation module that analyzes media files for BPM and Musical Key based on the `analyze-tag-songs` script approach. 

## Requirements:

1. **Create `mtapi-project/app/operations/analyzetag_ops.py`**
   - Follow the established Pydantic + async handler + `OperationResult` pattern.
   - Params: `input_path` (str), `recursive` (bool), `generate_report` (bool).
2. **Directory vs File Handling**
   - If `input_path` is a file, analyze it.
   - If a directory, scan it for media files (`.mp3`, `.wav`, `.mp4`, etc.). Obey the `recursive` flag.
3. **The Core Loop**
   - For each file, use `ffmpeg` to extract the audio to a temporary `.wav` file in a temp dir.
   - Run BPM and Key detection on the temporary `.wav` file (using `aubio` or equivalent).
   - Report progress back to the UI (`yield {"progress": N/total, "message": f"Analyzed {file}: {bpm} BPM, {key}"}`).
4. **Reporting**
   - Aggregate all results.
   - Write an `analysis_report.json` (or CSV) to the directory containing the source files.
   - Return the summary in the `OperationResult` payload so the UI can display it.
5. **Error Handling**
   - If a file has no audio stream or analysis fails, log the error and continue to the next file. DO NOT fail the entire batch.

## Constraints
- Do NOT modify the source files directly (no tagging yet).
- Always clean up temporary `.wav` files.
- Stick to the exact operation module patterns used in `speedchange_ops.py` and `codecview_ops.py`.
