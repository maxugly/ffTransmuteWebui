# Roadmap — Phase 2: Filter Graph Architecture

> Vision document. Not a TODO. This is where we're headed after the cleanup.

---

## The Problem

Right now, every neural/video op (deepdream, styletransfer, facemorph,
upcoming ascii, ffglitch) recycles the same lifecycle:

1. ffmpeg probe + extract frames to tempdir
2. Python loop opens each frame, passes to tool, saves
3. ffmpeg re-encode + attempt to mux audio
4. cleanup tempdir

Each op manages its own ffmpeg, its own tempdirs, its own model loading.
You can't chain them. You can't mix them. Every new op reinvents the wheel.

## The Target

Move from "Monolithic Operations" to "Filter Graph / Pipeline."

Operations become Filters. A Filter exposes `process_frame(image_array)`.
The Pipeline handles video I/O once — decode, run frames through the chain,
encode. Chaining becomes a JSON array:

```json
POST /ops/pipeline
{
  "steps": [
    {"op": "withoutbg"},
    {"op": "deepdream", "blend": 0.5},
    {"op": "pixelsort"},
    {"op": "ascii"}
  ]
}
```

## The Pieces

### 1. Unified Pipeline Engine

Extract ffmpeg frame I/O into a shared `VideoPipeline` class. Operations
stop knowing about videos or tempdirs — they become Filters with a
`process_frame(image_array)` or `process_frame_batch()` method.

The Pipeline decodes once, passes frames through in RAM, encodes once.
Already partially done: `PngFramePipeline` handles the tempdir bookends.
Next step: push it deeper — into the frame loop itself.

### 2. Effect Chaining

Build `POST /ops/pipeline` — accepts a JSON array of steps, builds the
chain, extracts frames, passes each frame through sequentially, muxes
output. This is the "ComfyUI for ffTransmute" moment.

### 3. Model / VRAM Manager

deepdream loads TF weights. styletransfer loads PyTorch. facemorph loads
dlib. Chaining them means all three could be in VRAM simultaneously → OOM.

A `ModelManager` checks if a model fits. If not, offloads the
least-recently-used model to system RAM before loading the new one.
Operations never touch GPU memory directly — they go through the manager.

### 4. Standardized Job Workspace

Instead of `mktemp` scattered across scripts: `JobWorkspace` class.

```bash
/tmp/mtapi_jobs/{job_id}/
├── audio.aac          # extracted audio
├── frames_in/         # source frames
├── frames_out/        # processed frames
└── metadata.json      # job parameters
```

Failing jobs leave a preserved workspace for debugging. User can download
individual components (just audio, just frames).

### 5. UI Evolution: Tabs → Nodes

- **Phase 1:** A "Multi-Pass" tab — add effects to a list, reorder, hit run.
- **Phase 2:** Node-based editor (Blender compositor / ComfyUI style).

---

## When

After the current cleanup wave is done:
- [x] PNG pipeline consolidation
- [x] ffprobe consolidation
- [x] main.py route split
- [ ] Global inputs backend (file verification, stop between iterations, path scanning)
- [ ] media_store.py split
- [ ] CivitAI integration

The first concrete step toward this vision — `VideoPipeline` that owns the
decode→frame-loop→encode — is a natural evolution of the `PngFramePipeline`
we just built. The class exists. It just needs to go deeper.
