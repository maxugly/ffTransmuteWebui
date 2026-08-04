# FastSD CPU Upscalers — Research Notes

> **Status:** **Research** — not an mtapi op (`STATUS.md` §5)  
> **Source project:** [rupeshs/fastsdcpu](https://github.com/rupeshs/fastsdcpu)  
> **Audience:** Spec writers & builders choosing upscale stacks for Intel CPU / iGPU  
> **Related:** `STATUS.md`, `backlog/upscale-spec.md`, `backlog/sd-tiled-upscale-spec.md` (legacy), **`tilagup-mtapi-mode-spec.md`**, `backlog/swinir-spec.md`  
> **Sibling:** `/home/m/snc/cod/tilagup` — multi-step agent grid, not a checkbox  
> **Not this:** A full FastSD port.

---

## 1. Why this note exists

FastSD CPU is a **CPU / AI-PC oriented** Stable Diffusion stack (LCM, OpenVINO, distilled models). Base gens are often small (e.g. 512²), so the project grew several **post- or mid-pipeline size boosts**.

This doc:

1. Lists the upscale-related techniques FastSD actually ships or documents.  
2. Separates real **upscalers** from things people confuse with them (especially **TAESD**).  
3. Compares cost / quality / risk for **our** hardware lane (Intel Iris Xe, ~16 GB RAM, filter-platform PNG chain).  
4. Recommends what to adopt vs ignore for mtapi.

---

## 2. Quick map

| Technique | Is it an upscaler? | Scale (typical) | Adds new detail? | Cost | FastSD role |
|-----------|--------------------|-----------------|------------------|------|-------------|
| **Lanczos / classic resample** | Yes (dumb) | any | No — stretches pixels | Instant | Baseline resize (Pillow/OpenCV class) |
| **EDSR 2× (ONNX)** | Yes (SISR net) | **2×** | Mild — learned SR | Low–med | Default “AI 2×” in FastSD |
| **AuraSR / GigaGAN-class** | Yes (SISR) | **4×** (v1/v2 in FastSD changelog) | Stronger SR | Med | Later FastSD addition |
| **Tiled SD upscale** | Yes (diffusion img2img) | 2×+ (configurable) | Yes — can **rewrite** content | High | Experimental; monstruosoft path |
| **TAESD** | **No** (tiny VAE decoder) | n/a | No | Low (saves decode cost) | Speed/memory for generation |

---

## 3. Techniques (accurate, not brochure)

### 3.1 Classic resample (Lanczos / bicubic / …)

| | |
|--|--|
| **Type** | Non-ML interpolation |
| **Mechanism** | Reconstruct samples from a local window (Lanczos uses a windowed sinc). No training data. |
| **HW** | CPU; trivial. Not an OpenVINO story. |
| **Pros** | Free, deterministic, no model files. |
| **Cons** | Soft or ringing; **no** invented texture. |
| **Use** | Pre-size before a heavy pass; “I only need pixels bigger.” |

**mtapi:** Already available via ffmpeg/Pillow anywhere. Do not invent a FastSD dependency for this.

---

### 3.2 EDSR 2× (ONNX → often OpenVINO EP)

| | |
|--|--|
| **Type** | Single-image super-resolution CNN |
| **Mechanism** | Residual net (EDSR family) trained to invent plausible high-frequency detail. FastSD ships / uses a **2×** ONNX path. |
| **HW** | ONNX Runtime; OpenVINO execution provider on Intel CPU / iGPU when configured. |
| **Pros** | Real SR quality jump vs Lanczos; still far cheaper than diffusion tiles. Good “default AI 2×.” |
| **Cons** | Fixed scale (2× in FastSD). Can smooth or “plastic” some textures. Separate model weight to ship. |
| **Use** | 512→1024-class boost after LCM/SD gen; batch-friendly. |

**mtapi note:** Overlaps **conceptually** with `upscale-spec.md` Real-ESRGAN NCNN. Prefer **one** SISR stack for production (NCNN Vulkan is already the project’s stated preference for Real-ESRGAN/SRMD on Iris Xe). EDSR/OpenVINO is only interesting if we standardize on OpenVINO for *all* AI and refuse NCNN.

---

### 3.3 AuraSR (GigaGAN-based) 4×

| | |
|--|--|
| **Type** | Generative SR (GigaGAN lineage) |
| **Mechanism** | Stronger upscaler than classic EDSR; FastSD changelog lists **Aura SR (4×)** and **Aura SR v2**. |
| **HW** | Depends on FastSD’s integration (heavier than EDSR 2×). |
| **Pros** | Larger scale factor; more “wow” than 2× EDSR on some content. |
| **Cons** | More weights / RAM; quality varies; still not diffusion control. |
| **Use** | When 2× is not enough and diffusion tile cost is too high. |

**mtapi note:** Evaluate only after NCNN Real-ESRGAN path exists; don’t double-ship two 4× SISR stacks without a bake-off.

---

### 3.4 Tiled SD upscale (experimental)

| | |
|--|--|
| **Type** | Diffusion **img2img** over a grid of tiles |
| **Mechanism** | Resize canvas (e.g. 2×), split into overlapping tiles, run LCM/SD (or image-variation) per tile at moderate **strength** (~0.1–0.35 default family; higher rewrites more), blend/stitch. Optional **custom tiles** (face region, higher local scale, optional prompt) via JSON in the monstruosoft-style design. |
| **HW** | Same as the gen pipeline (OpenVINO / LCM). Multiplies cost by tile count. |
| **Pros** | Can add **semantic** detail (skin, fabric, faces) that pure SR never invents. Tiling keeps peak memory bounded. |
| **Cons** | Slow. Seams if overlap/strength wrong. Prompt/strength drift **changes composition**. Experimental label is deserved. |
| **Use** | Hero stills; final polish after composition is locked at low res. |

**Custom tile knobs (reference from FastSD discussion / monstruosoft):**

| Field | Role |
|-------|------|
| `tile_size` | Source-side tile edge (e.g. 256) |
| `tile_overlap` | Seam blend (e.g. 16; OpenVINO paths sometimes use larger) |
| `scale_factor` | Global upscale (2.0 default) |
| `strength` | Denoise / rewrite amount |
| `tiles[]` | Optional local regions: `x,y,w,h`, local `scale_factor`, optional `prompt` |

**mtapi note:** This is the same *idea* as `sd-tiled-upscale-spec.md`, not EDSR. Implement once under the **filter platform** (still → tiles → encode bookends as needed). Do **not** pull FastSD’s app as a subprocess if we already own OpenVINO img2img.

---

### 3.5 TAESD — not an upscaler

| | |
|--|--|
| **Type** | **Tiny AutoEncoder for SD** — small VAE **decoder** (and related encode path) |
| **What FastSD uses it for** | Faster / cheaper latent→pixel decode (~memory savings on the order of **~2 GB** in OpenVINO mode in their docs; ~1.4× speed claims). |
| **What it is not** | A general “make image 2× larger” tool. Confusing TAESD with latent upscaling is a common AI-brochure mistake. |
| **Pros** | Faster previews; lower RAM during **generation**. |
| **Cons** | Moderate decode quality vs full VAE; wrong layer if the user asked for upscale. |
| **Use** | Generation settings, not the Upscale tab. |

If a pipeline does **latent-space resize + refine**, that is a **separate** technique (latent upscale + second denoise). Document it under diffusion ops if we ever ship it — **do not** label TAESD as that feature.

---

## 4. Comparison matrix (decision aid)

| Goal | Prefer | Avoid |
|------|--------|--------|
| Just larger pixels, free | Lanczos / ffmpeg scale | Loading EDSR/SD |
| Clean 2× SR, still cheap | EDSR **or** Real-ESRGAN 2×/4× | Tiled SD |
| Film grain preserved | SRMD (our `upscale-spec`) | Aggressive ESRGAN + no re-grain |
| New invented texture / faces | Tiled SD / img2img | EDSR alone |
| CPU-only laptop, many stills | EDSR / NCNN SISR | Full tiled SD batch |
| Peak quality, few stills, time OK | Tiled SD (low strength) then optional SISR | High strength without review |
| Faster SD **generation** | TAESD decode | Calling TAESD “upscale” |

**Speed order of magnitude (relative, Intel laptop class):**

```text
Lanczos  <<  EDSR/NCNN SISR  <<  AuraSR-class  <<  Tiled SD (many tiles)
```

---

## 5. Hardware (Intel lane)

| Device | Notes |
|--------|--------|
| **CPU** | All methods work; EDSR ONNX and diffusion tiles will pin cores. |
| **Iris Xe / iGPU** | OpenVINO EP or NCNN Vulkan — **pick one stack per op**, don’t thrash both in one job. |
| **RAM ~16 GB** | Sweet spot for *output* canvas still roughly **~1024²** class for heavy models; tiled diffusion helps peak, not total wall time. |
| **NPU** | Only if the chosen runtime explicitly supports it; do not assume FastSD’s marketing equals our bindings. |

Project invariant: absolute paths, `create_subprocess_exec` / no `shell=True`, progress per tile/frame when loops exist.

---

## 6. What we should do in mtapi

| Priority | Action | Spec to follow |
|----------|--------|----------------|
| **P0** | Ship **NCNN** Real-ESRGAN (+ optional SRMD + re-grain) as `upscale` | `backlog/upscale-spec.md` |
| **P1** | Optional **SwinIR** denoise/deblur (not SR) | `backlog/swinir-spec.md` |
| **P1–P2** | **Tilagup mode** — multi-step agent tiled SD (dry-run, edit prompts, FastSD/OpenVINO engine) | `tilagup-mtapi-mode-spec.md` |
| **P2** | Bare **Tiled SD** without agents (engine only) | Superseded in product by tilagup mode; see backlog note |
| **Skip** | Port FastSD app wholesale; treat TAESD as upscaler; ship EDSR **and** Real-ESRGAN without bake-off |
| **Maybe later** | AuraSR bake-off vs Real-ESRGAN 4× if quality gap is large on our stills |

**Filter-platform shape** for any new op:

```text
stills or dump → stage (per_frame or directory) → encode if video
```

No second dump/encode stack inside the upscale op.

---

## 7. UI copy hints (if/when we expose multiple engines)

Short legends only next to knobs; long text in **bottom `.tool-docs`** (see `tool-bottom-docs-spec.md`):

- **Lanczos** — “Bigger pixels, no new detail.”  
- **Real-ESRGAN / EDSR** — “AI sharpen/detail; can look plastic; no prompt.”  
- **SRMD** — “Upscale with noise control; good for film sources.”  
- **Tiled SD** — “Re-draws tiles with the model; slow; can change content; watch seams.”  
- **TAESD** — belongs under generation quality/speed, **not** Upscale.

---

## 8. Non-goals

- Tracking every FastSD release feature forever.  
- Guaranteeing parity with FastSD’s WebUI.  
- Claiming OpenVINO EDSR is “highly optimized for all Intel GPUs” without measuring on *this* machine.  
- Embedding marketing claims (“masterpiece renders”) as acceptance criteria.

---

## 9. Sources / anchors

- FastSD CPU README / changelog: EDSR + tiled SD 2× upscale; ONNX EDSR; Aura SR / v2; TAESD for decode speed & RAM.  
- monstruosoft / discussion #127: tiled upscale settings (`tile_size`, `overlap`, `scale_factor`, `strength`, custom face tiles).  
- This repo backlog: NCNN upscale, SD tiled, SwinIR.

Re-check upstream changelog before implementing AuraSR or EDSR specifically — versions move.

---

## 10. Verification (when an op is built)

Not required for this research doc alone.

When implementing:

1. Still `/tmp/teste.png` → 2× → file larger, `ok: true`.  
2. Video path (if claimed): short clip, progress phases (`upscale` / `encode`).  
3. Tiled SD: low strength preserves layout; high strength visibly rewrites (document as expected).  
4. WebUI form + no console errors (project rule).

**DONE for this file** = accurate research + clear adopt/skip table (no code).
