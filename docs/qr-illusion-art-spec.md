# QR Art + Illusion

> **Status:** **QR Implemented** (`5.04`–`5.05`). **Illusion Implemented (v1)** (`7.009`).  
> **Audience:** Builder assigned this job.  
> **Code (QR + Illusion, shipped):** `qr_ops.py`, `qr_art_ov_worker.py`, `js/tabs/qr.js`  
> **Related:** `filter-platform-spec.md` (bookends only — this is a generate op, not a video stage)

The filename promised “QR **or** custom pattern.” The body below (from §1) is **QR only** and matches shipped code. Illusion is **§0**. §0 wins if they disagree.

---

## 0. Illusion mode — locked for the builder

HF **Illusion Diffusion** cousin: your **monochrome / high-contrast pattern** is structure; a **second still** is appearance. No QR payload. No generated barcode. No scan badge.

Same ControlNet (`monster-labs/control_v1p_sd15_qrcode_monster`) + optional IP-Adapter already in the worker. Do **not** add a second op or a second worker file.

### 0.1 Product

| Slot | What | Required |
|------|------|----------|
| **Pattern** | User still. ControlNet + img2img init for structure (the “mono” map) | Yes |
| **Appearance** | User still. IP-Adapter look (the image that modulates onto the pattern) | Yes for v1 |
| **Prompt** | Optional. Empty → worker uses a fixed fallback `"high quality, detailed"` so SD has text tokens. Appearance still comes from the photo. | No |
| **QR Data** | Hidden / ignored in this mode | No |

Mode is one field: `mode: "qr" | "illusion"`. Default `"qr"` — existing clients unchanged.

### 0.2 Device (honest — do not oversell)

This box is a 1335U / Iris Xe / 16GB machine. What is **true in code today**:

| Path | Engine | Device |
|------|--------|--------|
| QR, no IP-Adapter | `OVStableDiffusionImg2ImgPipeline` (FastSD env) | OpenVINO **GPU** (iGPU) |
| QR + IP-Adapter | PyTorch `StableDiffusionControlNetImg2ImgPipeline` | `cuda` if `torch.cuda.is_available()`, else **CPU** |

Iris Xe is **not** CUDA. Dual-conditioning (ControlNet + IP-Adapter) is therefore **CPU** on this desk unless the FastSD env already has Intel **XPU / IPEX**. The worker does **not** currently try XPU.

**Vulkan:** NCNN Vulkan in this repo is RIFE / Real-ESRGAN only. There is no SD ControlNet on Vulkan. **Out of scope.** Do not add `stable-diffusion.cpp` or a second stack.

**Locked device policy for Illusion v1**

1. **Reuse the shipped IP-Adapter worker path.** Same FastSD python, same models, same 512×512 cap, same VAE slicing, same GPU→CPU OOM fallback strings. Illusion is `control_image = pattern` instead of a generated QR.
2. **Try Intel XPU before CPU** when `torch.cuda` is false: `hasattr(torch, "xpu") and torch.xpu.is_available()` → `pipe.to("xpu")`. If that import/move fails, CPU + one log line. Do not invent a third backend.
3. **Do not** claim OpenVINO iGPU for ControlNet+IP-Adapter in v1. The original QR spec asked for it; the ship punted to PyTorch because OV + IP-Adapter would not load. Do not reopen that in this pass.
4. **Phase 2 (only if v1 is clean, separate commit):** OpenVINO ControlNet img2img — `OVStableDiffusionControlNetPipeline` if FastSD/optimum has it — **pattern = control**, **appearance = init image**, **no IP-Adapter**. That can use `DEVICE=GPU`. If `from_pretrained` fails: leave Phase 2 Partial, keep v1. Do not spend a week on OV IP-Adapter.

### 0.3 API (`QrArtParams` — extend, do not fork)

