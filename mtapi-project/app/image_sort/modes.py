from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

log = logging.getLogger("mtapi.image_sort")

ScoreFn = Callable[[Path, Path], float]


def _phash_distance(a: Path, b: Path) -> float:
    import imagehash
    from PIL import Image

    with Image.open(a) as im:
        ha = imagehash.phash(im.convert("RGB"), hash_size=8)
    with Image.open(b) as im:
        hb = imagehash.phash(im.convert("RGB"), hash_size=8)
    return float(ha - hb)


def _ahash_distance(a: Path, b: Path) -> float:
    import imagehash
    from PIL import Image

    with Image.open(a) as im:
        ha = imagehash.average_hash(im.convert("RGB"), hash_size=8)
    with Image.open(b) as im:
        hb = imagehash.average_hash(im.convert("RGB"), hash_size=8)
    return float(ha - hb)


def _colorhash_distance(a: Path, b: Path) -> float:
    import imagehash
    from PIL import Image

    with Image.open(a) as im:
        ha = imagehash.colorhash(im.convert("RGB"), binbits=3)
    with Image.open(b) as im:
        hb = imagehash.colorhash(im.convert("RGB"), binbits=3)
    return float(ha - hb)


def _mse_distance(a: Path, b: Path) -> float:
    import numpy as np
    from PIL import Image

    with Image.open(a) as im_a, Image.open(b) as im_b:
        size = _score_size(im_a, im_b)
        a_arr = np.asarray(im_a.convert("RGB").resize(size), dtype=np.float64)
        b_arr = np.asarray(im_b.convert("RGB").resize(size), dtype=np.float64)
    return float(np.mean((a_arr - b_arr) ** 2))


def _ssim_distance(a: Path, b: Path) -> float | None:
    try:
        from skimage.metrics import structural_similarity as ssim
    except ImportError:
        return None
    import numpy as np
    from PIL import Image

    with Image.open(a) as im_a, Image.open(b) as im_b:
        size = _score_size(im_a, im_b)
        a_arr = np.asarray(im_a.convert("RGB").resize(size))
        b_arr = np.asarray(im_b.convert("RGB").resize(size))
    s = ssim(a_arr, b_arr, channel_axis=2, data_range=255)
    return 1.0 - float(s)


def _score_size(im_a, im_b) -> tuple[int, int]:
    max_dim = 256
    max_long = max(im_a.width, im_a.height, im_b.width, im_b.height)
    if max_long <= max_dim:
        return (im_a.width, im_a.height)
    scale = max_dim / max_long
    return (int(round(im_a.width * scale)), int(round(im_a.height * scale)))


MODES: dict[str, ScoreFn] = {
    "phash": _phash_distance,
    "ahash": _ahash_distance,
    "colorhash": _colorhash_distance,
    "mse": _mse_distance,
}

try:
    _ssim_distance(Path(__file__), Path(__file__))
    MODES["ssim"] = _ssim_distance  # type: ignore[assignment]
except (ImportError, Exception):
    pass
