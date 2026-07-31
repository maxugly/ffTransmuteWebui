# Filter Platform Contract

> **Status:** Active — source of truth for filter separation  
> **Audience:** Builders migrating ops; PipelineChain; Convert bookends  
> **Related:** `pipeline-spec.md`, `dynamic-mixing-spec.md`, `resolve-transcode-spec.md`, `rife-filter-cleanup-spec.md`

---

## 1. Goal

Stop growing **all-in-one ops** that each own dump → work → encode.

Every frame-level effect becomes a **stage** that only transforms **image sequences on disk**.  
**Bookends** (video/GIF ↔ frames, final codec) live in **one engine**:

| Layer | Module | Owns |
|-------|--------|------|
| Bookends | `video_pipeline` + `convert_presets` | probe, dump, load frames dir, encode presets |
| Workspace | `job_workspace` | per-job dirs, audio sidecar, metadata |
| Chain | `pipeline_chain` | dump once → stages → encode once |
| Stages | `app/filters/*` | **only** frame transforms |
| HTTP ops | `operations/*_ops.py` | thin: params + dump → stage(s) → encode + `OperationResult` |
| Convert UI | `/ops/convert` | user-facing bookends only (no filters) |

**Rule:** If an op still calls ffmpeg dump/encode *and* contains effect logic, it is not done migrating.

---

## 2. Disk contract (non-negotiable)

- Mid-chain format: **PNG**, pattern **`frame_%06d.png`**, **`start_number = 0`**.
- One frame in RAM at a time at the platform level (stages may use temp files).
- No full-video numpy buffers between stages.
- Absolute paths at API boundaries.

Compatible with Convert durable dumps (`frames_png`) and internal JobWorkspace dirs.

---

## 3. Stage kinds

The old lie: everything is `FilterFn(input_png, output_png, index)` 1:1.  
**RIFE and any interpolator break that.** Declare kind explicitly.

### 3.1 `per_frame` (default)

```python
async def filter_fn(input_png: Path, output_png: Path, index: int) -> None:
    # MUST write output_png. 1 input frame → 1 output frame.
    ...
```

Examples: identity, deepdream (simple), withoutbg, styletransfer frame pass.

**Contract:**

- Write exactly `output_png`.
- Do not invent alternate numbering.
- Do not read/write sibling frames unless via closure state that still produces 1:1 files named as given.
- Frame count in == frame count out for that stage.

### 3.2 `directory` (expanding / bulk tools)

```python
async def directory_fn(src_dir: Path, dst_dir: Path) -> dict:
    # Read all frame_*.png in src_dir; write frame_*.png in dst_dir (start 0).
    # May change frame count. Return {"frame_count": N, ...}.
    ...
```

Examples: **RIFE** (prefer one `rife-ncnn-vulkan -i/-o` over N process spawns).

**Contract:**

- Platform does **not** call this once per frame.
- Output sequence must be continuous `frame_%06d.png` from 0 after the stage returns (stage may renumber).
- If frame count changes, chain adjusts encode fps:  
  `out_fps = in_fps * (out_frames / in_frames)` when duration should hold (RIFE),  
  or stage returns explicit `out_fps` / `duration_policy` later.

### 3.3 File-level (out of chain)

Datamosh / ffglitch act on **encoded bitstreams**, not PNG stages.  
Compose at UX: run frame chain → encode → file-level op. Do not fake them as `per_frame`.

### 3.4 Multi-source generators (not yet a registry kind)

**Facemorph** builds a sequence from **N stills** (landmark morph), then encodes. That is not dump(video)→filter. It already writes `JobWorkspace.frames_out` + `video_pipeline.encode`. Optional `dream_mode=after` reuses **filters.deepdream** on the morph video.

A future `multi_source` stage kind may formalize this; until then do not force facemorph into `per_frame`.

---

## 4. Registry

**One registry** for chainable stages (not a paste pile inside `pipeline_ops.py` forever).

