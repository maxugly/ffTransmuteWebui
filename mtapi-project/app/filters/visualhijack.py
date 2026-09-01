"""Visual Hijack per_frame stage — image injection at a frame range.

Replaces a contiguous range of source frames with an injected image,
supporting two transition styles:
  - smear: the injected image fades in, holds, then fades out — a
    pixel-level approximation of the MV-based smear in the datamosh
    pipeline (app/operations/datamosh/common.py). At the filter-platform
    level we don't have motion vectors, so we blend the injected image
    with the source frame proportionally across the range.
  - freeze: the injected image holds constant throughout the range.

kind=per_frame. Shared by /ops/pipeline (“visualhijack” stage name).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from PIL import Image as PILImage

from . import register_stage

TransitionStyle = Literal["smear", "freeze"]


def _load_scaled_image(image_path: str, target_w: int, target_h: int) -> PILImage.Image:
    """Load *image_path*, scale to fit inside *target_w*×*target_h*, pad with
    black to exact size, and return an RGB image."""
    im = PILImage.open(image_path).convert("RGB")
    im.thumbnail((target_w, target_h), PILImage.Resampling.LANCZOS)
    if im.size != (target_w, target_h):
        padded = PILImage.new("RGB", (target_w, target_h), (0, 0, 0))
        ox = (target_w - im.width) // 2
        oy = (target_h - im.height) // 2
        padded.paste(im, (ox, oy))
        im = padded
    return im


def make_visualhijack_filter(
    *,
    inject_image_path: str = "",
    start_frame: int = 1,
    end_frame: int = 999999,
    transition_style: TransitionStyle = "smear",
    **_extra: Any,
):
    """Return a per_frame FilterFn.

    Parameters mirror ``DatamoshHijackParams`` so the pipeline stage and the
    datamosh operation share the same vocabulary.

    ``start_frame`` is 1-based inclusive; ``end_frame`` is 1-based inclusive.
    """

    if not inject_image_path:
        raise ValueError("inject_image_path is required for visualhijack filter")

    if not os.path.isfile(inject_image_path):
        raise FileNotFoundError(f"Injected image not found: {inject_image_path}")

    inject_image_path = os.path.abspath(inject_image_path)

    # Lazily load the image once at factory time — it's reused for every frame.
    _cached: dict[str, PILImage.Image] = {}

    def _get_inject(target_w: int, target_h: int) -> PILImage.Image:
        key = f"{target_w}x{target_h}"
        if key not in _cached:
            _cached[key] = _load_scaled_image(inject_image_path, target_w, target_h)
        return _cached[key]

    async def filter_fn(src: Path, dst: Path, index: int) -> None:
        """index is 0-based frame number (matches video_pipeline.dump naming).

        start_frame/end_frame are 1-based from the public API.
        """
        frame_num_1based = index + 1

        # Outside the injection range → pass through unchanged
        if frame_num_1based < start_frame or frame_num_1based > end_frame:
            # shutil.copy2 would be fine, but PIL round-trip is safe for any
            # pixel format and avoids dependency ordering issues.
            src_img = PILImage.open(src).convert("RGB")
            src_img.save(dst, "PNG")
            return

        # Inside the injection range → apply Visual Hijack
        src_img = PILImage.open(src).convert("RGB")
        w, h = src_img.size
        inject = _get_inject(w, h)

        if transition_style == "freeze":
            inject.save(dst, "PNG")
            return

        # smear: fade-in → hold → fade-out across the range
        total = end_frame - start_frame + 1
        pos = frame_num_1based - start_frame  # 0-based within range

        if total <= 2:
            # Not enough frames for a gradient; just inject
            inject.save(dst, "PNG")
            return

        # Fade in over the first third, full image for the middle third,
        # fade out over the last third.
        fade_third = max(1, total // 3)

        if pos < fade_third:
            alpha = (pos + 1) / fade_third
        elif pos >= total - fade_third:
            alpha = (total - pos) / fade_third
        else:
            alpha = 1.0

        alpha = min(max(alpha, 0.0), 1.0)

        # Blend: (1-alpha)*source + alpha*inject
        out = PILImage.blend(src_img, inject, alpha)
        out.save(dst, "PNG")

    filter_fn.kind = "per_frame"  # type: ignore[attr-defined]
    filter_fn.stage_name = "visualhijack"  # type: ignore[attr-defined]
    return filter_fn


register_stage("visualhijack", make_visualhijack_filter)