| Field | Illusion | QR (unchanged) |
|-------|----------|----------------|
| `mode` | `"illusion"` | `"qr"` (default) |
| `qr_text` | optional / ignored | required |
| `pattern_image` | required absolute path | unused |
| `ip_adapter_image` | required (appearance) | optional if `use_ip_adapter` |
| `use_ip_adapter` | **forced true** in v1 | user checkbox |
| `prompt` | optional (fallback string in worker) | required |
| knobs | same steps / guidance / strength / ctrl / ip scale | same |

`collectQrBody`: if mode is illusion, do **not** alert on empty QR Data. Alert if pattern or appearance path missing. Prefer Image Pool / global `#giImage` lines (first = pattern, second = appearance) when the dedicated fields are blank.

### 0.4 Worker

- Do not generate a QR. Copy/resize pattern to 512×512 (`NEAREST` or `LANCZOS`). Optional: convert to L then RGB so Monster sees contrast; do not dither or invent a QR.
- Existing job key `qr_image_path` may stay as the control/init path (less churn) **or** rename to `control_image_path` with a fallback read of `qr_image_path`. One name in the worker is enough.
- Skip `pyzbar` in illusion mode. No scannability badge.
- Progress / `latest_frame` / `OperationResult` same as QR.

### 0.5 UI (same QR tab)

- Mode control: **QR** | **Illusion** (binary knob or two radio buttons — vanilla, no new framework).
- Illusion: show Pattern + Appearance path rows (Browse). Hide QR Data. Hide scan badge.
- Hint one line: “Pattern = structure (mono works best). Appearance = the photo woven through it.”
- No page essay. Bottom `.tool-docs` may add a short Illusion paragraph.

### 0.6 Files

| File | Change |
|------|--------|
| `qr_ops.py` | `mode`, `pattern_image`; `qr_text` not required when illusion; skip `qrcode` generate |
| `qr_art_ov_worker.py` | Accept empty prompt fallback; XPU try; control image from pattern |
| `js/tabs/qr.js` | Mode UI; collect body; no QR Data alert in illusion |
| This spec | Banner → Partial until Illusion ships |
| `docs/STATUS.md` | §4 or shipped row on ship |
| `VERSION` | Far-right DD on ship |

Do **not** touch FastSAM, filter-platform dump/encode, or add `illusion_ops.py`.

### 0.7 Verify

1. QR mode still requires QR Data and still writes a scannable-or-badge PNG.  
2. Illusion: two stills (`/tmp/teste.png` + a second PNG), empty QR Data, empty prompt → `ok`, output PNG exists, no `qrcode` in the log.  
3. Playwright: switch to Illusion, Run, no “QR Data is required” alert.  
4. Log one line for device: `xpu` / `cuda` / `cpu`.  
5. Weights stay under `mtapi-project/junk/models/` or HF cache. Never commit `.safetensors`.

### 0.8 Out of scope

Vulkan SD. Second worker. Multi-IP-Adapter (3+ refs). Making prompt-less mean “no CLIP text encoder.” OV+IP-Adapter in v1.

---

## 1. Product Overview (QR — shipped)

The QR Art Generator blends a standard scannable QR code with a user-provided prompt using Stable Diffusion 1.5 and ControlNet (QR Monster) optimized for OpenVINO iGPU inference. It also supports IP-Adapter image prompting (h94/IP-Adapter base model) to let the user drop ANY reference image (photo of rust, wood, concrete, product, texture) and have the QR art take on the look of that image while remaining scannable.

Unlike the previous standalone Gradio draft, this implementation must be fully integrated into the existing `ffTransmuteWebui` architecture (Vanilla JS/HTML frontend, FastAPI backend, Job Queue, and the `junk/` directory rule).

