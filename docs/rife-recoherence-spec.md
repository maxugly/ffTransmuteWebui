# RIFE Recoherence (One Per Triplet) — Spec

> **Status:** **Implemented** (`000.000.4.62`) — keep all RIFE mids; img2img every mid
> **Date:** 2026-08-03  
> **Builder prompt:** [coder-rife-recoherence-prompt.md](archive/coder-rife-recoherence-prompt.md)  
> **Audience:** Builders & reviewers  
> **Depends on (shipped):** `filters/rife.py`, `filters/img2img.py` (`frame_indices`), `image_sort.conform_image`, `video_pipeline.encode`  
> **Related:** `filter-platform-spec.md`, `img2img-openvino-spec.md`, `image-sort-rife-spec.md`, `STATUS.md`  
> **Not this (v1):** Multi-pair walk (K>2 mids), Image Sort checkbox, TSP/chain rank, ControlNet, tilagup

---

## 1. Problem

When RIFE interpolates between **unrelated** stills (e.g. car → soup), the mid frame is often a transparent **ghost blend**. Density (higher M) only multiplies the same incoherence. High-quality morphs need the mid to collapse into **one** solid, recognizable frame.

---

## 2. Solution (two stills → all mids recohered)

```text
A, B  (two stills)
  → conform same geometry → frames_in: frame_000000.png, frame_000001.png
  → RIFE multiplier=2      → frames_out: typically 4 frames (A · mid · mid · B)
  → img2img every mid      → frame_indices = [1] or [1,2]  (A/B copy through)
  → encode full strip      → short .mp4 (3 or 4 frames)
  → optional: write all strip PNGs next to the video
```

**Do not discard a mid** when RIFE returns 4 frames. Both intermediates get img2img.
If RIFE returns 3, only index `1` is a mid. Endpoints (0 and last) never go through img2img.

### Universal recoherence prompts (defaults)

| | Value |
|--|--------|
| **Positive** | `a single coherent object, well-composed scene, centered, sharp focus, highly detailed, intricate details, volumetric lighting, masterpiece, best quality, photorealistic` |
| **Negative** | `blurry, lowres, duplicate, double image, two images, split screen, collage, double exposure, ghosting, transparent, deformed, messy, incoherent, watermark, text` |

### Default img2img knobs (OpenVINO / FastSD stack)

Our img2img path is **turbo/LCM OpenVINO**, not classic full SD1.5. Defaults are tuned for that stack while keeping the **prompt + strength** as the main recoherence levers. All are **exposed in the UI** (prefilled, not hardcoded-only).

| Param | Default | Range / notes |
|-------|---------|----------------|
| `strength` | **0.55** | 0.05–0.95; sweet spot ~0.50–0.65 for ghost collapse |
| `guidance_scale` | **1.5** | LCM-friendly (classic CFG 6 is for non-LCM SD1.5) |
| `inference_steps` | **8** | 1–30; higher than turbo’s 4 for more rewrite |
| `model_id` | `rupeshs/LCM-dreamshaper-v7-openvino` | Same catalog as img2img tab; also allow turbo / sd15-lcm |
| `device` | `gpu` | Same as img2img |
| `seed` | `42` | Fixed for reproducibility; `null` / omit = random if worker supports it |
| `max_side` | `0` | 0 = native (%%8); 512/768 if VRAM tight |

---

## 3. Locked product decisions (was § Open Questions)

| # | Question | **Locked v1** |
|---|----------|----------------|
| 1 | Output format | **Primary:** encode short **video** (`.mp4`, default fps **6** so 3 frames play slowly). **Optional flag** `save_stills: true` → also write `*_000.png`, `*_001.png`, `*_002.png` next to the video. Image Pool auto-ingest is **out of scope** (user can add stills manually). |
| 2 | UI location | **Dedicated tab** “RIFE Recohere”. Do **not** bolt onto Image Sort in v1. (Later: optional “recohere mids” on Image Sort.) |
| 3 | Knobs | **Expose** strength, guidance, steps, model, prompts, fps, seed, max_side, dry_run. Defaults = table above. |

