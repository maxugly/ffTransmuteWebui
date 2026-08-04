#!/usr/bin/env python3
"""OpenVINO img2img worker — run under FastSD's Python (has optimum-intel).

Loads OVStableDiffusionImg2ImgPipeline once, processes a list of in/out pairs.
Invoked by app.filters.img2img (mtapi) as a subprocess.

Usage:
  DEVICE=gpu /path/to/fastsd/env/bin/python img2img_ov_worker.py --job /tmp/job.json

Job JSON:
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

Prints PROGRESS i/N lines to stdout for the parent.
"""
from __future__ import annotations

import argparse
import json
import sys
from math import ceil
from pathlib import Path


def _even8(n: int) -> int:
    n = max(8, int(n))
    return n - (n % 8)


def _prepare_image(im, max_side: int = 0):
    """RGB, optional long-side cap, dimensions multiple of 8."""
    from PIL import Image

    im = im.convert("RGB")
    w, h = im.size
    if max_side and max(w, h) > max_side:
        scale = max_side / float(max(w, h))
        w = max(8, int(round(w * scale)))
        h = max(8, int(round(h * scale)))
        im = im.resize((w, h), Image.Resampling.LANCZOS)
        w, h = im.size
    w8, h8 = _even8(w), _even8(h)
    if (w8, h8) != (w, h):
        # center-crop to multiple of 8
        left = (w - w8) // 2
        top = (h - h8) // 2
        im = im.crop((left, top, left + w8, top + h8))
    return im


def main() -> int:
    ap = argparse.ArgumentParser(description="OpenVINO img2img batch worker")
    ap.add_argument("--job", required=True, help="Path to job JSON")
    args = ap.parse_args()

    job_path = Path(args.job)
    if not job_path.is_file():
        print(f"ERROR: job file not found: {job_path}", file=sys.stderr)
        return 2

    job = json.loads(job_path.read_text(encoding="utf-8"))
    pairs = job.get("pairs") or []
    if not pairs:
        print("ERROR: no pairs in job", file=sys.stderr)
        return 2

    prompt = (job.get("prompt") or "").strip()
    if not prompt:
        print("ERROR: empty prompt", file=sys.stderr)
        return 2

    negative = job.get("negative_prompt") or ""
    strength = float(job.get("strength", 0.35))
    strength = max(0.05, min(0.95, strength))
    base_steps = int(job.get("inference_steps", 4))
    base_steps = max(1, base_steps)
    guidance = float(job.get("guidance_scale", 1.0))
    model_id = job.get("model_id") or "rupeshs/sd-turbo-openvino"
    device = (job.get("device") or "GPU").upper()
    max_side = int(job.get("max_side") or 0)
    # FastSD OV img2img multiplies steps by 3 after strength floor
    check = int(base_steps * strength)
    steps = base_steps if check >= 1 else max(1, int(ceil(1.0 / strength)))
    ov_steps = steps * 3

    print(
        f"LOAD model={model_id} device={device} strength={strength} "
        f"steps={ov_steps} (base={base_steps}) pairs={len(pairs)}",
        flush=True,
    )

    try:
        from PIL import Image
        from optimum.intel.openvino import (
            OVStableDiffusionImg2ImgPipeline,
            OVStableDiffusionXLImg2ImgPipeline,
        )
    except ImportError as e:
        print(
            f"ERROR: OpenVINO/optimum not available in this Python: {e}\n"
            "Run this worker with FastSD's env/bin/python.",
            file=sys.stderr,
        )
        return 3

    is_xl = "xl" in model_id.lower().split("/")[-1]
    pipe_cls = (
        OVStableDiffusionXLImg2ImgPipeline if is_xl else OVStableDiffusionImg2ImgPipeline
    )

    try:
        pipe = pipe_cls.from_pretrained(
            model_id,
            ov_config={"CACHE_DIR": ""},
            device=device,
            safety_checker=None,
            feature_extractor=None,
        )
    except Exception as e:
        print(f"ERROR: failed to load pipeline: {e}", file=sys.stderr)
        return 4

    n = len(pairs)
    for i, pair in enumerate(pairs):
        src = Path(pair["in"])
        dst = Path(pair["out"])
        if not src.is_file():
            print(f"ERROR: missing input {src}", file=sys.stderr)
            return 5
        try:
            with Image.open(src) as im0:
                im = _prepare_image(im0, max_side=max_side)
            result = pipe(
                image=im,
                strength=strength,
                prompt=prompt,
                negative_prompt=negative,
                num_inference_steps=ov_steps,
                guidance_scale=guidance,
                num_images_per_prompt=1,
            )
            out_im = result.images[0]
            dst.parent.mkdir(parents=True, exist_ok=True)
            out_im.save(str(dst), format="PNG")
        except Exception as e:
            print(f"ERROR: frame {i} {src.name}: {e}", file=sys.stderr)
            return 6
        print(f"PROGRESS {i + 1}/{n}", flush=True)

    print(f"DONE {n}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
