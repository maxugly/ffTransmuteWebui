"""
Background removal via withoutbg (open weights local or Cloud API).

Primary result is RGBA cutout. Optional extras derived from the alpha:
  - mask: grayscale alpha (white = subject)
  - background: original with inverted alpha (leftover BG, transparent subject)

Package: https://github.com/withoutbg/withoutbg-python
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Callable, Literal

from PIL import Image

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}

Backend = Literal["local", "api"]

# One model instance per process (weights are heavy ~455MB)
_model_lock = threading.Lock()
_local_model = None
_api_model = None
_api_key_used: str | None = None


def ensure_withoutbg_available(backend: Backend = "local") -> None:
    try:
        from withoutbg import WithoutBG  # noqa: F401
    except ImportError as e:
        raise RuntimeError(
            "withoutbg is not installed in the mtapi venv:\n"
            "  .venv/bin/python -m pip install withoutbg"
        ) from e
    if backend == "api":
        key = os.environ.get("WITHOUTBG_API_KEY", "").strip()
        if not key:
            raise RuntimeError(
                "API mode needs WITHOUTBG_API_KEY in the environment "
                "(or pass api_key in the request)."
            )


def get_image_files(image_dir: Path) -> list[str]:
    image_dir = Path(image_dir)
    files = []
    for p in sorted(image_dir.iterdir()):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
            files.append(str(p.resolve()))
    return files


def _get_model(backend: Backend, api_key: str | None = None):
    global _local_model, _api_model, _api_key_used
    from withoutbg import WithoutBG

    with _model_lock:
        if backend == "local":
            if _local_model is None:
                _local_model = WithoutBG.open_weights()
            return _local_model

        key = (api_key or os.environ.get("WITHOUTBG_API_KEY") or "").strip()
        if not key:
            raise RuntimeError(
                "API mode needs api_key or WITHOUTBG_API_KEY environment variable"
            )
        if _api_model is None or _api_key_used != key:
            _api_model = WithoutBG.api(api_key=key)
            _api_key_used = key
        return _api_model


def _load_rgb(path: Path) -> Image.Image:
    with Image.open(path) as im:
        # Match withoutbg: work in RGB for compositing background leftover
        return im.convert("RGB")


def _alpha_from_rgba(rgba: Image.Image) -> Image.Image:
    if rgba.mode != "RGBA":
        rgba = rgba.convert("RGBA")
    return rgba.split()[-1]


def _background_leftover(original_rgb: Image.Image, alpha: Image.Image) -> Image.Image:
    """
    Background only: original RGB + inverted alpha so the subject is
    transparent and the leftover scene remains.
    """
    if original_rgb.size != alpha.size:
        alpha = alpha.resize(original_rgb.size, Image.Resampling.BILINEAR)
    inv = Image.eval(alpha, lambda a: 255 - a)
    bg = original_rgb.convert("RGBA")
    bg.putalpha(inv)
    return bg


def _out_paths(
    src: Path,
    output_dir: Path,
    *,
    prefix: str,
    suffix: str,
    fmt: str,
) -> dict[str, Path]:
    stem = src.stem
    # Avoid double-prefix if already processed
    if prefix and stem.startswith(prefix.rstrip("-_") + "-"):
        base = stem
    elif prefix:
        base = f"{prefix.rstrip('-_')}-{stem}"
    else:
        base = stem
    if suffix:
        base = f"{base}{suffix}"
    ext = ".png" if fmt == "png" else ".webp"
    return {
        "cutout": output_dir / f"{base}{ext}",
        "mask": output_dir / f"{base}-mask.png",
        "background": output_dir / f"{base}-bg{ext}",
    }


def process_one(
    src: str | Path,
    *,
    output_dir: Path | None = None,
    backend: Backend = "local",
    api_key: str | None = None,
    save_cutout: bool = True,
    save_mask: bool = False,
    save_background: bool = False,
    prefix: str = "withoutbg",
    suffix: str = "",
    fmt: str = "png",
    model=None,
    progress_cb: Callable | None = None,
) -> dict[str, Any]:
    """
    Remove background for one image. Returns paths of written files.

    At least one of save_cutout / save_mask / save_background should be True.
    """
    from .. import job_control

    src = Path(src).expanduser().resolve()
    if not src.is_file():
        return {"ok": False, "error": f"not found: {src}", "src": str(src)}

    if not (save_cutout or save_mask or save_background):
        return {
            "ok": False,
            "error": "Nothing to save — enable cutout, mask, and/or background",
            "src": str(src),
        }

    out_dir = Path(output_dir).expanduser().resolve() if output_dir else src.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    from ..pathutil import unique_related_paths

    paths = _out_paths(src, out_dir, prefix=prefix, suffix=suffix, fmt=fmt)
    # Only allocate paths we will write; share one sequence number across the set
    wanted = {}
    if save_cutout:
        wanted["cutout"] = paths["cutout"]
    if save_mask:
        wanted["mask"] = paths["mask"]
    if save_background:
        wanted["background"] = paths["background"]
    paths = unique_related_paths(wanted, primary_key="cutout" if save_cutout else None)

    job_control.check_cancelled()
    mdl = model or _get_model(backend, api_key=api_key)

    def _progress(v: float) -> None:
        if progress_cb:
            try:
                progress_cb(f"{src.name}: {v * 100:.0f}%", phase="withoutbg")
            except Exception:
                pass
        job_control.check_cancelled()

    try:
        original = _load_rgb(src)
        rgba = mdl.remove_background(str(src), progress_callback=_progress)
        if rgba.mode != "RGBA":
            rgba = rgba.convert("RGBA")
        # Align size with original if EXIF/orientation changed slightly
        if rgba.size != original.size:
            rgba = rgba.resize(original.size, Image.Resampling.BILINEAR)
        alpha = _alpha_from_rgba(rgba)
    except Exception as e:
        return {"ok": False, "error": str(e), "src": str(src)}

    written: dict[str, str] = {}
    try:
        if save_cutout:
            # PNG/WebP keep alpha; JPEG would drop it
            rgba.save(paths["cutout"])
            written["cutout"] = str(paths["cutout"])
        if save_mask:
            alpha.save(paths["mask"])
            written["mask"] = str(paths["mask"])
        if save_background:
            bg = _background_leftover(original, alpha)
            bg.save(paths["background"])
            written["background"] = str(paths["background"])
    except Exception as e:
        return {
            "ok": False,
            "error": f"save failed: {e}",
            "src": str(src),
            "written": written,
        }

    return {
        "ok": True,
        "src": str(src),
        "written": written,
        "primary": written.get("cutout")
        or written.get("mask")
        or written.get("background"),
    }


def process_many(
    image_files: list[str],
    *,
    output_dir: str | Path | None = None,
    backend: Backend = "local",
    api_key: str | None = None,
    save_cutout: bool = True,
    save_mask: bool = False,
    save_background: bool = False,
    prefix: str = "withoutbg",
    suffix: str = "",
    fmt: str = "png",
    progress_cb: Callable | None = None,
) -> dict[str, Any]:
    """Batch remove backgrounds. Loads model once."""
    from .. import job_control

    image_files = [str(Path(p).expanduser().resolve()) for p in image_files]
    if not image_files:
        return {"ok": False, "error": "No images", "results": []}

    if not (save_cutout or save_mask or save_background):
        return {
            "ok": False,
            "error": "Enable at least one of: save_cutout, save_mask, save_background",
            "results": [],
        }

    out_dir = Path(output_dir).expanduser().resolve() if output_dir else None
    total = len(image_files)

    if progress_cb:
        progress_cb(
            f"withoutbg: {total} image(s), backend={backend}",
            phase="withoutbg",
            current=0,
            total=total,
            unit="images",
        )

    try:
        model = _get_model(backend, api_key=api_key)
        # Eager load local weights so first image progress is meaningful
        if backend == "local" and hasattr(model, "preload"):
            if progress_cb:
                progress_cb(
                    "loading withoutbg open weights (first run may download ~455MB)…",
                    phase="load",
                    current=0,
                    total=total,
                    unit="images",
                )
            model.preload()
    except Exception as e:
        return {"ok": False, "error": str(e), "results": []}

    results: list[dict[str, Any]] = []
    ok_n = 0
    for i, src in enumerate(image_files):
        job_control.check_cancelled()
        name = Path(src).name
        if progress_cb:
            progress_cb(
                f"image {i + 1}/{total}: {name}",
                phase="withoutbg",
                current=i + 1,
                total=total,
                unit="images",
            )

        def _one_progress(msg: str, **kw):
            if progress_cb:
                progress_cb(msg, current=i + 1, total=total, unit="images", **kw)

        r = process_one(
            src,
            output_dir=out_dir or Path(src).parent,
            backend=backend,
            api_key=api_key,
            save_cutout=save_cutout,
            save_mask=save_mask,
            save_background=save_background,
            prefix=prefix,
            suffix=suffix,
            fmt=fmt,
            model=model,
            progress_cb=_one_progress,
        )
        results.append(r)
        if r.get("ok"):
            ok_n += 1

    primary = None
    for r in results:
        if r.get("ok") and r.get("primary"):
            primary = r["primary"]
            break

    if progress_cb:
        progress_cb(
            f"withoutbg done: {ok_n}/{total} ok",
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
