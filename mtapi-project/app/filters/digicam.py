"""digicam per_frame stage — shared by /ops/digicam_2000s (video path).

kind=per_frame. No model weights; params are value types so the factory just
captures a DigicamParams snapshot. Deterministic seeding (seed+i) happens
here so every frame gets its own Generator while dims stay identical.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from PIL import Image as PILImage

from . import register_stage


def make_digicam_filter(**params: Any):
    """Return a per_frame FilterFn over digicam_core."""
    from ..digicam_core import params_from_dict

    core_params = params_from_dict(params)

    def _run(input_png: Path, output_png: Path, index: int) -> None:
        from .. import digicam_core as core

        img = PILImage.open(input_png).convert("RGB")
        seed: int | None
        if core_params.deterministic:
            try:
                seed = int(core_params.noise_seed) + int(index)
            except Exception:
                seed = int(index)
        else:
            seed = None
        out = core.process_pil(img, core_params, seed=seed)
        output_png.parent.mkdir(parents=True, exist_ok=True)
        out.save(str(output_png))

    async def filter_fn(src: Path, dst: Path, index: int) -> None:
        await asyncio.to_thread(_run, src, dst, index)

    filter_fn.kind = "per_frame"  # type: ignore[attr-defined]
    filter_fn.stage_name = "digicam"  # type: ignore[attr-defined]
    return filter_fn


register_stage("digicam", make_digicam_filter)
