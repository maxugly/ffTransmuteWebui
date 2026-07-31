# Dynamic Mixing Pipeline (Phase 5)

> **Status:** Backend **implemented** (`POST /ops/pipeline`, `pipeline_chain.py`, `app/filters/*`)  
> **Open:** Multi-Pass WebUI queue (see `TODO.md` §5.2)  
> **Category:** Core Architecture  
> **Also see:** `filter-platform-spec.md`

## 1. Overview
Applying multiple effects used to mean sequential ops and re-encodes.  
`POST /ops/pipeline` accepts an ordered list of filters; the backend dumps once, runs disk stages, encodes once. **Disk-based** (PNG stages) — not full-video RAM arrays.

## 2. Architecture & Constraints

### 2.1 Disk-Based Cascading Workspaces
We cannot hold video frame arrays in memory (no numpy arrays, no PIL buffers kept between frames). The chain operates strictly on disk by cascading PNG sequences through stage directories inside a single `JobWorkspace`.

**Workspace Structure:**
```text
/tmp/mtapi_jobs/{job_id}/
├── stage_0/   (frames_in from initial ffmpeg dump)
├── stage_1/   (output of filter 1, input to filter 2)
├── stage_2/   (output of filter 2, input to filter 3)
├── stage_N/   (final output)
└── audio.ext  (extracted audio)
```

### 2.2 Processing Flow (No Generators)
We drop the async generator pattern entirely. Instead, the chain relies on a simple directory-based for-loop. We reuse the Phase 4 `filter_fn` signature:
```python
async def filter_fn(input_png: Path, output_png: Path, index: int) -> None
```
For each stage `N`, the pipeline:
1. Iterates over `stage_{N-1}/*.png`.
2. Calls `filter_fn(input_png, output_png, index)`.
3. Writes the output to `stage_{N}/`.
4. Frees memory (only ONE frame is loaded into RAM at a time).

### 2.3 Progress Reporting
Progress is reported per-stage. The pipeline tracks `frames_processed / total_frames` for the current stage, and reports which stage is currently active (e.g., `Stage 2/3: DeepDream (45/90)`).

## 3. PipelineChain (`app/pipeline_chain.py`)
A new orchestrator class that wraps `JobWorkspace`.
- Accepts a list of `filter_fns` and their names.
- **Dumps Once:** Extracts frames from the input video to `stage_0/`.
- **Chains Iteratively:** Runs a standard `for` loop over each filter, passing the previous stage's directory as input and a new stage directory as output.
- **Encodes Once:** Only the final stage directory (`stage_N/`) is encoded back into an `.mp4`.
- **Cancellation:** Checks `job_control.check_cancelled()` between individual frames AND between full stages.

## 4. Files to Create
- **NEW:** `app/pipeline_chain.py` (~150 lines) - Handles cascading directories and loops.
- **NEW:** `app/operations/pipeline_ops.py` (~100 lines) - Exposes `POST /ops/pipeline` accepting a JSON array of operations.

## 5. Tradeoffs & Special Cases

### Memory Constraint & Disk I/O
Because we only load one PNG frame at a time, RAM stays low and OOM crashes are prevented. The tradeoff is heavy disk I/O, as each intermediate stage writes a full PNG sequence to disk. This is an acceptable tradeoff for system stability. (Model weights caching across stages is out of scope here and handled by the Model Manager phase).

### Boundary Operations (Datamosh & ffglitch)
`PipelineChain` handles **frame-level filters only** (identity, deepdream, rife, withoutbg, styletransfer, facemorph). 

Datamosh and ffglitch (Phase 6.3 pixel sort) are **FILE-LEVEL** operations. They act on encoded MPEG-2/MP4 data, not raw PNG sequences, and thus cannot be mid-chain filters. 

These operations compose at the UX layer, not the codec layer: run the frame pipeline first, then datamosh the resulting video separately as a post-encode step. No bridge is needed. `PipelineChain` is correct and complete for its scope.

## 6. Acceptance Criteria
- **AC-1:** Given a chain of `[identity, identity]`, When processed, Then the final output video matches a single identity pass.
- **AC-2:** Given a chain of `[deepdream, rife]`, When run on a 90-frame video, Then the pipeline produces 180 frames with the dream effect applied and smooth motion interpolation.
- **AC-3:** Given an active chain, When cancelled mid-chain, Then the workspace directories are kept intact on disk and the job reports an error/cancelled status.
- **AC-4:** Given a completed job, When inspecting disk usage, Then intermediate stage directories exist during processing, but only the final `frames_out` (or final encoded video) dictates the output structure, with cleanup applying normally.
