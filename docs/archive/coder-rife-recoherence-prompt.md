# Coder Prompt — RIFE Recoherence (`rife_recohere`)

> **Target:** ffTransmuteWebui / mtapi-project — new thin op + WebUI tab  
> **Spec (law):** [`docs/rife-recoherence-spec.md`](rife-recoherence-spec.md) — read it first; decisions are locked  
> **Role:** Builder (codewhale / codex / opencode). Implement working code. Do not re-open product questions already locked in the spec.

---

## MISSION

Build **RIFE Recoherence (one mid per pair)**:

1. Two stills A + B  
2. Conform → RIFE `multiplier=2` → triplet A · Mid · B  
3. OpenVINO **img2img only on mid** (`frame_indices=[1]`) with universal recoherence prompt defaults  
4. Encode short `.mp4` (optional side PNGs)  
5. Dedicated WebUI tab **RIFE Recohere**

This is **orchestration only**. Reuse existing RIFE + img2img stages. Do **not** invent a new filter module or a second dump/encode stack.

---

## PHASE 0 — SCOUT (read before writing)

| File | Why |
|------|-----|
| `docs/rife-recoherence-spec.md` | Locked design, schema, phases, verification |
| `docs/STATUS.md` | Where we are; do not re-spec shipped work |
| `docs/filter-platform-spec.md` | dump → stage → encode law |
| `mtapi-project/app/filters/rife.py` | `run_rife_directory`, `normalize_frame_sequence` |
| `mtapi-project/app/filters/img2img.py` | `run_img2img_directory`, `frame_indices` |
| `mtapi-project/app/operations/img2img_ops.py` | Thin op + FastSD error pattern + register |
| `mtapi-project/app/operations/imagesort_rife_ops.py` | Conform stills, RIFE, encode, progress phases |
| `mtapi-project/app/image_sort/conform.py` | `conform_image` |
| `mtapi-project/app/job_workspace.py` | `JobWorkspace` |
| `mtapi-project/app/video_pipeline.py` | `encode` for frame dirs |
| `mtapi-project/app/operations/__init__.py` | Import register pattern |
| `mtapi-project/app/static/js/tabs/img2img.js` | Form / knobs / model select pattern |
| `mtapi-project/app/static/js/tabs/imagesort.js` | Multi-path + tool-docs + job submit |
| `mtapi-project/app/static/app.js` | Tab map |
| Root + `mtapi-project/AGENTS.md` | Invariants, VERSION, verification §D |

**Invariants you must not break**

- Absolute paths  
- Mid-chain: `frame_%06d.png`, start **0**  
- No `shell=True`  
- `report_progress` every loop / phase; RIFE already has dir watch  
- Op failures → HTTP 200 + `ok: false` via `OperationResult`  
- Vanilla JS only (no npm/React)

---

## PHASE 1 — BACKEND

### 1.1 NEW `mtapi-project/app/operations/rife_recohere_ops.py`

Implement exactly as specified in the spec §4.3–4.5.

**Constants**

```python
DEFAULT_POSITIVE = (
    "a single coherent object, well-composed scene, centered, sharp focus, "
    "highly detailed, intricate details, volumetric lighting, masterpiece, "
    "best quality, photorealistic"
)
DEFAULT_NEGATIVE = (
    "blurry, lowres, duplicate, double image, two images, split screen, "
    "collage, double exposure, ghosting, transparent, deformed, messy, "
    "incoherent, watermark, text"
)
```

**Params** — match spec `RifeRecohereParams` (image_a, image_b, output_path, rife knobs, fps, save_stills, img2img knobs, fit, dry_run). **`multiplier` is fixed at 2** — do not put it on the public form.

**Handler outline**

```text
validate A,B files (image exts)
resolve FastSD early (same as img2img) → fail ok=False if missing
resolve rife bin path check if cheap; else fail at RIFE with clear error
finalize_output_path → *_rife_recohere.mp4
if dry_run: return summary

ws = JobWorkspace(...)
ws.create()
try:
  phase conform:
    size from A (even W/H)
    conform A → frames_in/frame_000000.png
    conform B → frames_in/frame_000001.png
  phase rife:
    run_rife_directory(frames_in, frames_out, multiplier=2, model=..., tta=..., uhd=...)
    normalize already inside run_rife_directory — assert out count == 3
  phase img2img:
    # Prefer: img2img from frames_out → third dir, or in-place pattern used elsewhere
    # CRITICAL: frame_indices=[1]
    run_img2img_directory(
      src, dst,
      prompt=..., negative_prompt=...,
      strength=..., inference_steps=..., guidance_scale=...,
      model_id=..., device=..., max_side=...,
      frame_indices=[1],
    )
  phase encode:
    video_pipeline.encode(ws, encode_dir, out_path, fps=p.fps, ...)  # match peers
  if save_stills:
    copy three PNGs next to video with stable names
  success OperationResult(ok=True, output_path=..., stdout=logs)
finally:
  cleanup workspace per peer convention
```

