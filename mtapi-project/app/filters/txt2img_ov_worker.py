#!/usr/bin/env python3
"""OpenVINO text-to-image worker — run under FastSD's Python.

Usage:
  DEVICE=gpu /path/to/fastsd/env/bin/python txt2img_ov_worker.py --job /tmp/job.json

Job JSON:
  {
    "outputs": ["/abs/out_000.png", ...],
    "prompt": "...",
    "negative_prompt": "",
    "inference_steps": 4,
    "guidance_scale": 1.0,
    "width": 512,
    "height": 512,
    "model_id": "rupeshs/sd-turbo-openvino",
    "device": "GPU",
    "seed": null
  }
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path


def _even8(n: int) -> int:
    n = max(8, int(n))
    return n - (n % 8)


def main() -> int:
    ap = argparse.ArgumentParser(description="OpenVINO txt2img batch worker")
    ap.add_argument("--job", required=True)
    args = ap.parse_args()

    job_path = Path(args.job)
    if not job_path.is_file():
        print(f"ERROR: job file not found: {job_path}", file=sys.stderr)
        return 2

    job = json.loads(job_path.read_text(encoding="utf-8"))
    outputs = [Path(p) for p in (job.get("outputs") or [])]
    if not outputs:
        print("ERROR: no outputs in job", file=sys.stderr)
        return 2

    prompt = (job.get("prompt") or "").strip()
    if not prompt:
        print("ERROR: empty prompt", file=sys.stderr)
        return 2

    negative = job.get("negative_prompt") or ""
    steps = max(1, int(job.get("inference_steps", 4)))
    guidance = float(job.get("guidance_scale", 1.0))
    width = _even8(int(job.get("width", 512)))
    height = _even8(int(job.get("height", 512)))
    model_id = job.get("model_id") or "rupeshs/sd-turbo-openvino"
    device = (job.get("device") or "GPU").upper()
    seed = job.get("seed")
    n = len(outputs)

    print(
        f"LOAD model={model_id} device={device} steps={steps} "
        f"size={width}x{height} n={n}",
        flush=True,
    )

    try:
        import torch
        from optimum.intel.openvino import (
            OVStableDiffusionPipeline,
            OVStableDiffusionXLPipeline,
        )
    except ImportError as e:
        print(
            f"ERROR: OpenVINO/optimum not available: {e}\n"
            "Run with FastSD env/bin/python.",
            file=sys.stderr,
        )
        return 3

    is_xl = "xl" in model_id.lower().split("/")[-1]
    pipe_cls = OVStableDiffusionXLPipeline if is_xl else OVStableDiffusionPipeline

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

    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    else:
        seed = int(seed)

    # Generate one at a time so progress updates (num_images_per_prompt=1 each)
    for i, out_path in enumerate(outputs):
        cur_seed = seed + i
        torch.manual_seed(cur_seed)
        try:
            result = pipe(
                prompt=prompt,
                negative_prompt=negative,
                num_inference_steps=steps,
                guidance_scale=guidance,
                width=width,
                height=height,
                num_images_per_prompt=1,
            )
            im = result.images[0]
            out_path.parent.mkdir(parents=True, exist_ok=True)
            im.save(str(out_path), format="PNG")
        except Exception as e:
            print(f"ERROR: image {i}: {e}", file=sys.stderr)
            return 6
        print(f"PROGRESS {i + 1}/{n} seed={cur_seed}", flush=True)

    print(f"DONE {n} seed0={seed}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
