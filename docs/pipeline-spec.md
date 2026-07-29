# Unified Video Pipeline & JobWorkspace

> **Status:** Specification Phase

## 1. What This Replaces
The `dump -> process -> encode` pattern is currently repeated 5 times across 3 different engines (`deepdream_engine`, `facemorph_engine`, `rife_ops`). Each engine manages its own temporary directory, its own `ffmpeg` subprocess calls, its own cleanup routines, and its own cancellation checks. This introduces severe duplication, inconsistent error handling, and disjointed API boundaries. The unified pipeline eliminates this duplication by providing a single, robust pathway.

## 2. JobWorkspace (`app/job_workspace.py`)
Creates and manages isolated workspace directories at `/tmp/mtapi_jobs/{job_id}/`.

**Structure:**
- `frames_in/` (Dumped PNGs from input video)
- `frames_out/` (Processed PNGs after filter function)
- `audio.ext` (Extracted audio stream for muxing)
- `metadata.json` (fps, duration, frame count, input path, operation)

**Lifecycle:**
- Created upon job start.
- Thread-safe: One workspace per concurrent job to prevent file collisions.
- Cleaned up on success.
- **KEPT on failure** (debuggable — developers can inspect `frames_in` vs `frames_out`).
- Cleanup behavior is configurable.

## 3. VideoPipeline (`app/video_pipeline.py`)
Evolves `PngFramePipeline` into a unified class with four distinct stages:

**A. Probe**
`probe(input_path)` -> Returns a dictionary containing `fps`, `duration`, `frame_count`, `audio_stream` (boolean or codec info), and dimensions.

**B. Dump**
`dump(workspace, input_path)` -> Dumps the input video to `workspace/frames_in/` as a PNG sequence. Returns `frame_count`, `fps`, and `audio_path`.

**C. Process**
`process(workspace, filter_fn, progress_callback=None)`
- Iterates over `frames_in/*.png`.
- Calls `filter_fn(frame_in_path) -> frame_out_path`.
- Writes output to `frames_out/`.
- Calls `job_control.check_cancelled()` between processing frames.
- Calls `progress_callback(frame_index, total)` if provided.
- Filter function signature: `async def filter_fn(input_png: Path, output_png: Path, index: int) -> None`

**D. Encode**
`encode(workspace, output_path, fps, crf=18, mux_audio=True)`
- Runs `ffmpeg` to encode `frames_out/*.png` into the final output video.
- Muxes audio if available.
- Returns `output_path`.

Plus a `cleanup(workspace, keep_on_failure=False)` method.

## 4. filter_fn Contract
The filter function is the ONLY thing each operation provides. Everything else is managed by the pipeline.

**Signature:**
```python
async def my_filter(input_png: Path, output_png: Path, index: int) -> None
```

**Migrated Operations:**
- **rife:** Each frame -> interpolated frame(s) via `rife-ncnn-vulkan`.
- **withoutbg:** Each frame -> background-removed frame.
- **styletransfer:** Each frame -> stylized frame.
- **facemorph:** Two faces -> morphed frame (special: needs two inputs).
- **deepdream:** Frame -> dream frame (with temporal/octuple/ouroboros variants).

**State Management (e.g., DeepDream temporal blending):**
For operations needing access to previous output frames (temporal blending, ouroboros), the filter function should either accept an optional context object OR the engine itself will manage its internal state/frame buffer outside the strict `filter_fn` signature via closures or an engine class instance.

## 5. Dual-Path Coexistence
Old engines continue working during the migration. Phase 4 will convert one engine at a time. The new pipeline does NOT immediately replace the old code — it runs alongside it until cutover is verified.
- **Documentation Update:** Operations README must explicitly state: "If your op uses `PngFramePipeline`, it's on the old path. New ops use `VideoPipeline`+`JobWorkspace`."

## 6. Integration with Media Facade
- **Output Path Resolution:** Uses `app/pathutil.py` (`unique_output_path`).
- **Output Directory:** Set via request-scoped `ContextVar` (`output_dir_ctx.py`).
- **Thumbnails:** Thumbnail generation triggered after encode via `app/media/thumbnails.py`.
- **Media Pool:** Auto-import triggered when output lands in the workspace directory.

## 7. Cancel + Progress
- **Cancellation:** `job_control.check_cancelled()` is checked between frames.
- **Progress:** A progress callback `(current_frame, total_frames)` will emit updates (e.g., SSE streaming to WebUI or log lines to terminal).
- **Cancel During Encode:** Kills the `ffmpeg` subprocess and marks the workspace to be kept.

## 8. Error Handling
- **Dump Failure:** Clean workspace, return `OperationResult(ok=False, ...)`.
- **Filter Failure:** Save error to `metadata.json`, keep workspace for debugging, and report error.
- **Encode Failure:** Same as filter failure — keep workspace for debugging.
- **Partial Output:** If cancelled partway (e.g., 47/100 frames processed), the workspace retains the 47 `frames_out`. Provides an option to encode partial results in the future.

## 9. Files to Create / Touch
- **NEW:** `app/job_workspace.py` (~150 lines)
- **NEW:** `app/video_pipeline.py` (~300 lines)
- **TOUCH:** `app/png_pipeline.py` — Mark as deprecated, point to new pipeline.
- **TOUCH:** `app/operations/README.md` — Document dual-path coexistence.

## 10. Migration Plan (Phase 4)
Order by risk:
- **4.1 rife_ops** (Low risk, already `PngFramePipeline`-shaped)
- **4.2 withoutbg_ops** (Low risk, pure image, no temporal)
- **4.3 styletransfer_ops** (Low risk, pure image)
- **4.4 facemorph_ops** (Medium risk, `dlib` + two-input special case)
- **4.5 deepdream_engine** (High risk, temporal blending + ouroboros)

## 11. Resolved Questions
- **DeepDream Temporal Blending:** The engine will manage its own frame buffer. Operations like rife and withoutbg are stateless, and only deepdream/facemorph need frame history, so we shouldn't complicate the base `filter_fn` signature for everyone.
- **Audio Extraction:** Only extract when `mux_audio=True`. Since 90% of operations don't touch audio, extracting it unconditionally wastes I/O on the common path.
- **Progress Reporting:** Use log lines to the terminal. The WebUI already has a terminal panel for tracking progress, and implementing SSE adds unnecessary infrastructure complexity that we don't currently have.
- **Partial Output on Cancel:** This is a complexity trap, so we won't encode partial outputs automatically. The workspace is already kept on cancel, which provides enough debugability without overcomplicating the core pipeline.

## 12. Acceptance Criteria
- **AC-1:** Given an input video, When processed with an identity filter (no-op), Then the dump->process->encode pipeline produces an identical video.
- **AC-2:** Given a processing job, When cancelled mid-process, Then the workspace remains intact and the job returns a cancelled status.
- **AC-3:** Given two concurrent jobs, When they execute simultaneously, Then they receive separate workspaces and no file collisions occur.
- **AC-4:** Given the migrated `rife_ops`, When run through the new pipeline, Then the output exactly matches the output from the old pipeline.
- **AC-5:** Given an encode stage failure, When `ffmpeg` crashes, Then the `frames_out/` directory is kept for debugging and not cleaned up.
