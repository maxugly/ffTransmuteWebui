"""Style transfer per_frame stage — Magenta TF-Hub.

kind=per_frame. Model + style tensor loaded once at factory time.
Shared by /ops/styletransfer (video) and /ops/pipeline.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image as PILImage

from . import register_stage


def make_styletransfer_filter(
    *,
    style_path: str,
    strength: float = 1.0,
    max_side: int = 1280,
    style_size: int = 256,
    **_extra: Any,
):
    """Return a per_frame FilterFn. Loads model + style once."""
    from ..operations import styletransfer_engine as ste
    import tensorflow as tf

    style_file = Path(style_path).expanduser().resolve()
    if not style_file.is_file():
        raise FileNotFoundError(f"Style image not found: {style_file}")

    model = ste._get_model()
    style_img = ste._load_rgb(style_file)
    style_tensor = ste._to_tf(style_img, (int(style_size), int(style_size)))
    strength = float(strength)
    max_side_i = int(max_side) if max_side else 0

    def _run(input_png: Path, output_png: Path) -> None:
        content_img = ste._load_rgb(input_png)
        content_work = ste._resize_max_side(content_img, max_side_i)
        c = ste._to_tf(content_work)

        out_tensor = model(tf.constant(c), tf.constant(style_tensor))[0]
        stylized = np.clip(out_tensor.numpy()[0], 0.0, 1.0)

        if strength < 1.0 - 1e-6:
            base = np.asarray(content_work, dtype=np.float32) / 255.0
            if base.shape[:2] != stylized.shape[:2]:
                base_img = content_work.resize(
                    (stylized.shape[1], stylized.shape[0]),
                    PILImage.Resampling.LANCZOS,
                )
                base = np.asarray(base_img, dtype=np.float32) / 255.0
            stylized = stylized * strength + base * (1.0 - strength)

        result = PILImage.fromarray((stylized * 255.0).astype(np.uint8), "RGB")
        result.save(str(output_png))

    async def filter_fn(src: Path, dst: Path, index: int) -> None:
        await asyncio.to_thread(_run, src, dst)

    filter_fn.kind = "per_frame"  # type: ignore[attr-defined]
    filter_fn.stage_name = "styletransfer"  # type: ignore[attr-defined]
    return filter_fn


register_stage("styletransfer", make_styletransfer_filter)