**Dir ping-pong:** Follow Image Sort / img2img video pattern: after RIFE, either

- img2img `src=frames_out`, `dst=frames_in` (cleared) or a `frames_mid` if workspace has it, **or**  
- reuse the double-buffer pattern already in `img2img_ops` / pipeline chain.

Whatever you pick, final encode dir must be the **post-img2img** triplet with mid rewritten and A/B intact.

**Seed:** Pass through to worker **if** `run_img2img_directory` / worker already support it. If not supported yet, keep `seed` on the schema for forward compat and document in logs that seed is ignored — **do not** block the ship on a large worker change unless adding seed is a few lines.

**Register**

```python
register(OperationSpec(
    id="rife_recohere",
    name="RIFE Recoherence",
    description="RIFE mid-frame + OpenVINO img2img ghost collapse (one mid per pair)",
    params_model=RifeRecohereParams,
    handler=rife_recohere_run,  # name as you like
    ...
))
```

Match `OperationSpec` fields used by `img2img_ops` / `rife_ops`.

### 1.2 `operations/__init__.py`

Import the new module so registration runs (same style as other ops).

---

## PHASE 2 — FRONTEND

### 2.1 NEW `mtapi-project/app/static/js/tabs/riferecohere.js`

Mirror **img2img** knobs + **two path inputs** (Image A / Image B). Prefill prompt/negative with defaults from the spec. Model select = same three OpenVINO options; **default selected = LCM-dreamshaper-v7-openvino**.

Knobs:

| Control | Default |
|---------|---------|
| strength | 0.55 |
| steps | 8 |
| guidance | 1.5 |
| fps | 6 |
| max_side | 0 |
| seed | 42 |
| save_stills | off |
| dry_run | off |

Submit body keys must match Pydantic field names (`image_a`, `image_b`, …).

Bottom **`.tool-docs`** (short): why mid ghosting, M=2 fixed, only mid img2img’d, needs FastSD GPU env + rife-ncnn-vulkan.

### 2.2 Wire tab

- `app.js` — import/render like other tabs  
- `index.html` — tab button **RIFE Recohere** near RIFE / Image Sort if tabs are listed there  

Use existing job progress / run-button timer patterns (`job-control.js`). No new frameworks.

---

## PHASE 3 — DOCS / VERSION

On ship:

1. Bump root `VERSION` far-right **DD**  
2. `docs/STATUS.md` — move recoherence to **Shipped**; note VERSION  
3. Spec banner → **Implemented** + code paths  
4. Root `AGENTS.md` operation registry row  
5. `docs/README.md` — status line if it lists the spec  

---

## PHASE 4 — VERIFY (mandatory)

```bash
# assets
test -f /tmp/teste.png || ffmpeg -y -f lavfi -i "testsrc=duration=1:size=320x240:rate=1" -vframes 1 /tmp/teste.png
ffmpeg -y -f lavfi -i "color=c=blue:s=320x240:d=1" -vframes 1 /tmp/teste_b.png

cd mtapi-project && .venv/bin/python run.py   # :24590
```

1. WebUI open `http://localhost:24590/`  
2. Tab **RIFE Recohere** renders; no JS console errors  
3. Dry run A/B paths  
4. Full run → `ok: true`, short mp4 exists  
5. Optional stills flag once  

**You may not claim DONE without WebUI verification** (root AGENTS §D). Curl-only is insufficient for the tab.

If FastSD/GPU is unavailable in the environment, still:

- Prove dry_run + form + register  
- Prove backend fails with a **clear** FastSD error on full run  
- Note that full img2img path was blocked by env in the ship note  

Prefer a real GPU run when the machine has FastSD.

---

## ANTI-PATTERNS (do not)

- New `filters/recoherence.py` for v1  
- Bare `000001.png` without `frame_` prefix  
- Exposing RIFE multiplier (fixed 2)  
- Reimplementing RIFE or img2img inside the op file  
- `shell=True` / stringy subprocess  
- Claiming DONE from OpenAPI alone  
- Integrating into Image Sort in this ticket  

---

## DONE means

- [ ] `POST /ops/rife_recohere` works  
- [ ] Tab works with defaults + knobs  
- [ ] Progress phases show  
- [ ] VERSION + STATUS + spec banner updated  
- [ ] WebUI smoke with `/tmp/teste.png` + `/tmp/teste_b.png`  
- [ ] Commit message clear (push only if human asked)

**Spec wins on conflict with this prompt.** If the tree’s img2img API differs slightly from the outline, follow the **code** and the **spec invariants**, not outdated pseudo-code lines.
