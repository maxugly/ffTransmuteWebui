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
    from ..pathutil import finalize_output_path

    content_path = Path(content_path).expanduser().resolve()
    style_path = Path(style_path).expanduser().resolve()
    # Defer uniqueness until after extension normalize (below)

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

    # Extension + never-overwrite (after any suffix fixes so we don't unique then rewrite ext)
    output_path = finalize_output_path(
        output_path,
        source=content_path,
        default_suffix="_styled",
        default_ext=".png",
        allowed_exts=IMAGE_EXTS,
    )
    ext = output_path.suffix.lower()
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


def stylize_strength_strip(
    content_path: str | Path,
    style_path: str | Path,
    candidates_dir: str | Path,
    *,
    strengths: list[float],
    max_side: int = 1280,
    style_size: int = 256,
    progress_cb: Callable | None = None,
) -> dict[str, Any]:
    """Run Magenta **once**, then blend content↔style at each strength → frame_*.png.

    Efficient evolve strip: N strengths do not re-run the neural net N times.
    Frame 0 = strength[0], last = strength[-1]. Returns paths list.
    """
    from .. import job_control

    content_path = Path(content_path).expanduser().resolve()
    style_path = Path(style_path).expanduser().resolve()
    out_dir = Path(candidates_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not content_path.is_file():
        return {"ok": False, "error": f"content not found: {content_path}", "paths": []}
    if not style_path.is_file():
        return {"ok": False, "error": f"style not found: {style_path}", "paths": []}
    if not strengths:
        return {"ok": False, "error": "need at least one strength", "paths": []}

    job_control.check_cancelled()
    if progress_cb:
        progress_cb("loading style transfer model…", phase="load")
    model = _get_model()

    content_img = _load_rgb(content_path)
    style_img = _load_rgb(style_path)
    content_work = _resize_max_side(content_img, int(max_side) if max_side else 0)

    import tensorflow as tf

    c = _to_tf(content_work)
    s = _to_tf(style_img, (max(64, int(style_size)), max(64, int(style_size))))

    job_control.check_cancelled()
    if progress_cb:
        progress_cb(
            f"stylize once {content_path.name} ← {style_path.name}",
            phase="stylize",
        )
    try:
        out = model(tf.constant(c), tf.constant(s))[0]
    except Exception as e:
        return {"ok": False, "error": f"stylize failed: {e}", "paths": []}

    full = np.clip(out.numpy()[0], 0.0, 1.0)
    base = np.asarray(content_work, dtype=np.float32) / 255.0
    if base.shape[:2] != full.shape[:2]:
        base_img = content_work.resize(
            (full.shape[1], full.shape[0]),
            Image.Resampling.LANCZOS,
        )
        base = np.asarray(base_img, dtype=np.float32) / 255.0

    paths: list[str] = []
    n = len(strengths)
    for i, raw_s in enumerate(strengths):
        job_control.check_cancelled()
        st = float(np.clip(raw_s, 0.0, 1.0))
        if st < 1e-6:
            blended = base
        elif st > 1.0 - 1e-6:
            blended = full
        else:
            blended = full * st + base * (1.0 - st)
        rgb = (np.clip(blended, 0.0, 1.0) * 255.0).astype(np.uint8)
        dest = out_dir / f"frame_{i:06d}.png"
        Image.fromarray(rgb, "RGB").save(dest, format="PNG", compress_level=1)
        paths.append(str(dest))
        if progress_cb:
            progress_cb(
                f"evolve strength {st:.2f} ({i + 1}/{n})",
                phase="evolve",
                current=i + 1,
                total=n,
                unit="frames",
                latest_frame=str(dest),
            )

    return {
        "ok": True,
        "paths": paths,
        "strengths": [float(np.clip(s, 0, 1)) for s in strengths],
        "size": (full.shape[1], full.shape[0]),
    }