Target shape:

```text
app/filters/
  __init__.py          # register_stage, get_stage, STAGE_REGISTRY
  identity.py
  rife.py
  deepdream.py         # factories only; heavy code stays in engines if needed
  ...
```

Each entry:

```python
@dataclass
class StageFactory:
    name: str
    kind: Literal["per_frame", "directory"]
    make: Callable[..., Any]  # returns FilterFn or DirectoryFn
```

- `/ops/pipeline` resolves `filters: [{name, params}]` via this registry only.
- Named ops (`/ops/rife`) call the **same** `make_*` — no second implementation.

Migration path: move factories out of `pipeline_ops.py` as each op is cleaned; registry can live in `filters/` while `pipeline_ops` re-exports until empty of effect code.

---

## 5. Thin op pattern

```python
async def rife_op(params) -> OperationResult:
    ws = JobWorkspace(...)
    try:
        info = await dump(ws, input)
        stage = make_rife_directory(**params)
        meta = await stage(ws.frames_in, ws.frames_out)
        out_fps = info["fps"] * (meta["frame_count"] / info["frame_count"])
        await encode(ws, out, out_fps, mux_audio=True, ...)
        return ok(...)
    finally:
        await cleanup(ws, ...)
```

Op owns: validation, paths, progress labels, `OperationResult`.  
Op does **not** own: alternate ffmpeg dump recipes, duplicate RIFE argv builders, legacy PngFramePipeline forks.

---

## 6. PipelineChain duties

1. `dump` once → stage_0 / frames_in.  
2. For each stage:
   - `per_frame`: loop frames, `filter_fn(src, dst, i)`, cancel between frames.  
   - `directory`: `directory_fn(src_dir, dst_dir)` once, cancel before/after (and inside if long).  
3. Copy/point final stage → `frames_out`.  
4. `encode` once (eventually via `convert_presets` encode preset, default h264).  
5. FPS: if final frame count ≠ dump count, scale fps to preserve duration unless stage says otherwise.

---

## 7. Convert vs filters

| Convert / Export | Filters / pipeline |
|------------------|--------------------|
| Bookends only | Middle only |
| User picks ProRes / frames_png / … | User picks dream → rife → … |
| No `filter_fn` | No container choice (until chain gains encode preset) |

Do not reimplement dump/encode inside filters.

---

## 8. Definition of done for “migrated op”

- [ ] Single stage factory under `app/filters/` (or temporary single module imported by both op + pipeline)
- [ ] Correct `kind` (`per_frame` or `directory`)
- [ ] Named HTTP op is thin bookend wrapper
- [ ] Pipeline uses the same factory (zero paste)
- [ ] No `PngFramePipeline` / legacy path left for that op
- [ ] Spec status matches code
- [ ] `/tmp/teste.mp4` smoke: named op + (if registered) one pipeline chain step

---

## 9. Priority order (cleanup queue)

1. **RIFE** — ✅ `directory` stage in `app/filters/rife.py`
2. **DeepDream** — ✅ video `per_frame` in `app/filters/deepdream.py` (image + ouroboros remain special bookends)
3. **withoutbg** — ✅ video `per_frame` in `app/filters/withoutbg.py` (image batch stays on engine)
4. **styletransfer** — ✅ video `per_frame` in `app/filters/styletransfer.py` (image batch stays on engine)
5. **speedramp** — ✅ directory remap `app/filters/speedramp.py` (not setpts)
6. **Facemorph** — multi-source morph + encode; dream_after → filters.deepdream
7. **PngFramePipeline** — ✅ removed (stub raises); sync I/O on `video_pipeline.dump_frames_sync` / `encode_frames_sync`

---

## 10. What we will not do

- Call 1:N tools “filters” that ignore `output_png` and renumber in a closure without `kind=directory`.
- Spawn one heavy binary process per intermediate frame when a directory mode exists.
- Expand new neural ops until RIFE matches this contract (canary).