---

## 4. Architecture

### 4.1 No new filter kind required

Compose existing stages in a **thin named op**. Do **not** invent a second dump/encode path. Do **not** paste RIFE/img2img logic; call:

- `image_sort.conform_image` (or equivalent PIL conform already used by Image Sort)
- `filters.rife.run_rife_directory`
- `filters.img2img.run_img2img_directory` with `frame_indices=[1]`
- `video_pipeline.encode` (or `encode_frames_sync` only if that is the established still-sequence helper — prefer async encode used by other still→video ops)

Optional later: register a composite pipeline recipe; **not required for v1**.

### 4.2 Mid-chain naming (invariant)

| Rule | Value |
|------|--------|
| Pattern | `frame_%06d.png` |
| Start | **0** |
| Conform targets | `frames_in/frame_000000.png` = A, `frames_in/frame_000001.png` = B |
| After RIFE M=2 + normalize | 3 frames: `000000` (A), `000001` (Mid), `000002` (B) |
| img2img mark | `frame_indices=[1]` only |

**Never** use bare `000000.png` without the `frame_` prefix.

If RIFE emits a different count, fail clearly (`expected 3 frames after RIFE M=2 on 2 inputs, got N`) after `normalize_frame_sequence`.

### 4.3 Operation

| Item | Value |
|------|--------|
| Op id | `rife_recohere` |
| File | `mtapi-project/app/operations/rife_recohere_ops.py` |
| Route | `POST /ops/rife_recohere` (via registry) |
| Result | `OperationResult` |

### 4.4 Request schema (Pydantic)

```python
class RifeRecohereParams(BaseModel):
    image_a: str = Field(..., description="First still (absolute path preferred)")
    image_b: str = Field(..., description="Second still")
    output_path: str | None = None
    # RIFE
    rife_model: str = Field("rife-v4.6")  # same choices as RIFE op if typed
    tta: bool = False
    uhd: bool = False
    # encode
    fps: float = Field(6.0, gt=0, le=60)
    save_stills: bool = False
    # img2img recoherence
    prompt: str = Field(DEFAULT_POSITIVE)
    negative_prompt: str = Field(DEFAULT_NEGATIVE)
    strength: float = Field(0.55, ge=0.05, le=0.95)
    guidance_scale: float = Field(1.5, ge=0.0, le=20.0)
    inference_steps: int = Field(8, ge=1, le=50)
    model_id: str = Field("rupeshs/LCM-dreamshaper-v7-openvino")
    device: str = Field("gpu")
    seed: int | None = Field(42)
    max_side: int = Field(0, ge=0)
    fit: str = Field("cover")  # cover | contain — same as Image Sort conform
    dry_run: bool = False
```

`multiplier` is **fixed at 2** for this op (one mid). Do not expose M in v1.

### 4.5 Handler pipeline (phases)

Progress via `job_control.report_progress` every item / phase boundary. Phase names:

| Phase | What |
|-------|------|
| `conform` | Size A/B even dims; write 2 PNGs into `ws.frames_in` |
| `rife` | `run_rife_directory(..., multiplier=2)` → `ws.frames_out` (dir watch already inside RIFE) |
| `img2img` | Copy or swap dirs so img2img reads RIFE out; `frame_indices=[1]`; write recohered set |
| `encode` | Encode 3 frames @ `fps` to `.mp4` |
| `stills` | If `save_stills`, copy 3 PNGs beside video |

**Workspace:** `JobWorkspace` with prefix e.g. `rife_recohere_`. Cleanup on success like peer ops; keep on failure if that is the local convention.

**Geometry:** Use A as size reference (like Image Sort: open A, even width/height). Conform B (and A) with `fit` (`cover` default).