## 2. Architectural Invariants
- **No Gradio/External UI:** The UI must be a new tab in `app/static/` (e.g., `app/static/js/tabs/qr.js`), matching the existing Vanilla JS structure.
- **Backend Operation:** Must be implemented as a standard operation (`app/operations/qr_ops.py`) that returns an `OperationResult`. It must be registered in the API just like `txt2img_ops.py` and `img2img_ops.py`.
- **Model Storage:** All downloaded model weights, OpenVINO IR cache, and intermediate generations MUST be stored in `mtapi-project/junk/` (e.g., `mtapi-project/junk/models/ov_cache`). **Never** pollute the root or `app/` directories.
- **Async & Progress:** The generation must report progress via `job_control.report_progress()` so the WebUI progress bar updates during inference.

## 3. Implementation Plan

### A. Backend (`mtapi-project/app/`)
1. **QR Generation & Validation (`app/filters/qr_worker.py` or similar):**
   - Use `qrcode` to generate the base QR image from the user's text (Error Correction: H).
   - Implement OpenVINO inference using `optimum-intel` (`OVStableDiffusionControlNetPipeline`).
   - Load IP-Adapter (`h94/IP-Adapter` base `ip-adapter_sd15` model, ~22MB) via `pipe.load_ip_adapter()`. Pre-load the CLIP vision encoder once at startup and cache it. Do NOT recompile the base UNet; only load adapter weights. Keep everything OpenVINO compatible (fallback to CPU for IP-Adapter if it can't compile to GPU on 1335U, while UNet stays on GPU).
   - Support TWO conditionings simultaneously: ControlNet QR Monster = STRUCTURE, IP-Adapter = APPEARANCE.
   - Use INT8 quantized models if possible for 16GB RAM limits. VAE slicing must stay on. Peak RAM must remain <12GB at 512x512 on 1335U.
   - Ensure `bad allocation` or `clWaitForEvents` OpenVINO errors gracefully fallback to CPU if the iGPU gets overwhelmed. Memory limit: Enforce 512x512 max resolution when IP-Adapter is active. Show warning if user tries 768.
   - Use `pyzbar` to validate the scannability of the output image. If it fails, log a warning but still return the image.

2. **Operation Registry (`app/operations/qr_ops.py`):**
   - Define a Pydantic model `QrArtParams` (prompt, negative_prompt, qr_text, steps, guidance_scale, controlnet_scale, seed, use_ip_adapter, ip_adapter_image, ip_adapter_scale).
   - Create `def handle_qr_art(job_id, params: QrArtParams, workspace)` that orchestrates the QR generation, diffuses it, checks scannability, and saves the final PNG to `workspace.frames_out`.
   - Register the endpoint in `pipeline_ops.py` or `__init__.py`.

### B. Frontend (`mtapi-project/app/static/`)
1. **UI Tab (`js/tabs/qr.js`):**
   - Create the HTML layout injecting into `elements.actionPanel`.
   - **Inputs:** QR Data (URL/Text), Positive Prompt, Negative Prompt, Seed.
   - **IP-Adapter Inputs (Optional):** New section "Reference Image (IP-Adapter)". Includes Image upload box, a checkbox "Use IP-Adapter", and Tip text: "Drop any texture/photo here. Low scale = subtle style, High scale = clone the photo". If no image uploaded/checkbox unchecked, pipeline works exactly like text-only mode.
   - **Sliders/Knobs:** Steps (20-40), Guidance Scale (5-15), ControlNet Scale (0.6-1.6, default 1.1), IP-Adapter Scale (0.0 to 1.0, default 0.5).
   - Use the existing `setupContinuousKnob` and `setupBinaryKnob` systems.
2. **Job Control (`js/job-control.js` & `app.js`):**
   - Register the `qr` tab so it can be selected.
   - Implement `collectQrBody()` to gather the form state.
   - When the job completes, display a Scannability badge (Green = Scannable, Red = Failed to Scan) in the UI alongside the generated image.

## 4. Dependencies
Add to the main `requirements.txt` (do not create a separate one):
- `qrcode[pil]`
- `pyzbar`
- `optimum[openvino]`
- `diffusers`
