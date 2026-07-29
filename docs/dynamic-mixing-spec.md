# Phase 5 — Dynamic Mixing Pipeline

> **Status:** Specification Phase

## 1. Problem
Currently, applying multiple effects (e.g., DeepDream, followed by RIFE interpolation, followed by Datamoshing) requires sequential API calls. Each call dumps a video to frames, processes them, and re-encodes back to a video. This leads to generation loss (multiple re-encodes), massive I/O overhead, and slow processing times. We need a `/ops/pipeline` endpoint that takes a list of filters, decodes the input once, pipes the frames through the filter chain in RAM, and encodes once.

## 2. Key Design Decisions

### 2.1. Each filter passes frame paths or in-memory arrays?
**Decision:** In-memory arrays (e.g., numpy arrays, PIL Images, or raw byte buffers).
*Rationale:* The core requirement is "no intermediate files between stages" and processing "through RAM". Passing file paths would require writing intermediate frames to disk for every stage of the chain. Filter functions in the pipeline must be refactored or wrapped to accept and return in-memory frame representations. 

### 2.2. How to chain `filter_fn` functions dynamically?
**Decision:** A unified `PipelineChain` runner that composes the `filter_fn` of each requested operation using an Async Generator pattern.
*Rationale:* Instead of calling a single `filter_fn(input_png, output_png)`, the `process` stage will load the dumped PNG into memory, pass the in-memory array through `filter_1`, pass its output to `filter_2`, etc., and finally write the result to `output_png` for the final encode step. Because filters like RIFE change the frame count, each filter should be structured as an asynchronous generator `async def filter(frame) -> AsyncGenerator[Frame, None]`.

### 2.3. Progress: per-filter or per-frame granularity?
**Decision:** Per-frame granularity (with filter context).
*Rationale:* The existing `VideoPipeline` reports progress per frame. For a continuous pipeline, progress should represent `frames_written / total_expected_frames`. We can augment this by reporting which filter is currently bottlenecking or processing, but the top-level progress must remain frame-based to provide a smooth progress bar. Note that dynamic frame rates (e.g. from RIFE) mean the `total_expected_frames` must be recalculated midway.

### 2.4. Error: one filter fails → abort chain or skip?
**Decision:** Abort chain.
*Rationale:* Video manipulation pipelines usually depend on the specific sequence of visual transformations. Skipping a failed filter (e.g., skipping background removal) would result in a completely different, unexpected output that the user did not intend. Aborting early saves compute, prevents corrupted outputs, and alerts the user to the specific failure.

## 3. Approach & Pattern to Follow
1. **Endpoint Generation:** Create `POST /ops/pipeline` that accepts a JSON body with a list of operation IDs and their respective parameters. Example: 
   `{"input_path": "/tmp/teste.mp4", "filters": [{"name": "deepdream", "params": {...}}, {"name": "rife", "params": {...}}]}`
2. **Unified Filter Interface:** Define an `InMemoryFilter` interface that all ops must adapt to. `async def process_frame(frame: np.ndarray, index: int, context: dict) -> AsyncGenerator[np.ndarray, None]`.
3. **Pipeline Runner Modification:** Extend `VideoPipeline` (from Phase 4) to support a `chain_process` method. It reads `frames_in/*.png` one by one, decodes to RAM, passes through the generator chain, and writes to `frames_out/`.
4. **CLI Wrapping / Datamoshing:** For tools like `datamosh.sh` that operate on full video files (MPEG-2 glitching), we face a conflict. True datamoshing relies on inter-frame compression artifacts, which cannot be applied to isolated in-memory PNG frames. The pipeline must handle this by either grouping frame-level filters in memory, then performing a final encode, and passing the encoded video to file-level scripts like `datamosh.sh` as an implicit post-processing step.

## 4. Files to Touch
- **NEW:** `mtapi-project/app/operations/pipeline_ops.py` (Endpoint and filter chain logic)
- **NEW:** `mtapi-project/app/pipeline_chain.py` (The RAM-based processing loop)
- **TOUCH:** `mtapi-project/app/video_pipeline.py` (Adapt to support RAM chaining)
- **TOUCH:** `mtapi-project/app/operations/__init__.py` (Register the new endpoint)
- **TOUCH:** Existing ops (`deepdream_ops.py`, `rife_ops.py`, etc.) to expose in-memory filter interfaces.

## 5. Pitfalls
- **Memory Leaks:** Storing too many frames in RAM (especially with high-res video or memory-heavy ops like DeepDream) will OOM the server. Strict frame-by-frame GC is required.
- **CLI Tool Mismatch:** `datamosh.sh` expects a `.mp4` video file, not an in-memory frame. To include datamosh in a frame-based pipeline, it needs to run as a post-encode step. If the user specifies `[deepdream, datamosh, withoutbg]`, it would require an intermediate encode/decode step anyway, violating the "encode once" rule. We must explicitly define "video-level" vs "frame-level" filters in the spec.
- **Frame Rate Changes (RIFE):** RIFE doubles or quadruples frames. The pipeline chain must handle 1-to-N frame mappings gracefully, meaning downstream filters will process 2x or 4x more frames.

## 6. Verification Steps
1. Create a chain request with `[deepdream, withoutbg]` and verify that the output video contains deeply dreamed foreground subjects with transparent/black backgrounds.
2. Check disk I/O metrics to ensure no intermediate PNGs are created between the deepdream and withoutbg steps (only `frames_in` and `frames_out` should exist).
3. Verify that if a filter fails (e.g., invalid parameters passed to `rife`), the entire pipeline halts cleanly, the error is returned in the API response, and the `job_workspace` is preserved for debugging.
4. Pass `/tmp/teste.mp4` through a 3-filter chain in the WebUI and ensure progress updates reflect the per-frame progression without JS console errors.
