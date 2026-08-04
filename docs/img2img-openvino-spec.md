# OpenVINO Img2Img Pipeline Stage — Spec (expedite)

> **Status:** **Implemented** (v1) — `000.000.4.55`  
> **Audience:** Builders & reviewers  
> **Code:** `app/filters/img2img.py`, `img2img_ov_worker.py`, `operations/img2img_ops.py`  
> **Reference:** `/home/m/.gemini/antigravity-cli/scratch/fastsdcpu` (OpenVINO GPU)  
> **Related:** `filter-platform-spec.md`, `pipeline_ops.py`, `STATUS.md`  
> **Not this (v1):** Pipeline UI tab · tilagup tiles · ControlNet · Flux edit

---

## 1. Goal

1. Add **`img2img`** as a **filter-platform stage** so it can run inside **`POST /ops/pipeline`** (and a thin dedicated op if useful).  
2. **Mark specific frames / stills** so only those run through SD; unmarked frames **copy through** unchanged.  
3. **v1 engine = FastSD’s OpenVINO path on GPU** (`DEVICE=gpu`), not reinventing optimum plumbing.

**User story:** dump video (or still sequence) → img2img only frames I marked with a prompt/strength → rest untouched → encode.

---

## 2. How FastSD does it (ground truth)

Scratch tree: `/home/m/.gemini/antigravity-cli/scratch/fastsdcpu`

| Piece | Location / behavior |
|-------|---------------------|
| Pipeline class | `OVStableDiffusionImg2ImgPipeline.from_pretrained(...)` in `src/backend/openvino/pipelines.py` → `get_ov_image_to_image_pipeline` |
| Device | `DEVICE` env (`gpu` via `start-webui-gpu.sh`); `device=DEVICE.upper()` on load |
| Default model | `rupeshs/sd-turbo-openvino` (`constants.LCM_DEFAULT_MODEL_OPENVINO`) |
| Task flag | `DiffusionTask.image_to_image` |
| Call shape | `pipeline(image=init_pil, strength=…, prompt=…, negative_prompt=…, num_inference_steps=…, guidance_scale=…)` |
| Strength quirk | OpenVINO path multiplies steps: `num_inference_steps=img_to_img_inference_steps * 3` in `lcm_text_to_image.generate` |
| UI defaults | strength slider 0.1–1.0; init image = PIL |
| Working venv | `…/fastsdcpu/env/bin/python` — **has** openvino + optimum-intel |

**mtapi `.venv` does not ship openvino/optimum.** Do **not** add multi‑GB stacks to the slim server venv for v1.

### v1 execution strategy (locked)

**Subprocess worker** under FastSD’s Python (same pattern as tilagup → FastSD):

```text
mtapi filter stage
  → create_subprocess_exec(
       FASTSD_PYTHON, worker_script,
       --in frame.png --out out.png
       --prompt … --strength … --model … --device gpu
     )
```

Env:

| Variable | Meaning | Default |
|----------|---------|---------|
| `MTAPI_FASTSD_ROOT` | FastSD checkout root | `/home/m/.gemini/antigravity-cli/scratch/fastsdcpu` if exists |
| `MTAPI_FASTSD_PYTHON` | Python with OV | `$MTAPI_FASTSD_ROOT/env/bin/python` |
| `DEVICE` | OpenVINO device | `gpu` |

Worker may either:

- **A (preferred for speed):** thin script that only uses `optimum.intel` + PIL (copy ~20 lines from `get_ov_image_to_image_pipeline` + one generate call), **or**  
- **B:** import FastSD `LCMTextToImage` / settings (heavier coupling).

**Prefer A** so we do not depend on FastSD’s global settings YAML. Still run **with FastSD’s python**.

Keep a **process-level model cache** in the worker: if we spawn per frame, load time kills us. Options:

1. **Per-frame spawn** (simplest, slow) — OK for smoke / few marked frames.  
2. **Directory worker** (recommended v1 ship): one process loads model once, loops marked frames, writes outs, exits.

**v1 ship = directory-aware stage** that for unmarked frames copies, for marked runs batch in **one** long-lived worker process (stdin JSONL or a job folder). Simplest durable shape:

```text
kind = directory  (or hybrid — see §4)
stage writes job.json + only processes selected indices
worker: load OV pipeline once → for each path → img2img → save PNG
```

---

## 3. Marking specific images / frames

### 3.1 Indices (video / sequence pipeline)

0-based indices into the **current stage’s frame list** (after dump, `frame_000000.png` = index 0).

