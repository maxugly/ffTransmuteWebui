# AGENTS.md — Operations Subpackage

> **Scope**: `mtapi-project/app/operations`  
> **Audience**: Agents adding/modifying HTTP ops, schemas, engines.

---

## 1. Mission

Ops are the **typed HTTP bridge**. Prefer:

```text
params → validate paths → dump → filters stage(s) → encode → OperationResult
```

**Not:** each op inventing its own ffmpeg dump/encode forever.

Engines (`deepdream/`, `*_engine.py`) hold heavy model/algorithm code.  
Stages (`app/filters/`) hold the sequence-facing factory.  
Ops wire bookends + progress + cancel.

---

## 2. Two patterns

### A. Frame-effect op (default for neural / sequence tools)

1. Factory in `app/filters/<name>.py` with `register_stage` and `kind`.  
2. Thin handler:

```python
async def my_op(p: Params) -> OperationResult:
    ws = JobWorkspace(...)
    try:
        info = await dump(ws, input_path)
        fn = make_my_filter(**p.dict())   # same as pipeline
        # per_frame:
        await process(ws, fn, progress_cb=...)
        # or directory:
        # await fn(ws.frames_in, ws.frames_out)
        await encode(ws, out, fps, ...)
        return OperationResult(ok=True, ...)
    finally:
        await cleanup(ws, ...)
```

3. `register(OperationSpec(...))` + import in `__init__.py`.  
4. Pipeline must resolve the **same** factory (via `STAGE_REGISTRY`) — **zero paste**.

Examples: `rife_ops.py` + `filters/rife.py`; video path in `deepdream_ops.py` + `filters/deepdream.py`.

### B. CLI / file-level op

1. Pydantic params.  
2. `run_command(argv, cwd=...)` — never `shell=True`.  
3. Parse `Output:` / `Command:` when wrapping transmute.  
4. Absolute `output_path`; `unique_output_path` / `finalize_output_path`.

Examples: `transmute_ops.py`, datamosh.

### C. Convert (bookends only)

`convert_ops.py` + `convert_presets.py` — no filter stages. User-facing dump/encode/GIF/frames.

---

## 3. Adding a new operation (checklist)

- [ ] Stage kind chosen (`per_frame` / `directory` / file-level / bookends-only)  
- [ ] Factory in `filters/` if frame effect  
- [ ] Thin `*_ops.py` + `register`  
- [ ] `__init__.py` import  
- [ ] No second copy of filter body in `pipeline_ops.py`  
- [ ] Absolute paths; cancel/progress where long-running  
- [ ] `/tmp/teste.mp4` smoke; pipeline one-step if registered  
- [ ] Root `VERSION` DD bump  
- [ ] Update root `AGENTS.md` ops table if user-visible  

---

## 4. Safety

1. **CWD for transmute** bare outputs → input directory.  
2. **Extensions** on video outputs (`ensure_video_output_path` / finalize helpers).  
3. **HTTP 200 + ok:false** for op failures.  
4. **Do not** reintroduce `PngFramePipeline` for new work.  
5. **Directory stages** must leave continuous `frame_%06d.png` from 0.

---

## 5. Migration status (focus)

| Area | Status |
|------|--------|
| RIFE | ✅ directory stage |
| DeepDream video | ✅ per_frame; image/ouroboros special |
| withoutbg video | ✅ per_frame; image batch on engine |
| styletransfer video | ✅ per_frame; image batch on engine |
| Convert | ✅ bookends |
| Pipeline chain | ✅ per_frame + directory |
| facemorph | multi-source morph + encode; dream_after uses filters.deepdream |
| PngFramePipeline | **removed** (class raises); sync helpers live on `video_pipeline` |

See `docs/filter-platform-spec.md` §8–9.
