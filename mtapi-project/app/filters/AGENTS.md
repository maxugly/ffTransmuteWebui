# AGENTS.md — Filters (Frame Stages)

> **Scope**: `mtapi-project/app/filters`  
> **Audience**: Agents implementing or migrating sequence stages.  
> **Spec**: repo `docs/filter-platform-spec.md`

---

## 1. Mission

This package holds **stage factories only**: transforms on disk image sequences.

**In scope:** reading/writing `frame_*.png`, calling models/binaries, temporal state in closures.  
**Out of scope:** ffmpeg dump/encode of full videos, HTTP, Pydantic ops, UI.

Bookends stay in `video_pipeline` / `convert_presets`. Ops stay thin in `operations/`.

---

## 2. Stage kinds

### `per_frame` (default)

```python
async def filter_fn(input_png: Path, output_png: Path, index: int) -> None:
    # MUST write output_png. Frame count in == out.
    ...
filter_fn.kind = "per_frame"
```

- Blocking work (TF, etc.): `await asyncio.to_thread(...)`.  
- Example: `deepdream.py`.

### `directory`

```python
async def directory_fn(src_dir: Path, dst_dir: Path) -> dict:
    # May change frame count. Return {"frame_count_out": N, ...}
    ...
directory_fn.kind = "directory"
```

- Prefer one bulk tool invocation over N process spawns.  
- Normalize outputs to `frame_%06d.png` start **0** before return.  
- Example: `rife.py`.

---

## 3. Registration

```python
from . import register_stage

def make_foo(**params):
    async def filter_fn(...): ...
    filter_fn.kind = "per_frame"
    return filter_fn

register_stage("foo", make_foo)
```

Import the module from `filters/__init__.py` so registration runs at import time.

`pipeline_ops` resolves via `get_stage_factory(name)`. Named ops import `make_*` from here — **never paste**.

---

## 4. Contract with PipelineChain

- `per_frame`: chain loops frames, passes `dst = stage_dir / src.name`.  
- `directory`: chain calls once `(current_src, stage_dir)`.  
- FPS after expanding stages: scaled by `out_frames / dump_frames` when duration should hold.

---

## 5. Do / Don't

| Do | Don't |
|----|--------|
| One factory per effect name | Duplicate logic in `pipeline_ops` and `*_ops` |
| Set `.kind` explicitly | Fake 1:N as per_frame ignoring `output_png` |
| PNG mid-chain, start 0 | Invent alternate frame naming mid-pipeline |
| Check `job_control` where loops allow | Own dump/encode of user videos |

---

## 6. Current stages

| name | kind | module |
|------|------|--------|
| `rife` | directory | `rife.py` |
| `deepdream` | per_frame | `deepdream.py` |
| `withoutbg` | per_frame | `withoutbg.py` |
| `styletransfer` | per_frame | `styletransfer.py` |

`PngFramePipeline` is gone (raises if constructed). Sync dump/encode: `video_pipeline.dump_frames_sync` / `encode_frames_sync`.
