#!/usr/bin/env python3
"""OpenVINO QR Art worker — run under FastSD's Python.

Usage:
  DEVICE=gpu /path/to/fastsd/env/bin/python qr_art_ov_worker.py --job /tmp/job.json

Job JSON:
  {
    "output_path": "/abs/qr_art.png",
    "prompt": "...",
    "negative_prompt": "",
    "qr_image_path": "/abs/qr_base.png",
    "steps": 30,
    "guidance_scale": 9.0,
    "strength": 0.35,
    "model_id": "rupeshs/sd-turbo-openvino",
    "device": "GPU",
    "seed": null,

    # IP-Adapter fields (optional):
    "use_ip_adapter": true,
    "ip_adapter_image_path": "/abs/ref.png",
    "ip_adapter_scale": 0.7,
    "controlnet_id": "monster-labs/control_v1p_sd15_qrcode_monster",
    "controlnet_scale": 1.1,
    "ip_adapter_id": "h94/IP-Adapter",
    "ip_adapter_weight": "ip-adapter_sd15.safetensors",
    "ov_cache_dir": "./models/ov_cache",
    "resolution": 512
  }

Modes:
  - Text-only (use_ip_adapter=false): OVStableDiffusionImg2ImgPipeline,
    QR code as init image. Fast on iGPU.
  - IP-Adapter (use_ip_adapter=true): PyTorch
    StableDiffusionControlNetImg2ImgPipeline with:
      * ControlNet QR Monster  → structure (QR dots)
      * IP-Adapter ip-adapter_sd15 → appearance (reference image)
    VAE slicing ON. 512x512 enforced. GPU→CPU fallback on OOM.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="OpenVINO QR Art worker")
    ap.add_argument("--job", required=True)
    args = ap.parse_args()

    job_path = Path(args.job)
    if not job_path.is_file():
        print(f"ERROR: job file not found: {job_path}", file=sys.stderr)
        return 2

    job = json.loads(job_path.read_text(encoding="utf-8"))
    output_path = Path(job.get("output_path"))
    if not output_path:
        print("ERROR: no output_path in job", file=sys.stderr)
        return 2

    qr_image_path = job.get("qr_image_path")
    if not qr_image_path:
        print("ERROR: no qr_image_path in job", file=sys.stderr)
        return 2

    prompt = (job.get("prompt") or "").strip()
    negative = job.get("negative_prompt") or ""
    steps = max(1, int(job.get("steps") or 30))
    guidance = float(job.get("guidance_scale") or 9.0)
    strength = float(job.get("strength") or 0.35)
    model_id = job.get("model_id") or "rupeshs/sd-turbo-openvino"
    device = (job.get("device") or "GPU").upper()
    seed = job.get("seed")
    resolution = int(job.get("resolution") or 512)

    use_ip_adapter = bool(job.get("use_ip_adapter", False))
    ip_adapter_image_path = job.get("ip_adapter_image_path") or ""
    ip_adapter_scale = float(job.get("ip_adapter_scale") or 0.5)
    controlnet_id = job.get("controlnet_id") or "monster-labs/control_v1p_sd15_qrcode_monster"
    controlnet_scale = float(job.get("controlnet_scale") or 1.1)
    ip_adapter_id = job.get("ip_adapter_id") or "h94/IP-Adapter"
    ip_adapter_weight = job.get("ip_adapter_weight") or "ip-adapter_sd15.safetensors"

    if use_ip_adapter:
        return _run_ip_adapter_mode(
            output_path=output_path,
            qr_image_path=qr_image_path,
            ip_adapter_image_path=ip_adapter_image_path,
            prompt=prompt,
            negative=negative,
            steps=steps,
            guidance=guidance,
            strength=strength,
            model_id=model_id,
            device=device,
            seed=seed,
            resolution=resolution,
            ip_adapter_scale=ip_adapter_scale,
            controlnet_id=controlnet_id,
            controlnet_scale=controlnet_scale,
            ip_adapter_id=ip_adapter_id,
            ip_adapter_weight=ip_adapter_weight,
        )
    else:
        return _run_ov_img2img_mode(
            output_path=output_path,
            qr_image_path=qr_image_path,
            prompt=prompt,
            negative=negative,
            steps=steps,
            guidance=guidance,
            strength=strength,
            model_id=model_id,
            device=device,
            seed=seed,
            resolution=resolution,
        )


def _run_ov_img2img_mode(*, output_path, qr_image_path, prompt, negative,
                           steps, guidance, strength, model_id, device, seed,
                           resolution) -> int:
    """Text-only mode: OpenVINO img2img with QR as init image."""
    print(
        f"LOAD (OV) qr_image={qr_image_path} model={model_id} "
        f"device={device} steps={steps} strength={strength} res={resolution}",
        flush=True,
    )

    try:
        from PIL import Image
        qr_image = Image.open(qr_image_path).convert("RGB")
    except Exception as e:
        print(f"ERROR: failed to load QR image: {e}", file=sys.stderr)
        return 3

    try:
        from optimum.intel.openvino import OVStableDiffusionImg2ImgPipeline
    except ImportError as e:
        print(
            f"ERROR: OpenVINO/optimum not available: {e}\n"
            "Run with FastSD env/bin/python.",
            file=sys.stderr,
        )
        return 3

    try:
        pipe = OVStableDiffusionImg2ImgPipeline.from_pretrained(
            model_id,
            ov_config={"CACHE_DIR": ""},
            device=device,
            safety_checker=None,
            feature_extractor=None,
        )
    except Exception as e:
        print(f"ERROR: failed to load pipeline: {e}", file=sys.stderr)
        return 4

    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    else:
        seed = int(seed)

    try:
        result = pipe(
            prompt=prompt,
            negative_prompt=negative,
            num_inference_steps=steps,
            guidance_scale=guidance,
            image=qr_image,
            strength=strength,
            num_images_per_prompt=1,
        )
        im = result.images[0]
        output_path.parent.mkdir(parents=True, exist_ok=True)
        im.save(str(output_path), format="PNG")
    except Exception as e:
        print(f"ERROR: generation failed: {e}", file=sys.stderr)
        return 6

    print(f"DONE seed={seed}", flush=True)
    return 0


def _run_ip_adapter_mode(
    *, output_path, qr_image_path, ip_adapter_image_path, prompt, negative,
    steps, guidance, strength, model_id, device, seed, resolution,
    ip_adapter_scale, controlnet_id, controlnet_scale,
    ip_adapter_id, ip_adapter_weight,
) -> int:
    """IP-Adapter mode: PyTorch StableDiffusionControlNetImg2ImgPipeline.

    Dual conditioning:
      - ControlNet QR Monster  → structure (QR dots)
      - IP-Adapter ip-adapter_sd15 → appearance (reference image)

    Falls back GPU→CPU on 'bad allocation' / 'clWaitForEvents'.
    """
    if not ip_adapter_image_path:
        print("ERROR: use_ip_adapter is true but no ip_adapter_image_path provided", file=sys.stderr)
        return 7

    # OpenVINO models are incompatible with the PyTorch ControlNet pipeline.
    # Force a PyTorch SD 1.5 model when IP-Adapter is active.
    is_ov_model = "openvino" in model_id.lower()
    if is_ov_model:
        torch_model_id = "runwayml/stable-diffusion-v1-5"
        print(f"WARNING: model '{model_id}' is OpenVINO; IP-Adapter requires PyTorch — "
              f"using '{torch_model_id}' instead", flush=True)
    else:
        torch_model_id = model_id

    print(
        f"LOAD (ControlNet+IP-Adapter) qr_image={qr_image_path} "
        f"ip_ref={ip_adapter_image_path} base_model={torch_model_id} "
        f"controlnet={controlnet_id} device={device} "
        f"steps={steps} strength={strength} res={resolution} "
        f"ip_scale={ip_adapter_scale} ctrl_scale={controlnet_scale}",
        flush=True,
    )

    try:
        from PIL import Image
        qr_image = Image.open(qr_image_path).convert("RGB").resize((resolution, resolution), Image.NEAREST)
        ip_image = Image.open(ip_adapter_image_path).convert("RGB").resize((224, 224), Image.BICUBIC)
    except Exception as e:
        print(f"ERROR: failed to load images: {e}", file=sys.stderr)
        return 3

    try:
        import torch
        from diffusers import (
            StableDiffusionControlNetImg2ImgPipeline,
            ControlNetModel,
        )
    except ImportError as e:
        print(f"ERROR: diffusers/torch not available: {e}", file=sys.stderr)
        return 3

    torch_device = "cpu"
    if device != "CPU":
        # Try GPU first (may be Intel iGPU via IPEX or CUDA)
        if torch.cuda.is_available():
            torch_device = "cuda"
        else:
            torch_device = "cpu"

    try:
        controlnet = ControlNetModel.from_pretrained(
            controlnet_id,
            torch_dtype=torch.float32,
        )
    except Exception as e:
        print(f"ERROR: failed to load ControlNet: {e}", file=sys.stderr)
        return 4

    try:
        pipe = StableDiffusionControlNetImg2ImgPipeline.from_pretrained(
            torch_model_id,
            controlnet=controlnet,
            torch_dtype=torch.float32,
            safety_checker=None,
        )
    except Exception as e:
        print(f"ERROR: failed to load ControlNet pipeline: {e}", file=sys.stderr)
        return 4

    # VAE slicing must remain ON (memory constraint on 1335U)
    pipe.enable_vae_slicing()

    # Pre-load + cache IP-Adapter (CLIP vision encoder + adapter weights).
    # Do NOT recompile the base UNET — IP-Adapter only injects cross-attention
    # weights via attention processors on the existing UNET.
    try:
        pipe.load_ip_adapter(
            ip_adapter_id,
            subfolder="models",
            weight_name=ip_adapter_weight,
            torch_device=torch_device,
        )
        pipe.set_ip_adapter_scale(ip_adapter_scale)
    except Exception as e:
        print(f"ERROR: failed to load IP-Adapter: {e}", file=sys.stderr)
        return 5

    pipe = pipe.to(torch_device)

    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    else:
        seed = int(seed)

    print(f"PROGRESS 0/{steps}", flush=True)

    generator = torch.Generator(device=torch_device).manual_seed(seed)

    try:
        cur_step = [0]

        def _callback(step, timestep, latents):
            cur_step[0] = step + 1
            print(f"PROGRESS {cur_step[0]}/{steps}", flush=True)

        result = pipe(
            prompt=prompt,
            negative_prompt=negative,
            image=qr_image,
            control_image=qr_image,
            strength=strength,
            num_inference_steps=steps,
            guidance_scale=guidance,
            controlnet_conditioning_scale=controlnet_scale,
            ip_adapter_image=ip_image,
            generator=generator,
            num_images_per_prompt=1,
            callback=_callback,
            callback_steps=1,
        )
        im = result.images[0]
        output_path.parent.mkdir(parents=True, exist_ok=True)
        im.save(str(output_path), format="PNG")
    except RuntimeError as e:
        low = str(e).lower()
        if torch_device != "cpu" and any(t in low for t in ["bad allocation", "clwaitforevents", "out of memory", "cuda error"]):
            print(f"WARNING: GPU OOM — falling back to CPU: {e}", file=sys.stderr)
            torch_device = "cpu"
            # Clear GPU cache
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            try:
                pipe = pipe.to("cpu")
                generator = torch.Generator(device="cpu").manual_seed(seed)
                result = pipe(
                    prompt=prompt,
                    negative_prompt=negative,
                    image=qr_image,
                    control_image=qr_image,
                    strength=strength,
                    num_inference_steps=steps,
                    guidance_scale=guidance,
                    controlnet_conditioning_scale=controlnet_scale,
                    ip_adapter_image=ip_image,
                    generator=generator,
                    num_images_per_prompt=1,
                )
                im = result.images[0]
                output_path.parent.mkdir(parents=True, exist_ok=True)
                im.save(str(output_path), format="PNG")
            except Exception as e2:
                print(f"ERROR: CPU fallback also failed: {e2}", file=sys.stderr)
                return 6
        else:
            print(f"ERROR: generation failed: {e}", file=sys.stderr)
            return 6
    except Exception as e:
        print(f"ERROR: generation failed: {e}", file=sys.stderr)
        return 6

    print(f"DONE seed={seed}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
