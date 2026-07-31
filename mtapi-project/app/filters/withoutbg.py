"""withoutBG per_frame stage — shared by /ops/withoutbg (video) and pipeline.

kind=per_frame. Model loaded once at factory time.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Literal

from PIL import Image as PILImage

from . import register_stage

OutputMode = Literal["cutout", "mask", "background"]


def make_withoutbg_filter(
    *,
    backend: str = "local",
    api_key: str | None = None,
    # which product to write into the sequence (video path uses one primary)
    mode: OutputMode = "cutout",
    # alternate: boolean knobs matching op (first true wins: cutout > mask > background)
    save_cutout: bool | None = None,
    save_mask: bool | None = None,
    save_background: bool | None = None,
    **_extra: Any,
):
    """Return a per_frame FilterFn. Loads withoutBG model once."""
    from ..operations import withoutbg_engine as wbe

    if save_cutout is not None or save_mask is not None or save_background is not None:
        if save_cutout:
            mode = "cutout"
        elif save_mask:
            mode = "mask"
        elif save_background:
            mode = "background"
        else:
            mode = "cutout"

    mdl = wbe._get_model(backend, api_key=api_key)

    def _run(input_png: Path, output_png: Path) -> None:
        original = PILImage.open(input_png).convert("RGB")
        rgba = mdl.remove_background(str(input_png))
        if rgba.mode != "RGBA":
            rgba = rgba.convert("RGBA")
        if rgba.size != original.size:
            rgba = rgba.resize(original.size, PILImage.Resampling.BILINEAR)

        if mode == "cutout":
            rgba.save(str(output_png))
        elif mode == "mask":
            mask = wbe._alpha_from_rgba(rgba)
            mask.save(str(output_png))
        else:
            alpha = wbe._alpha_from_rgba(rgba)
            bg = wbe._background_leftover(original, alpha)
            bg.save(str(output_png))

    async def filter_fn(src: Path, dst: Path, index: int) -> None:
        await asyncio.to_thread(_run, src, dst)

    filter_fn.kind = "per_frame"  # type: ignore[attr-defined]
    filter_fn.stage_name = "withoutbg"  # type: ignore[attr-defined]
    return filter_fn


register_stage("withoutbg", make_withoutbg_filter)
