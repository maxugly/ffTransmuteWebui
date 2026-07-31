# Phase 4.1 Spec: RIFE Migration

> **Status:** Superseded by `rife-filter-cleanup-spec.md` + `filter-platform-spec.md`  
> **Implemented:** directory-stage design (not pairwise FilterFn)  
> **Target:** `app/filters/rife.py`, thin `rife_ops.py`, `pipeline_chain` directory support

---

## Historical note

The pairwise `filter_fn` design below was implemented then replaced: one
`rife-ncnn-vulkan -i/-o` directory pass is correct for the binary and the
platform contract (`kind=directory`).

---

# (archived original text)

> **Status:** Superseded  
> **Target:** `mtapi-project/app/operations/rife_ops.py`

## 1. What Changes
Currently, `rife_ops.py` uses the deprecated `PngFramePipeline`. It performs a custom video dump, runs `rife-ncnn-vulkan` as a single subprocess over an entire directory (`-i frames_in -o frames_out`), and then manually encodes the output while dropping audio (`-an`).

The new implementation will use `JobWorkspace` and `VideoPipeline`. The pipeline will handle the dump, process loop, cancellation checks, and encoding. `rife_ops.py` will only be responsible for providing a `filter_fn` closure that interpolates frames incrementally. 

## 2. Filter Function Design
Because `video_pipeline.process` expects a 1:1 frame mapping but RIFE generates multiple frames, the filter function will ignore the pipeline-provided `output_png` and manage its own `out_index` state to write sequentially named frames to `workspace.frames_out`.

### Signature and Closure State
```python
import shutil
import asyncio
from pathlib import Path

out_index = 0
previous_frame = None

async def rife_filter(input_png: Path, output_png: Path, index: int) -> None:
    nonlocal out_index, previous_frame
    
    # 1. First frame: just copy to output
    if index == 0:
        dst = workspace.frames_out / f"frame_{out_index:06d}.png"
        shutil.copy2(input_png, dst)
        out_index += 1
        previous_frame = input_png
        return

    # 2. Subsequent frames: generate intermediate frames
    steps = [i / p.multiplier for i in range(1, p.multiplier)]
    for step in steps:
        interp_dst = workspace.frames_out / f"frame_{out_index:06d}.png"
        rife_argv = [
            _RIFE_BIN,
            "-0", str(previous_frame),
            "-1", str(input_png),
            "-o", str(interp_dst),
            "-s", str(step),
            "-m", p.model,
        ]
        if p.tta: rife_argv.append("-x")
        if p.uhd: rife_argv.append("-u")
        
        # Spawn rife-ncnn-vulkan for this specific time step
        proc = await asyncio.create_subprocess_exec(*rife_argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"rife-ncnn-vulkan failed on index {index} step {step}")
            
        out_index += 1
        
    # 3. Finally, copy the current frame
    dst = workspace.frames_out / f"frame_{out_index:06d}.png"
    shutil.copy2(input_png, dst)
    out_index += 1
    previous_frame = input_png
```

## 3. Audio Handling
In the old implementation, audio was explicitly dropped (`-an`). 
In the new `VideoPipeline`, audio is preserved by default if the duration matches.
Since RIFE scales the output FPS proportionally to the frame count (`out_fps = fps * p.multiplier`), the total video duration remains identical to the source.
Therefore, `VideoPipeline.encode` will safely mux the original audio track back into the interpolated video without any desync. 
- Pass `mux_audio=True` (or leave default).
- Pass the scaled `fps=out_fps` to `pipeline.encode`.

## 4. Multi-Mode (2x / 4x / 8x Interpolation)
The incremental `rife_filter` approach naturally supports any multiplier via the `-s` (time step) parameter. 
- **2x mode:** 1 intermediate frame at `step = 0.5`.
- **4x mode:** 3 intermediate frames at `step = 0.25, 0.5, 0.75`.
- **8x mode:** 7 intermediate frames at `0.125` intervals.
The closure loops over `range(1, multiplier)` and dynamically generates exactly the right number of intermediate frames before writing the current original frame.

## 5. Acceptance Criteria
- **AC-1:** The job runs using `VideoPipeline.process`, iterating frame-by-frame instead of passing a whole directory to RIFE.
- **AC-2:** The output video duration exactly matches the input video.
- **AC-3:** Audio from the input video is preserved in the output video (if present).
- **AC-4:** The output FPS is scaled by the multiplier (e.g. 24fps -> 48fps).
- **AC-5:** Mid-job cancellation cleanly aborts the frame loop without leaving orphaned subprocesses.

## 6. Files Touched
- `mtapi-project/app/operations/rife_ops.py`
  - Remove `PngFramePipeline` imports.
  - Import `JobWorkspace` and `video_pipeline`.
  - Rewrite `rife_interpolate` to initialize `JobWorkspace` and use `video_pipeline.dump`, `process`, and `encode`.
  - Implement `rife_filter` closure inside `rife_interpolate`.