```json
{
  "name": "img2img",
  "params": {
    "prompt": "cinematic fog, detailed",
    "negative_prompt": "blurry, low quality",
    "strength": 0.35,
    "inference_steps": 4,
    "guidance_scale": 1.0,
    "model_id": "rupeshs/sd-turbo-openvino",
    "device": "gpu",
    "frame_indices": [0, 12, 24, 48],
    "frame_range": null
  }
}
```

| Field | Meaning |
|-------|---------|
| `frame_indices` | Explicit list of 0-based indices to process |
| `frame_range` | Optional `[start, end]` inclusive 0-based alternative |
| both null / empty | **All frames** (full sequence img2img) |

Unmarked frames: **`shutil.copy2(src, dst)`** (identity).

### 3.2 Stills (Image Pool / multi path) — v1.1 if time

Dedicated op `POST /ops/img2img` with `image_paths: list[str]` and optional `selected_paths` or indices into that list. Pipeline path is enough for “mark frames on a video”; stills can use Convert dump → pipeline for v1.

### 3.3 UI (minimum for expedite)

**Pipeline tab** (or existing dynamic mix UI if any):

- Filter row: add **img2img**  
- Prompt / negative / strength / steps  
- **Frames:** text field `0,12,24` or `all`  
- Checkbox later: “pick from scrubber” — **not** required for first land

**Image Sort is separate** — do not overload Sort list selection as img2img marks unless product asks; use pipeline frame indices first.

---

## 4. Stage registration

### 4.1 Factory

`app/filters/img2img.py`:

```python
register_stage("img2img", make_img2img_stage)

def make_img2img_stage(
    *,
    prompt: str = "",
    negative_prompt: str = "",
    strength: float = 0.35,
    inference_steps: int = 4,
    guidance_scale: float = 1.0,
    model_id: str = "rupeshs/sd-turbo-openvino",
    device: str = "gpu",
    frame_indices: list[int] | None = None,
    frame_range: list[int] | None = None,  # [start, end] inclusive
    **_extra,
):
    async def directory_fn(src_dir: Path, dst_dir: Path) -> dict:
        ...
    directory_fn.kind = "directory"
    directory_fn.stage_name = "img2img"
    return directory_fn
```

**Why directory for v1:** one worker process, one model load, N marked frames. Internally still 1:1 frame count (copy or img2img each name).

### 4.2 Algorithm

```text
frames = sorted(src_dir / frame_*.png)
selected = resolve_selection(len(frames), frame_indices, frame_range)
# selected = set of indices; empty selection → all

dst_dir.mkdir()
# copy ALL first (or copy unmarked only — either order OK)
for i, src in enumerate(frames):
  dst = dst_dir / src.name
  if i not in selected:
    copy2(src, dst)
  else:
    # collect for worker batch
    marked.append((src, dst))

if marked:
  run_openvino_worker(marked, prompt, strength, ...)
  report_progress per frame

return {"frame_count": len(frames), "img2img_count": len(marked)}
```

Progress: `phase=img2img`, `current` / `total=len(marked)`, unit=`frames`.

### 4.3 Worker script

`mtapi-project/app/filters/img2img_ov_worker.py` (or `bin/img2img_ov_worker.py`):

- Invoked only with FastSD python.  
- Args or JSON file:

```json
{
  "pairs": [{"in": "/abs/a.png", "out": "/abs/b.png"}, ...],
  "prompt": "...",
  "negative_prompt": "",
  "strength": 0.35,
  "inference_steps": 4,
  "guidance_scale": 1.0,
  "model_id": "rupeshs/sd-turbo-openvino",
  "device": "GPU"
}
```

- Load `OVStableDiffusionImg2ImgPipeline.from_pretrained(model_id, device=device, safety_checker=None, …)` once.  
- For each pair: open PIL RGB → pipeline → save PNG.  
- Print progress lines `PROGRESS i/N` for parent to parse optional; parent can also count output files.  
- Exit non-zero on fatal load error.

**Even dimensions:** OpenVINO SD often wants multiples of 8; resize/pad init to multiple of 8 then crop back if needed (document; match FastSD width/height settings when possible — use image native size rounded down to %8).

### 4.4 Thin op (optional same PR)

`POST /ops/img2img` for single image or short list:

```json
{
  "image_paths": ["/a.png", "/b.png"],
  "selected_indices": [0],
  "prompt": "...",
  "strength": 0.35,
  "output_dir": null
}
```

Or video: dump → stage → encode via thin bookends (mirror styletransfer video path). **Pipeline stage first**; standalone op if time.

---

## 5. API / pipeline body example

```json
POST /ops/pipeline
{
  "input_path": "/tmp/teste.mp4",
  "filters": [
    {
      "name": "img2img",
      "params": {
        "prompt": "oil painting, rich color",
        "strength": 0.4,
        "inference_steps": 4,
        "frame_indices": [0, 1, 2, 10]
      }
    }
  ],
  "start_frame": 1,
  "end_frame": 48
}
```

