"""
Arbitrary neural style transfer (Magenta TF-Hub).

One model + any style *image* → paint / glass / illustration looks without
per-style training. Not DeepDream (no dog-face ImageNet ascent).

Model: google/magenta/arbitrary-image-stylization-v1-256/2
  Disk: ~90 MB (cached under TFHUB_CACHE_DIR)
  RAM:  typically ~0.8–1.5 GB peak with TensorFlow already imported
  (more if content is very large — use max_side)
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Callable

import numpy as np
from PIL import Image

# Prefer durable cache (session /tmp may vanish)
_DEFAULT_HUB_CACHE = Path.home() / ".cache" / "tfhub_modules"
os.environ.setdefault("TFHUB_CACHE_DIR", str(_DEFAULT_HUB_CACHE))

HUB_HANDLE = "https://tfhub.dev/google/magenta/arbitrary-image-stylization-v1-256/2"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}

_model_lock = threading.Lock()
_model = None


def ensure_styletransfer_available() -> None:
    try:
        import tensorflow  # noqa: F401
        import tensorflow_hub  # noqa: F401
    except ImportError as e:
        raise RuntimeError(
            "Style transfer needs tensorflow + tensorflow-hub in the mtapi venv:\n"
            "  .venv/bin/python -m pip install tensorflow tensorflow-hub"
        ) from e


def _get_model():
    global _model
    ensure_styletransfer_available()
    import tensorflow_hub as hub

    with _model_lock:
        if _model is None:
            _model = hub.load(HUB_HANDLE)
        return _model


def preload() -> None:
    """Download (~90MB once) and load the stylization graph."""
    _get_model()


def _load_rgb(path: Path) -> Image.Image:
    with Image.open(path) as im:
        return im.convert("RGB")


def _to_tf(img: Image.Image, size: tuple[int, int] | None = None):
    import tensorflow as tf

    arr = np.asarray(img, dtype=np.float32) / 255.0
    t = tf.constant(arr)[tf.newaxis, ...]  # 1,H,W,3
    if size is not None:
        t = tf.image.resize(t, size, method="bilinear")
    return t


def _resize_max_side(img: Image.Image, max_side: int) -> Image.Image:
    if max_side <= 0:
        return img
    w, h = img.size
    m = max(w, h)
    if m <= max_side:
        return img
    scale = max_side / float(m)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    return img.resize((nw, nh), Image.Resampling.LANCZOS)


def stylize_pair(
    content_path: str | Path,
    style_path: str | Path,
    output_path: str | Path,
    *,
    strength: float = 1.0,
    max_side: int = 1280,
    style_size: int = 256,
    progress_cb: Callable | None = None,
) -> dict[str, Any]:
    """
    Stylize one content image with one style image.

    strength: 0 = pure content, 1 = full stylization (blend in pixel space).
    max_side: downscale content longest side for speed/RAM (0 = full res).
    style_size: style encoder input (256 is the model default).
    """
    from .. import job_control

    from ..pathutil import unique_output_path

    content_path = Path(content_path).expanduser().resolve()
    style_path = Path(style_path).expanduser().resolve()
    output_path = unique_output_path(Path(output_path).expanduser())

    if not content_path.is_file():
        return {"ok": False, "error": f"content not found: {content_path}"}
    if not style_path.is_file():
        return {"ok": False, "error": f"style not found: {style_path}"}

    strength = float(np.clip(strength, 0.0, 1.0))
    style_size = max(64, int(style_size))

    job_control.check_cancelled()
    if progress_cb:
        progress_cb("loading style transfer model…", phase="load")

    model = _get_model()
    job_control.check_cancelled()

    if progress_cb:
        progress_cb(
            f"stylize {content_path.name} ← {style_path.name}",
            phase="stylize",
        )

    content_img = _load_rgb(content_path)
    style_img = _load_rgb(style_path)
    content_work = _resize_max_side(content_img, int(max_side) if max_side else 0)

    import tensorflow as tf

    c = _to_tf(content_work)
    s = _to_tf(style_img, (style_size, style_size))

    job_control.check_cancelled()
    try:
        # Magenta signature: stylized_image = model(content, style)[0]
        out = model(tf.constant(c), tf.constant(s))[0]
    except Exception as e:
        return {"ok": False, "error": f"stylize failed: {e}"}

    job_control.check_cancelled()
    stylized = np.clip(out.numpy()[0], 0.0, 1.0)

    if strength < 1.0 - 1e-6:
        base = np.asarray(content_work, dtype=np.float32) / 255.0
        if base.shape[:2] != stylized.shape[:2]:
            base_img = content_work.resize(
                (stylized.shape[1], stylized.shape[0]),
                Image.Resampling.LANCZOS,
            )
            base = np.asarray(base_img, dtype=np.float32) / 255.0
        stylized = stylized * strength + base * (1.0 - strength)

    result = Image.fromarray((stylized * 255.0).astype(np.uint8), "RGB")

    # If we downscaled for speed, optionally upscale back to original size
    # Keep working resolution output (cleaner than bilinear up); user can
    # set max_side=0 for full-res. Documented in params.

    output_path.parent.mkdir(parents=True, exist_ok=True)
    ext = output_path.suffix.lower()
    if ext not in IMAGE_EXTS:
        output_path = output_path.with_suffix(".png")
    if ext in (".jpg", ".jpeg"):
        result.save(output_path, quality=95)
    else:
        result.save(output_path)

    if progress_cb:
        progress_cb(f"wrote {output_path}", phase="done")

    return {
        "ok": True,
        "output_path": str(output_path),
        "content": str(content_path),
        "style": str(style_path),
        "size": list(result.size),
        "strength": strength,
        "max_side": max_side,
    }


def stylize_batch(
    content_paths: list[str],
    style_path: str | Path,
    *,
    output_dir: str | Path | None = None,
    suffix: str = "_styled",
    strength: float = 1.0,
    max_side: int = 1280,
    style_size: int = 256,
    progress_cb: Callable | None = None,
) -> dict[str, Any]:
    """Stylize many contents with one style image. Model loaded once."""
    from .. import job_control

    style_path = Path(style_path).expanduser().resolve()
    if not style_path.is_file():
        return {"ok": False, "error": f"style not found: {style_path}", "results": []}

    contents = [str(Path(p).expanduser().resolve()) for p in content_paths]
    if not contents:
        return {"ok": False, "error": "No content images", "results": []}

    out_dir = Path(output_dir).expanduser().resolve() if output_dir else None
    total = len(contents)

    if progress_cb:
        progress_cb(
            f"style transfer: {total} image(s), style={style_path.name}",
            phase="styletransfer",
            current=0,
            total=total,
            unit="images",
        )

    # Warm model once
    try:
        preload()
    except Exception as e:
        return {"ok": False, "error": str(e), "results": []}

    results: list[dict[str, Any]] = []
    ok_n = 0
    primary = None

    for i, src in enumerate(contents):
        job_control.check_cancelled()
        src_p = Path(src)
        from ..pathutil import unique_output_path

        dest_dir = out_dir or src_p.parent
        dest = unique_output_path(dest_dir / f"{src_p.stem}{suffix}.png")

        if progress_cb:
            progress_cb(
                f"image {i + 1}/{total}: {src_p.name}",
                phase="styletransfer",
                current=i + 1,
                total=total,
                unit="images",
            )

        r = stylize_pair(
            src,
            style_path,
            dest,
            strength=strength,
            max_side=max_side,
            style_size=style_size,
            progress_cb=None,
        )
        results.append(r)
        if r.get("ok"):
            ok_n += 1
            if primary is None:
                primary = r.get("output_path")

    if progress_cb:
        progress_cb(
            f"style transfer done: {ok_n}/{total} ok",
            phase="done",
            current=total,
            total=total,
            unit="images",
        )

    return {
        "ok": ok_n > 0,
        "ok_count": ok_n,
        "total": total,
        "results": results,
        "output_path": primary,
        "error": None if ok_n > 0 else "All images failed",
    }
