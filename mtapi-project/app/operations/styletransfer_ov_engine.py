"""
OpenVINO AdaIN style transfer engine (GPU path for the Style Transfer tab).

Port of the proven OVS-Style split-graph runtime
(``ovs_style/run.py``: StyleEncoder once per style + per-bucket
ContentStylizer per frame, no transposed convolutions — safe on the Intel
iGPU). Only ``openvino`` + ``cv2`` + ``numpy`` are needed at runtime; the
torch export stack is NOT required.

Artifacts (``style_encoder_fp16.xml`` + per-bucket
``content_stylize_<HxW>_fp16.xml``) resolve in this order:
  1. ``$OVS_STYLE_DIR``
  2. ``mtapi-project/junk/models/ovs_style/`` (installed via
     ``POST /ops/styletransfer_ov_setup``)
  3. The dev-machine build at ``/home/m/snc/cod/testLamaEraser/ovs_style/artifacts``

Device: ``"GPU"`` is strict — any GPU compile/infer failure raises
(no silent CPU fallback; the tab's Engine dropdown must mean what it says).
Pass ``allow_fallback=True`` only for diagnostics (e.g. setup probes).
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Callable

import numpy as np

STYLE_SHAPE: tuple[int, int] = (512, 512)
BUCKETS: list[tuple[int, int]] = [(512, 512), (768, 768), (1024, 1024), (1080, 1920)]

_DEV_FALLBACK = Path("/home/m/snc/cod/testLamaEraser/ovs_style/artifacts")

_lock = threading.Lock()
_compiled: dict[str, Any] = {}
_style_cache: dict[tuple, tuple[np.ndarray, np.ndarray]] = {}


def artifacts_candidates() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("OVS_STYLE_DIR", "").strip()
    if env:
        out.append(Path(env).expanduser())
    out.append(
        Path(__file__).resolve().parent.parent.parent / "junk" / "models" / "ovs_style"
    )
    out.append(_DEV_FALLBACK)
    return out


def resolve_artifacts_dir() -> Path | None:
    """First candidate dir that holds the style-encoder IR, else None."""
    for d in artifacts_candidates():
        try:
            if (d / "style_encoder_fp16.xml").is_file():
                return d
        except OSError:
            continue
    return None


def ir_present() -> bool:
    return resolve_artifacts_dir() is not None


def available_devices() -> list[str]:
    try:
        import openvino as ov

        return [str(x) for x in ov.Core().available_devices]
    except Exception:
        return []


def pick_bucket(h: int, w: int) -> tuple[int, int]:
    """Smallest bucket that fits (h, w); largest bucket when oversized."""
    for bh, bw in BUCKETS:
        if h <= bh and w <= bw:
            return (bh, bw)
    return BUCKETS[-1]


def _get_compiled(
    ir_path: str, device: str, *, allow_fallback: bool = False
) -> tuple[Any, str]:
    """Compile (or hit cache). Strict by default: GPU failure raises, no
    silent CPU fallback. Returns (model, settled)."""
    import openvino as ov

    want = (device or "GPU").upper()
    if want not in ("GPU", "CPU"):
        want = "GPU"
    candidates = [want]
    if allow_fallback and want == "GPU":
        candidates.append("CPU")
    available = []
    try:
        available = [str(x) for x in ov.Core().available_devices]
    except Exception:
        pass
    last_err: Exception | None = None
    for dev in candidates:
        if available and dev not in available:
            last_err = RuntimeError(f"device {dev} not in {available}")
            continue
        key = f"{ir_path}@{dev}"
        with _lock:
            hit = _compiled.get(key)
        if hit is not None:
            return hit, dev
        try:
            model = ov.Core().read_model(ir_path)
            compiled = ov.Core().compile_model(model, dev)
        except Exception as e:  # noqa: BLE001 — strict raise below, fallback only if asked
            last_err = e
            continue
        with _lock:
            if len(_compiled) >= 8:
                _compiled.pop(next(iter(_compiled)))
            _compiled[key] = compiled
        return compiled, dev
    if len(candidates) == 1:
        raise RuntimeError(f"OpenVINO GPU failed (no CPU fallback — engine=gpu): {last_err}")
    raise RuntimeError(f"OpenVINO compile failed on {candidates}: {last_err}")


def clear_cache() -> None:
    with _lock:
        _compiled.clear()
        _style_cache.clear()


def _load_rgb(path: Path) -> np.ndarray:
    """File → uint8 RGB HWC."""
    from PIL import Image

    with Image.open(path) as im:
        return np.asarray(im.convert("RGB"), dtype=np.uint8)


def _resize_rgb(arr: np.ndarray, w: int, h: int) -> np.ndarray:
    import cv2

    if arr.shape[1] == w and arr.shape[0] == h:
        return arr
    interp = cv2.INTER_AREA if (w * h < arr.shape[0] * arr.shape[1]) else cv2.INTER_LINEAR
    return cv2.resize(arr, (w, h), interpolation=interp)


def _to_nchw(arr: np.ndarray) -> np.ndarray:
    return (arr.astype(np.float32) / 255.0).transpose(2, 0, 1)[np.newaxis, ...].copy()


def _from_nchw(tensor: np.ndarray) -> np.ndarray:
    return np.clip(tensor[0].transpose(1, 2, 0) * 255.0, 0, 255).astype(np.uint8)


def _resize_max_side(arr: np.ndarray, max_side: int) -> np.ndarray:
    if max_side <= 0:
        return arr
    h, w = arr.shape[:2]
    m = max(w, h)
    if m <= max_side:
        return arr
    scale = max_side / float(m)
    return _resize_rgb(arr, max(1, int(round(w * scale))), max(1, int(round(h * scale))))


def encode_style(
    style_path: str | Path,
    *,
    device: str = "GPU",
    allow_fallback: bool = False,
) -> tuple[np.ndarray, np.ndarray, str]:
    """Encode a style image → (mean, std, settled_device). Cached by path+mtime."""
    d = resolve_artifacts_dir()
    if d is None:
        raise RuntimeError(
            "OVS-Style IR missing — install via POST /ops/styletransfer_ov_setup "
            "(or set $OVS_STYLE_DIR)."
        )
    sp = Path(style_path).expanduser().resolve()
    if not sp.is_file():
        raise FileNotFoundError(f"Style image not found: {sp}")
    mtime = sp.stat().st_mtime_ns
    ir = str(d / "style_encoder_fp16.xml")
    compiled, settled = _get_compiled(ir, device, allow_fallback=allow_fallback)
    key = (str(sp), mtime, settled)
    with _lock:
        hit = _style_cache.get(key)
    if hit is not None:
        return hit[0], hit[1], settled
    style = _resize_rgb(_load_rgb(sp), STYLE_SHAPE[1], STYLE_SHAPE[0])
    result = compiled({"style_image": _to_nchw(style)})
    mean, std = result["style_mean"], result["style_std"]
    with _lock:
        if len(_style_cache) >= 8:
            _style_cache.pop(next(iter(_style_cache)))
        _style_cache[key] = (mean, std)
    return mean, std, settled


def stylize_array(
    content_rgb: np.ndarray,
    style_mean: np.ndarray,
    style_std: np.ndarray,
    *,
    alpha: float = 1.0,
    device: str = "GPU",
    allow_fallback: bool = False,
) -> np.ndarray:
    """Stylize a uint8 RGB HWC array → uint8 RGB HWC at the same size."""
    d = resolve_artifacts_dir()
    if d is None:
        raise RuntimeError(
            "OVS-Style IR missing — install via POST /ops/styletransfer_ov_setup."
        )
    h, w = content_rgb.shape[:2]
    bh, bw = pick_bucket(h, w)
    ir = str(d / f"content_stylize_{bh}x{bw}_fp16.xml")
    if not Path(ir).is_file():
        raise RuntimeError(f"OVS-Style bucket IR missing: {ir}")
    compiled, _ = _get_compiled(ir, device, allow_fallback=allow_fallback)
    content = _to_nchw(_resize_rgb(content_rgb, bw, bh))
    out = compiled(
        {
            "content_image": content,
            "style_mean": style_mean,
            "style_std": style_std,
            "alpha": np.array([float(alpha)], dtype=np.float32),
        }
    )["stylized_image"]
    return _resize_rgb(_from_nchw(out), w, h)


def preload(*, device: str = "GPU", allow_fallback: bool = False) -> str:
    """Compile the style encoder so the first real run is warm. Returns settled device."""
    d = resolve_artifacts_dir()
    if d is None:
        raise RuntimeError(
            "OVS-Style IR missing — install via POST /ops/styletransfer_ov_setup."
        )
    _, settled = _get_compiled(
        str(d / "style_encoder_fp16.xml"), device, allow_fallback=allow_fallback
    )
    return settled


def stylize_pair(
    content_path: str | Path,
    style_path: str | Path,
    output_path: str | Path,
    *,
    strength: float = 1.0,
    max_side: int = 1280,
    device: str = "GPU",
    allow_fallback: bool = False,
    progress_cb: Callable | None = None,
) -> dict[str, Any]:
    """Stylize one content image. Same result-dict shape as the Magenta engine."""
    from .. import job_control
    from ..pathutil import finalize_output_path
    from PIL import Image

    IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}

    content_p = Path(content_path).expanduser().resolve()
    style_p = Path(style_path).expanduser().resolve()
    if not content_p.is_file():
        return {"ok": False, "error": f"content not found: {content_p}"}
    if not style_p.is_file():
        return {"ok": False, "error": f"style not found: {style_p}"}
    strength = float(np.clip(strength, 0.0, 1.0))

    job_control.check_cancelled()
    if progress_cb:
        progress_cb("loading OV style-transfer model…", phase="load")
    try:
        mean, std, settled = encode_style(style_p, device=device, allow_fallback=allow_fallback)
    except Exception as e:  # noqa: BLE001 — HTTP 200 + ok:false downstream
        return {"ok": False, "error": str(e)}
    job_control.check_cancelled()
    if progress_cb:
        progress_cb(
            f"stylize (OV/{settled}) {content_p.name} ← {style_p.name}",
            phase="stylize",
        )
    try:
        content = _resize_max_side(_load_rgb(content_p), int(max_side) if max_side else 0)
        job_control.check_cancelled()
        result = stylize_array(
            content, mean, std, alpha=strength, device=settled,
            allow_fallback=allow_fallback,
        )
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"stylize failed: {e}"}
    job_control.check_cancelled()

    out_path = finalize_output_path(
        output_path,
        source=content_p,
        default_suffix="_styled",
        default_ext=".png",
        allowed_exts=IMAGE_EXTS,
    )
    img = Image.fromarray(result, "RGB")
    ext = out_path.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        img.save(out_path, quality=95)
    else:
        img.save(out_path)
    if progress_cb:
        progress_cb(f"wrote {out_path}", phase="done")
    return {
        "ok": True,
        "output_path": str(out_path),
        "content": str(content_p),
        "style": str(style_p),
        "size": [int(result.shape[1]), int(result.shape[0])],
        "strength": strength,
        "device_settled": settled,
        "engine": "openvino",
    }


def stylize_strength_strip(
    content_path: str | Path,
    style_path: str | Path,
    candidates_dir: str | Path,
    *,
    strengths: list[float],
    max_side: int = 1280,
    device: str = "GPU",
    allow_fallback: bool = False,
    progress_cb: Callable | None = None,
) -> dict[str, Any]:
    """One frame per strength (alpha is a graph input, so each strength is a
    real inference — unlike Magenta's single-pass pixel blend)."""
    from .. import job_control
    from PIL import Image

    content_p = Path(content_path).expanduser().resolve()
    style_p = Path(style_path).expanduser().resolve()
    out_dir = Path(candidates_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    if not content_p.is_file():
        return {"ok": False, "error": f"content not found: {content_p}", "paths": []}
    if not style_p.is_file():
        return {"ok": False, "error": f"style not found: {style_p}", "paths": []}
    if not strengths:
        return {"ok": False, "error": "need at least one strength", "paths": []}

    job_control.check_cancelled()
    if progress_cb:
        progress_cb("loading OV style-transfer model…", phase="load")
    try:
        mean, std, settled = encode_style(style_p, device=device, allow_fallback=allow_fallback)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e), "paths": []}
    content = _resize_max_side(_load_rgb(content_p), int(max_side) if max_side else 0)

    paths: list[str] = []
    n = len(strengths)
    for i, raw_s in enumerate(strengths):
        job_control.check_cancelled()
        st = float(np.clip(raw_s, 0.0, 1.0))
        try:
            rgb = stylize_array(
                content, mean, std, alpha=st, device=settled,
                allow_fallback=allow_fallback,
            )
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"stylize failed: {e}", "paths": paths}
        dest = out_dir / f"frame_{i:06d}.png"
        Image.fromarray(rgb, "RGB").save(dest, format="PNG", compress_level=1)
        paths.append(str(dest))
        if progress_cb:
            progress_cb(
                f"evolve strength {st:.2f} ({i + 1}/{n}, OV/{settled})",
                phase="evolve",
                current=i + 1,
                total=n,
                unit="frames",
                latest_frame=str(dest),
            )
    h, w = content.shape[:2]
    return {
        "ok": True,
        "paths": paths,
        "strengths": [float(np.clip(s, 0, 1)) for s in strengths],
        "size": (int(w), int(h)),
        "device_settled": settled,
        "engine": "openvino",
    }
