# RIFE Filter Cleanup

> **Status:** Implemented (2026-07-31) — `app/filters/rife.py`, thin `rife_ops.py`  
> **Depends on:** `filter-platform-spec.md` (stage kinds), existing `video_pipeline`  
> **Replaces / supersedes:** pairwise “fake FilterFn” design in `rife-migration-spec-legacy.md`

---

## 1. Why

Current RIFE is a canary failure of filter separation:

| Issue | Detail |
|-------|--------|
| Not a real `per_frame` filter | Ignores `output_png`, expands frames, wrong contract |
| Duplicated | Logic in `rife_ops.py` **and** `pipeline_ops._make_rife_filter` |
| Timeline bug | `index==0` copies first frame `multiplier` times |
| Performance | One `rife-ncnn-vulkan` process **per intermediate step** |
| Legacy dead weight | `rife_interpolate_legacy` + `PngFramePipeline` still in file |
| Spec drift | `rife-spec.md` still describes whole-dir via PngFramePipeline as current |

---

## 2. Target design

### 2.1 Kind: `directory`

RIFE is a **directory stage**, not per-frame:

```text
frames_in/frame_000000.png … frame_0000NN.png
        │
        ▼  single rife-ncnn-vulkan -i src -o dst -n N*M -f frame_%06d.png
frames_out/frame_000000.png …  (continuous, start 0 after normalize)
```

Binary is built for folder I/O. Use it.

### 2.2 Single factory

```text
app/filters/rife.py
  make_rife_directory_fn(**params) -> DirectoryFn
  run_rife_directory(src_dir, dst_dir, *, multiplier, model, tta, uhd) -> dict
```

- `rife_ops.rife_interpolate` imports and calls this after `dump`, then `encode`.
- `pipeline_ops` registers the same factory with `kind=directory` (no paste).

### 2.3 Thin op

```text
probe/dump → run_rife_directory(frames_in, frames_out) → encode(fps * multiplier) → cleanup
```

Audio: keep `mux_audio=True` (duration preserved when frame count scales with multiplier and fps scales match).

### 2.4 PipelineChain

Extend chain to detect directory stages:

- If stage callable has `kind == "directory"` (or StageSpec), call once `(src_dir, dst_dir)`.
- Recompute `total_frames` / fps scale from output glob count.

---

## 3. Implementation details

### 3.1 Binary

- Resolve `rife-ncnn-vulkan` via `shutil.which` with fallback `/usr/bin/rife-ncnn-vulkan`.
- Fail with clear error if missing.

### 3.2 Argv (directory mode)

```text
rife-ncnn-vulkan \
  -i SRC_DIR -o DST_DIR \
  -n (in_count * multiplier) \
  -m MODEL \
  -f frame_%06d.png \
  [-x] [-u] [-v]
```

- `in_count` = number of `frame_*.png` in SRC (or all png if pattern mixed — prefer `frame_*.png`).
- After run: **normalize** outputs to `frame_%06d.png` starting at **0** if the binary used 1-based or gaps (sort, rename into temp then swap, or renumber in place carefully).

### 3.3 FPS / duration

```text
out_fps = in_fps * multiplier
# assert roughly: out_frames ≈ in_frames * multiplier
```

If out_frames differs slightly, prefer:

```text
out_fps = in_fps * (out_frames / in_frames)
```

so duration holds (same policy as PipelineChain heuristic).

### 3.4 Cancel

- Check `job_control.check_cancelled()` before spawn.
- On cancel during wait: kill process group if feasible (best-effort).

### 3.5 Delete

- Remove `rife_interpolate_legacy` and any `PngFramePipeline` use from `rife_ops.py`.
- Remove pairwise loop from `pipeline_ops._make_rife_filter` (replace with import).

### 3.6 Docs

- Update `rife-spec.md` status + architecture to directory stage + filters/.
- Mark `rife-migration-spec-legacy.md` superseded by this doc (or status: superseded).

---

## 4. Files to touch

| File | Action |
|------|--------|
| `app/filters/__init__.py` | new — optional light registry helpers |
| `app/filters/rife.py` | new — directory runner + factory |
| `app/operations/rife_ops.py` | thin wrapper; drop legacy + pairwise |
| `app/operations/pipeline_ops.py` | register shared factory; drop local RIFE body |
| `app/pipeline_chain.py` | run `directory` stages once |
| `docs/rife-spec.md` | refresh |
| `VERSION` | bump DD |

---

## 5. Verification

```bash
# named op
curl -s -X POST http://localhost:24590/ops/rife \
  -H 'Content-Type: application/json' \
  -d '{"input_path":"/tmp/teste.mp4","multiplier":2}' 

# expect ok, ~2x frame rate, duration ~2s, audio present
ffprobe -hide_banner <output>

# pipeline single stage
curl -s -X POST http://localhost:24590/ops/pipeline \
  -H 'Content-Type: application/json' \
  -d '{"input_path":"/tmp/teste.mp4","filters":[{"name":"rife","params":{"multiplier":2}}]}'

# no JS required for backend DONE; if UI RIFE tab used, zero console errors
```

Also: one dry_run; missing binary error message; cancel mid-run if easy.

---

## 6. Non-goals

- Changing RIFE models UI
- GPU selection flags beyond existing tta/uhd
- Pairwise `-0/-1/-s` mode (gone unless binary directory mode proven broken — then document exception)
- Facemorph / deepdream cleanup (next queue items)