Dry-run: print selection count + model + FastSD python path without loading OV.

---

## 6. Params & defaults

| Param | Default | Notes |
|-------|---------|--------|
| `prompt` | `""` | Required non-empty for selected frames (error if empty and any selected) |
| `negative_prompt` | `""` | |
| `strength` | `0.35` | 0.05–0.95; low = preserve, high = rewrite |
| `inference_steps` | `4` | turbo/LCM-ish; FastSD multiplies ×3 on OV img2img — **match FastSD** or document if we pass raw steps only. **v1: pass `max(1, int(steps * strength))` then apply FastSD `* 3` for OV** for parity, or expose `steps` as “pipeline steps” after their formula. Prefer **parity with FastSD UI strength behavior**. |
| `guidance_scale` | `1.0` | |
| `model_id` | `rupeshs/sd-turbo-openvino` | Must be OV-export compatible |
| `device` | `gpu` | → OpenVINO `GPU` |
| `frame_indices` | `null` | all if null |
| `frame_range` | `null` | |

---

## 7. Files to touch

| File | Change |
|------|--------|
| `app/filters/img2img.py` | Stage factory + selection + spawn worker |
| `app/filters/img2img_ov_worker.py` | Standalone OV worker (run under FastSD python) |
| `app/filters/__init__.py` | Import register |
| `app/operations/img2img_ops.py` | Optional thin still/video op |
| `app/operations/__init__.py` | Import if op added |
| Pipeline UI JS | If there is a pipeline tab — add filter + fields; else document curl-first |
| `docs/STATUS.md` | Partial → Implemented when done |
| Root `VERSION` | DD bump |

**Do not** install openvino into mtapi `.venv` in v1 unless human insists.

---

## 8. Implementation order (expedite)

1. **Worker smoke** (CLI): one `/tmp/teste.png` → out with FastSD python + GPU.  
2. **Stage** `img2img` directory + copy-through selection.  
3. **Pipeline** curl with 2–4 marked frames on short dump.  
4. **Progress** every marked frame.  
5. **UI** minimal fields if pipeline UI exists; else console/curl OK for “works”.  
6. STATUS + VERSION.

Skip tilagup tiles, quality, queue for this PR.

---

## 9. Pitfalls

| Pitfall | Mitigation |
|---------|------------|
| Model load per frame | One worker process per stage call |
| Wrong Python | Resolve `MTAPI_FASTSD_PYTHON`; clear error if missing |
| OOM on 16GB + 1024² | Default process native size; cap long side 768 optional param later |
| Steps ×3 surprise | Match FastSD; document in tool-docs |
| Even size / OV reshape | %8 dimensions |
| Blocking event loop | `asyncio.create_subprocess_exec` + poll; progress |
| Flux2 Klein | Not for img2img in FastSD — do not use as default |
| Marked index OOB | Clamp / skip with log |
| Empty prompt | Fail stage with clear error |

---

## 10. Verification

```bash
# 0) env
test -x /home/m/.gemini/antigravity-cli/scratch/fastsdcpu/env/bin/python

# 1) worker alone
DEVICE=gpu that_python app/filters/img2img_ov_worker.py --job /tmp/i2i_job.json

# 2) pipeline (server running)
curl -s -X POST http://localhost:24590/ops/pipeline \
  -H "Content-Type: application/json" \
  -H "X-Job-Token: $(python -c 'import uuid;print(uuid.uuid4().hex)')" \
  -d '{
    "input_path":"/tmp/teste.mp4",
    "filters":[{
      "name":"img2img",
      "params":{
        "prompt":"watercolor illustration",
        "strength":0.4,
        "frame_indices":[0,5,10]
      }
    }]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok'), d.get('error'), d.get('output_path'))"
```

Checks:

1. `ok: true`, output video exists.  
2. Unmarked frames look like source; marked frames show prompt influence.  
3. Progress climbs for marked count only.  
4. Missing FastSD python → `ok: false` with install path message.  
5. Cancel mid-stage stops worker.

**DONE** = pipeline stage registered + selection copy-through + OV GPU worker via FastSD env + smoke on `/tmp/teste.mp4`.

---

## 11. Follow-ups (not this sprint)

- Image Pool multi-select → `selected_paths` still op  
- Model warm daemon (avoid reload between jobs)  
- Tiled / tilagup prompts per region  
- Native optimum in mtapi venv  
- Pipeline UI scrubber “mark in / mark out”  

---

## 12. One-line summary

**Filter-platform `img2img` stage: OpenVINO SD via FastSD’s GPU python, process only marked frame indices (rest copy), one model load per stage, wire into `/ops/pipeline` first.**
