"""DeepDream per_frame stage — shared by /ops/deepdream (video) and /ops/pipeline.

kind=per_frame (1:1). Temporal blend / optical flow / layer_cycle live in the
closure. Heavy ascent stays in operations.deepdream.dream.dream_image.
"""
from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image as PILImage

from . import register_stage


def make_deepdream_filter(
    *,
    # dream_image kwargs (passed through)
    model_name: str = "inception_v3",
    layer_preset: str = "classic",
    layer_weights: dict[str, float] | None = None,
    step: float = 0.01,
    iterations: int = 20,
    num_octave: int = 3,
    octave_scale: float = 1.4,
    max_loss: float | None = 15.0,
    jitter: bool = True,
    reinject_detail: bool = True,
    blend: float = 1.0,
    guide_path: str | None = None,
    preview_width: int | None = None,
    # video temporal / sampling
    temporal_blend: float = 0.85,
    optical_flow: bool = False,
    layer_cycle: bool = False,
    frame_step: int = 1,
    **_extra: Any,
):
    """Return a per_frame FilterFn with optional temporal state."""
    from ..operations.deepdream.dream import (
        dream_image,
        linear_blend,
        _optical_flow_seed,
        _cycle_layer_weights,
    )
    from ..operations.deepdream import models as dd_models

    model_name = dd_models._normalize_model_name(model_name)
    base_layers = dict(layer_weights or {})
    if not base_layers:
        presets = dd_models.MODEL_PRESETS.get(model_name) or dd_models.MODEL_PRESETS[dd_models.DEFAULT_MODEL]
        base_layers = dict(
            presets.get(layer_preset)
            or presets.get("classic")
            or next(iter(presets.values()))
        )

    image_kwargs: dict[str, Any] = {
        "model_name": model_name,
        "layer_preset": layer_preset,
        "layer_weights": base_layers,
        "step": float(step),
        "iterations": int(iterations),
        "num_octave": int(num_octave),
        "octave_scale": float(octave_scale),
        "max_loss": max_loss,
        "jitter": bool(jitter),
        "reinject_detail": bool(reinject_detail),
        "blend": float(blend),
        "guide_path": guide_path,
        "preview_width": preview_width if preview_width else None,
    }

    frame_step = max(1, int(frame_step))
    use_temporal = (not optical_flow) and (0.0 <= float(temporal_blend) < 1.0 - 1e-9)

    last_dream_arr = None
    last_src_arr = None
    seed_dir: Path | None = None

    async def filter_fn(src: Path, dst: Path, index: int) -> None:
        nonlocal last_dream_arr, last_src_arr, seed_dir

        if index % frame_step != 0:
            shutil.copy2(src, dst)
            return

        curr_src = np.asarray(PILImage.open(src).convert("RGB"))
        dream_src: Path = src

        if optical_flow and last_dream_arr is not None and last_src_arr is not None:
            if seed_dir is None:
                seed_dir = dst.parent / "_dd_seed"
                seed_dir.mkdir(parents=True, exist_ok=True)
            seed = _optical_flow_seed(last_src_arr, last_dream_arr, curr_src)
            seed_path = seed_dir / f"seed_{index:06d}.png"
            PILImage.fromarray(seed).save(seed_path)
            dream_src = seed_path
        elif use_temporal and last_dream_arr is not None:
            if seed_dir is None:
                seed_dir = dst.parent / "_dd_seed"
                seed_dir.mkdir(parents=True, exist_ok=True)
            blended = linear_blend(last_dream_arr, curr_src, float(temporal_blend))
            seed_path = seed_dir / f"seed_{index:06d}.png"
            PILImage.fromarray(blended).save(seed_path)
            dream_src = seed_path

        frame_kwargs = dict(image_kwargs)
        frame_kwargs["layer_weights"] = _cycle_layer_weights(
            base_layers, index, bool(layer_cycle)
        )

        await asyncio.to_thread(
            dream_image, dream_src, dst, progress_cb=None, **frame_kwargs
        )

        with PILImage.open(dst) as im:
            last_dream_arr = np.asarray(im.convert("RGB"))
        last_src_arr = curr_src

    filter_fn.kind = "per_frame"  # type: ignore[attr-defined]
    filter_fn.stage_name = "deepdream"  # type: ignore[attr-defined]
    return filter_fn


register_stage("deepdream", make_deepdream_filter)
