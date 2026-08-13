# QR Art Generator - Technical Specification

**Target:** `ffTransmuteWebui` Integration
**Hardware:** Intel Core i5-1335U / Iris Xe 80EU / 16GB RAM / OpenVINO

## 1. Product Overview
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