**Output path:** `finalize_output_path` with suffix `_rife_recohere`, ext `.mp4`, source = image_a.

**Dry run:** Resolve paths, print planned summary (no RIFE/img2img/encode). Return `ok=True`, `dry_run=True`.

**Missing FastSD / RIFE binary:** Same clear `RuntimeError` / `OperationResult(ok=False, error=…)` as `/ops/img2img` and `/ops/rife`.

### 4.6 Frontend

| Item | Value |
|------|--------|
| Tab id | `riferecohere` (or `rife_recohere` — match existing camel/id style in `app.js`) |
| File | `mtapi-project/app/static/js/tabs/riferecohere.js` |
| Register | `index.html` + `app.js` tab map |
| Label | **RIFE Recohere** |

Form fields:

- Image A, Image B (browse; fall back to Image Pool / global image bar if project pattern exists — at minimum two path inputs)
- Output path (optional)
- Prompt / negative (prefilled with universal defaults)
- Model select (same options as img2img tab)
- Knobs: strength, steps, guidance, fps, max_side, seed, dry_run, save_stills (binary)
- Optional: RIFE TTA / UHD binary knobs (can hide under advanced or omit if crowded; backend still accepts)
- Bottom `.tool-docs` short About (problem, M=2 fixed, mid only img2img, FastSD dependency)

Wire `POST /ops/rife_recohere` via existing job-control submit pattern (same as img2img / imagesort).

---

## 5. Files to touch

| Path | Action |
|------|--------|
| `mtapi-project/app/operations/rife_recohere_ops.py` | **NEW** — schema + handler + register |
| `mtapi-project/app/operations/__init__.py` | Import side-effect register |
| `mtapi-project/app/static/js/tabs/riferecohere.js` | **NEW** — form + submit |
| `mtapi-project/app/static/app.js` | Tab registration |
| `mtapi-project/app/static/index.html` | Tab button if tabs are HTML-listed |
| Root `AGENTS.md` op registry | One row |
| `mtapi-project/AGENTS.md` | Mention if it lists tabs |
| `docs/STATUS.md` | Move to shipped when done; VERSION DD |
| Root `VERSION` | Bump far-right DD |

**Do not** add a new `filters/recoherence.py` unless reuse appears later.

---

## 6. Verification

Assets: `/tmp/teste.png` plus a second still (duplicate is OK for smoke; better: different image).

```bash
# second still if needed
ffmpeg -y -f lavfi -i "color=c=blue:s=320x240:d=1" -vframes 1 /tmp/teste_b.png
```

1. Server up on `:24590`; FastSD env present (`MTAPI_FASTSD_ROOT`).
2. WebUI → **RIFE Recohere** tab renders, knobs work, no console errors.
3. A=`/tmp/teste.png`, B=`/tmp/teste_b.png` (or two real photos), dry_run once.
4. Full run → `ok: true`, short mp4 with 3 frames; middle should differ from pure ghost (quality subjective; **must not crash**).
5. Optional: `save_stills` → three PNGs beside video.
6. Cancel mid-job if easy; at least ensure cancel flag is checked between phases like peer ops.

**Claim DONE only after WebUI path** (root `AGENTS.md` §D). Curl alone is not enough if UI was added.

---

## 7. Out of scope / later

- Image Sort “recohere each mid” for K>2 with M>2 (multiple mids per pair)
- Returning stills into Image Pool automatically
- Pipeline UI multi-stage builder entry
- Per-frame custom prompts (v1 = one universal prompt for the single mid)
- Classic high-CFG SD1.5 non-LCM (unless FastSD gains that model)

---

## 8. Ship checklist

- [ ] Op registered; OpenAPI shows `/ops/rife_recohere`
- [ ] Tab works; bottom tool-docs present
- [ ] Progress phases visible in job UI
- [ ] VERSION DD + STATUS shipped row + this banner → **Implemented**
- [ ] Commit with clear message
