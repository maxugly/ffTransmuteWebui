"""Erase tab — lama-cleaner (Sanster/iopaint) erase settings, exact.

Fresh implementation written directly from iopaint's erase path
(`InpaintModel.__call__` / `_pad_forward` / `_run_box`, Apache-2.0):
HD strategies Original/Crop/Resize with iopaint's verbatim defaults
(trigger 800 / margin 128 / resize-limit 1280), binary mask exactly as
drawn (blur is diffusion-only upstream), composite pastes the masked
area only (`mask < 127` keep original).

Adaptations to this box (measured on our weights, not styled):
- Carve/LaMa-ONNX is FIXED 512x512 (their README; dynamic shapes break
  irfft), so every model view is a 512 canvas using IOPaint-style
  downscale-only preparation and symmetric bottom/right padding. The fixed
  ONNX shape is the only adaptation; there is no synthetic hole fill or
  resize heuristic.
- fp16 IR (measured identical to fp32 on GT: 32.6/32.6 — no knob).
- The model sees the original pixels plus the binary mask, as in IOPaint.
  Do not paint a synthetic mean-colored hole into the model input: that
  creates a flat patch for LaMa to continue and is especially visible on
  screenshots. The 512 canvas is only padding for small crops, not a reason
  to resample them.

Filter-platform contract (invariant 1): dump → here (`directory`) →
encode, mid-chain PNG `frame_%06d.png` from 0. In-process OV API only
(invariant 2). Weights under `mtapi-project/junk/models/lama/`
(invariant 8). `report_progress()` every frame (invariant 9).
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Literal

import cv2
import numpy as np

from .. import job_control
from . import register_stage

MODEL_FILENAME = "lama_fp32.onnx"
MODEL_REPO = "https://huggingface.co/Carve/LaMa-ONNX"
MODEL_LICENSE = "Apache-2.0"
IR_XML_NAME = "lama_fp32_fp16.xml"

# Verbatim iopaint InpaintRequest erase defaults.
HD_TRIGGER_DEFAULT = 800
HD_MARGIN_DEFAULT = 128
HD_RESIZE_LIMIT_DEFAULT = 1280
CANVAS = 512

HdStrategy = Literal["Original", "Crop", "Resize"]

_COMPILED: dict[str, Any] = {}
_INTROSPECTED: dict[str, dict[str, Any]] = {}


def erase_model_dir() -> Path:
    """Absolute weights dir: mtapi-project/junk/models/lama (invariant 8)."""
    return (
        Path(__file__).resolve().parent.parent.parent
        / "junk" / "models" / "lama"
    )


def ir_path_for(model_dir: Path | str) -> Path:
    return Path(model_dir).expanduser().resolve() / IR_XML_NAME


def introspect_ir(ir_path: Path | str) -> dict[str, Any]:
    """Static input geometry from the IR (no guessed constants)."""
    import openvino as ov

    key = str(Path(ir_path).resolve())
    hit = _INTROSPECTED.get(key)
    if hit is not None:
        return dict(hit)
    model = ov.Core().read_model(key)
    info: dict[str, Any] = {}
    for inp in model.inputs:
        name = inp.get_any_name()
        shape = [int(d.get_length()) if d.is_static else -1
                 for d in inp.get_partial_shape()]
        info[name] = shape
    names = list(info)
    image_name = next((n for n in names if "image" in n.lower()), names[0])
    mask_name = next((n for n in names if "mask" in n.lower()),
                     names[1] if len(names) > 1 else names[0])
    output_name = model.outputs[0].get_any_name()
    spatial = info[image_name][2:]
    if len(spatial) != 2 or spatial[0] <= 0 or spatial[1] <= 0:
        raise RuntimeError(
            f"Erase IR has non-static spatial dims {spatial} — refusing."
        )
    if spatial[0] != spatial[1]:
        raise RuntimeError(
            f"Erase IR is non-square {spatial} — refusing (unhandled layout)."
        )
    out = {"image_name": image_name, "mask_name": mask_name,
           "output_name": output_name, "size": int(spatial[0])}
    _INTROSPECTED[key] = out
    return dict(out)


def get_compiled(model_dir: Path | str, device: str = "GPU") -> tuple[Any, str]:
    """Compile (or hit the lazy per-device cache). Returns (model, settled)."""
    import openvino as ov

    ir = ir_path_for(model_dir)
    if not ir.is_file():
        raise RuntimeError(
            f"Erase IR missing at {ir} — open the Erase tab Setup row "
            f"(Clean → Erase → Setup) or POST /ops/erase_setup."
        )
    want = (device or "GPU").upper()
    candidates = [want] if want in ("GPU", "CPU") else ["GPU", "CPU"]
    if want not in ("GPU", "CPU") and want != "AUTO":
        raise ValueError(f"device must be GPU|CPU|AUTO, got {device!r}")
    core = ov.Core()
    last_err: Exception | None = None
    for dev in candidates:
        key = f"{ir}::{dev}"
        hit = _COMPILED.get(key)
        if hit is not None:
            return hit, dev
        try:
            compiled = core.compile_model(str(ir), dev)
        except Exception as e:  # noqa: BLE001 — fallback is the contract
            last_err = e
            continue
        if len(_COMPILED) >= 2:
            _COMPILED.pop(next(iter(_COMPILED)))
        _COMPILED[key] = compiled
        return compiled, dev
    raise RuntimeError(
        f"Erase compile failed on {candidates}: {last_err}"
    )


def clear_compiled_cache() -> None:
    _COMPILED.clear()


def draw_mask(w: int, h: int,
              mask_rect: tuple[float, float, float, float]) -> np.ndarray:
    """Binary float32 mask (0/1) from a normalized rect. As drawn — no
    feather, no blur (blur is diffusion-only upstream)."""
    mx, my, mw, mh = (float(v) for v in mask_rect)
    x0 = max(0, min(w, int(round(mx * w))))
    y0 = max(0, min(h, int(round(my * h))))
    x1 = max(0, min(w, int(round((mx + mw) * w))))
    y1 = max(0, min(h, int(round((my + mh) * h))))
    mask = np.zeros((h, w), dtype=np.float32)
    if x1 > x0 and y1 > y0:
        mask[y0:y1, x0:x1] = 1.0
    return mask


def decode_mask_png(raw: bytes, w: int, h: int) -> np.ndarray:
    """Painted mask (white = erase) → binary float32 at frame size.

    Threshold at 127 like iopaint's `boxes_from_mask`/`mask < 127` paste.
    RGBA input (browser canvas): alpha channel decides, so antialiased
    edge RGB can't leak in — transparent is always background.
    """
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("unreadable mask PNG")
    if len(img.shape) == 3 and img.shape[2] == 4:
        alpha = img[:, :, 3]
        if (alpha.shape[1], alpha.shape[0]) != (w, h):
            alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_LINEAR)
        return _solid_mask(alpha, w, h)
    gray = img if len(img.shape) == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if (gray.shape[1], gray.shape[0]) != (w, h):
        gray = cv2.resize(gray, (w, h), interpolation=cv2.INTER_LINEAR)
    return _solid_mask(gray, w, h)


def _solid_mask(mask: np.ndarray, w: int, h: int) -> np.ndarray:
    """Fill only holes enclosed by a browser-painted erase mask."""
    if (mask.shape[1], mask.shape[0]) != (w, h):
        mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_LINEAR)
    binary = (mask > 127).astype(np.uint8)
    outside = binary.copy()
    flood = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(outside, flood, (0, 0), 1)
    binary[(binary == 0) & (outside == 0)] = 1
    return binary.astype(np.float32)


def crop_window(w: int, h: int, mask: np.ndarray,
                margin: int) -> dict[str, int] | None:
    """Edge-compensated context window (iopaint `_crop_box`).

    Centered on the mask bbox, expanded by `margin` per side; shifted (not
    shrunk) at frame edges. None when the window is the whole frame.
    """
    m = max(0, int(margin))
    ys, xs = np.nonzero(mask > 0)
    if xs.size == 0:
        return None
    bw = int(xs.max()) + 1 - int(xs.min())
    bh = int(ys.max()) + 1 - int(ys.min())
    cx = (int(xs.min()) + int(xs.max()) + 1) // 2
    cy = (int(ys.min()) + int(ys.max()) + 1) // 2
    w2, h2 = bw + 2 * m, bh + 2 * m
    x0 = max(0, min(w - w2, cx - w2 // 2)) if w2 < w else 0
    y0 = max(0, min(h - h2, cy - h2 // 2)) if h2 < h else 0
    x1, y1 = min(w, x0 + w2), min(h, y0 + h2)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return None
    if x0 <= 0 and y0 <= 0 and x1 >= w and y1 >= h:
        return None
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _infer_canvas(compiled: Any, spec: dict[str, Any],
                  canvas_bgr: np.ndarray,
                  canvas_bin: np.ndarray) -> np.ndarray:
    """One fixed-512 OV inference. Returns BGR float32 [0,1] model view."""
    rgb = cv2.cvtColor(canvas_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    image_in = np.transpose(rgb, (2, 0, 1))[None].copy()
    mask_in = canvas_bin[None, None, :, :].astype(np.float32)
    out = compiled({spec["image_name"]: image_in,
                    spec["mask_name"]: mask_in})[spec["output_name"]]
    view = np.transpose(out[0], (1, 2, 0)).astype(np.float32) / 255.0
    np.clip(view, 0.0, 1.0, out=view)
    return cv2.cvtColor(view, cv2.COLOR_RGB2BGR)


def run_view(bgr: np.ndarray, mask_bin: np.ndarray,
             compiled: Any, spec: dict[str, Any]) -> np.ndarray:
    """Run the Carve export with IOPaint's image preparation semantics.

    IOPaint only downsizes when a limit requires it; it does not upscale a
    small crop. Its padding is symmetric (top/left pixels are not shifted),
    so the fixed 512 ONNX shape is filled with symmetric padding here. The
    model is still called exactly once at 512x512.
    """
    h, w = bgr.shape[:2]
    s = min(CANVAS / w, CANVAS / h, 1.0)
    cw, ch = max(1, int(round(w * s))), max(1, int(round(h * s)))
    interp = cv2.INTER_AREA if s < 1.0 else cv2.INTER_LINEAR
    # Match IOPaint: keep the source image intact and let the binary mask
    # tell LaMa which pixels to reconstruct. In particular, do not replace
    # the hole with a mean color; that produces a visible flat/blurred patch
    # when the 512 model is used on a screenshot watermark.
    small_img = cv2.resize(bgr, (cw, ch), interpolation=interp)
    small_msk = cv2.resize(mask_bin, (cw, ch),
                           interpolation=cv2.INTER_NEAREST)
    canvas_img = cv2.copyMakeBorder(small_img, 0, CANVAS - ch, 0, CANVAS - cw,
                                    cv2.BORDER_REFLECT)
    canvas_msk = cv2.copyMakeBorder(small_msk, 0, CANVAS - ch, 0, CANVAS - cw,
                                    cv2.BORDER_REFLECT)
    canvas_bin = (canvas_msk > 0.5).astype(np.float32)
    view = _infer_canvas(compiled, spec, canvas_img, canvas_bin)
    back = cv2.resize(view[:ch, :cw, :], (w, h),
                      interpolation=cv2.INTER_LINEAR)
    np.clip(back, 0.0, 1.0, out=back)
    return back


def composite(src_bgr: np.ndarray, model_view: np.ndarray,
              mask_bin: np.ndarray) -> np.ndarray:
    """Paste the masked area only (`mask < 127` keep original)."""
    base = src_bgr.astype(np.float32) / 255.0
    m = (mask_bin > 0.5).astype(np.float32)[:, :, None]
    comp = base * (1.0 - m) + np.clip(model_view, 0.0, 1.0) * m
    np.clip(comp, 0.0, 1.0, out=comp)
    return (comp * 255.0 + 0.5).astype(np.uint8)


def inpaint_frame(bgr: np.ndarray, mask_bin: np.ndarray,
                  compiled: Any, spec: dict[str, Any],
                  hd_strategy: str = "Crop",
                  crop_trigger: int = HD_TRIGGER_DEFAULT,
                  crop_margin: int = HD_MARGIN_DEFAULT,
                  resize_limit: int = HD_RESIZE_LIMIT_DEFAULT) -> np.ndarray:
    """One frame through the HD strategy. Returns BGR uint8, same W x H."""
    h, w = bgr.shape[:2]
    mode = (hd_strategy or "Crop").capitalize()
    if mode not in ("Original", "Crop", "Resize"):
        raise ValueError(
            f"hd_strategy must be Original|Crop|Resize, got {hd_strategy!r}")

    if mode == "Resize" and max(w, h) > int(resize_limit):
        ratio = float(resize_limit) / max(w, h)
        nw, nh = max(8, int(w * ratio)), max(8, int(h * ratio))
        small = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_CUBIC)
        # IOPaint keeps erase masks binary. Cubic mask resampling can create
        # a larger/softer effective brush before thresholding.
        msmall = cv2.resize(mask_bin, (nw, nh), interpolation=cv2.INTER_NEAREST)
        view = run_view(small, msmall.astype(np.float32),
                        compiled, spec)
        back = cv2.resize(view, (w, h), interpolation=cv2.INTER_CUBIC)
        return composite(bgr, back, (mask_bin > 0.5).astype(np.float32))

    box = None
    if mode == "Crop" and max(w, h) > int(crop_trigger):
        box = crop_window(w, h, mask_bin, int(crop_margin))
    if box is None:
        return composite(bgr, run_view(bgr, mask_bin, compiled, spec),
                         mask_bin)
    x0, y0, x1, y1 = box["x0"], box["y0"], box["x1"], box["y1"]
    view = run_view(bgr[y0:y1, x0:x1], mask_bin[y0:y1, x0:x1],
                    compiled, spec)
    done = bgr.copy()
    done[y0:y1, x0:x1] = composite(bgr[y0:y1, x0:x1], view,
                                   mask_bin[y0:y1, x0:x1])
    return done


async def run_erase_directory(
    src_dir: Path | str,
    dst_dir: Path | str,
    *,
    mask_png: bytes | None = None,
    mask_rect: tuple[float, float, float, float] | None = None,
    hd_strategy: str = "Crop",
    crop_trigger: int = HD_TRIGGER_DEFAULT,
    crop_margin: int = HD_MARGIN_DEFAULT,
    resize_limit: int = HD_RESIZE_LIMIT_DEFAULT,
    device: str = "GPU",
    model_dir: Path | str | None = None,
    debug_mask_path: Path | str | None = None,
) -> dict[str, Any]:
    """Directory stage body: one fixed mask, erase per frame.

    Painted `mask_png` wins when present, else the `mask_rect` fallback.
    """
    src = Path(src_dir).resolve()
    dst = Path(dst_dir).resolve()
    dst.mkdir(parents=True, exist_ok=True)
    frames = sorted(src.glob("frame_*.png"))
    if not frames:
        frames = sorted(src.glob("*.png"))
    total = len(frames)
    if total <= 0:
        raise RuntimeError(f"No PNG frames in {src}")
    if mask_png is None and mask_rect is None:
        raise RuntimeError("erase needs a painted mask or a rect fallback")

    mdir = Path(model_dir).expanduser().resolve() if model_dir else erase_model_dir()
    spec = introspect_ir(ir_path_for(mdir))
    compiled, settled = await asyncio.to_thread(get_compiled, mdir, device)

    token = job_control.current_token()
    mask_bin: np.ndarray | None = None
    if mask_png is not None:
        probe = await asyncio.to_thread(cv2.imread, str(frames[0]))
        if probe is None:
            raise RuntimeError(f"unreadable frame: {frames[0].name}")
        ph, pw = probe.shape[:2]
        mask_bin = decode_mask_png(mask_png, pw, ph)
        if not (mask_bin > 0).any():
            raise RuntimeError("painted mask is empty — paint the watermark first")
        px_box = {"frame_w": pw, "frame_h": ph, "painted": True}
    if debug_mask_path is not None:
        if mask_bin is None:
            probe = await asyncio.to_thread(cv2.imread, str(frames[0]))
            if probe is None:
                raise RuntimeError(f"unreadable frame: {frames[0].name}")
            ph, pw = probe.shape[:2]
            assert mask_rect is not None
            mask_bin = draw_mask(pw, ph, mask_rect)
            px_box = {"frame_w": pw, "frame_h": ph, "painted": False}
        debug_path = Path(debug_mask_path).expanduser().resolve()
        debug_path.parent.mkdir(parents=True, exist_ok=True)
        if not await asyncio.to_thread(
            cv2.imwrite, str(debug_path), (mask_bin * 255).astype(np.uint8)
        ):
            raise RuntimeError(f"could not write debug mask {debug_path}")
    for i, frame_path in enumerate(frames):
        job_control.check_cancelled()
        img = await asyncio.to_thread(cv2.imread, str(frame_path))
        if img is None:
            raise RuntimeError(f"unreadable frame: {frame_path.name}")
        h, w = img.shape[:2]
        if mask_bin is None:
            assert mask_rect is not None
            mask_bin = draw_mask(w, h, mask_rect)
            mx, my, mw, mh = (float(v) for v in mask_rect)
            px_box = {
                "x": max(0, min(w, int(round(mx * w)))),
                "y": max(0, min(h, int(round(my * h)))),
                "w": max(0, min(w, int(round((mx + mw) * w)))
                         - max(0, min(w, int(round(mx * w))))),
                "h": max(0, min(h, int(round((my + mh) * h)))
                         - max(0, min(h, int(round(my * h))))),
                "frame_w": w, "frame_h": h, "painted": False,
            }
        elif (w, h) != (px_box["frame_w"], px_box["frame_h"]):
            raise RuntimeError(
                f"frame size changed mid-sequence "
                f"({px_box['frame_w']}x{px_box['frame_h']} → {w}x{h}) — "
                f"static-mask erase needs uniform frames."
            )
        if mask_png is not None and mask_bin.shape != (h, w):
            mask_bin = cv2.resize(
                mask_bin, (w, h), interpolation=cv2.INTER_NEAREST)

        def _infer(bgr: np.ndarray = img,
                   m: np.ndarray = mask_bin,
                   cm: Any = compiled) -> np.ndarray:
            if token:
                job_control.bind(token)
            return inpaint_frame(bgr, m, cm, spec,
                                 hd_strategy=hd_strategy,
                                 crop_trigger=int(crop_trigger),
                                 crop_margin=int(crop_margin),
                                 resize_limit=int(resize_limit))

        done = await asyncio.to_thread(_infer)
        ok = await asyncio.to_thread(cv2.imwrite,
                                     str(dst / frame_path.name), done)
        if not ok:
            raise RuntimeError(f"could not write {dst / frame_path.name}")
        if token:
            job_control.report_progress(
                f"erase {i + 1}/{total} frames",
                phase="erase", current=i + 1, total=total, unit="frames",
                token=token, latest_frame=str(dst / frame_path.name),
            )
    if token:
        job_control.report_progress(
            f"erase done: {total} frames",
            phase="erase", current=total, total=total, unit="frames",
            token=token, watch_dir=str(dst), watch_count=total,
        )
    return {"frame_count_in": total, "frame_count_out": total,
            "frame_count": total, "device": settled, "mask_px": px_box,
            "hd_strategy": (hd_strategy or "Crop").capitalize()}


def make_erase_directory(
    *,
    mask_png: bytes | None = None,
    mask_rect: tuple[float, float, float, float] | None = None,
    hd_strategy: str = "Crop",
    crop_trigger: int = HD_TRIGGER_DEFAULT,
    crop_margin: int = HD_MARGIN_DEFAULT,
    resize_limit: int = HD_RESIZE_LIMIT_DEFAULT,
    device: str = "GPU",
    model_dir: Path | str | None = None,
    debug_mask_path: Path | str | None = None,
    **_extra: Any,
):
    """Factory for the pipeline registry. Returned callable kind=directory."""

    async def directory_fn(src_dir: Path, dst_dir: Path) -> dict[str, Any]:
        rect = (tuple(float(v) for v in mask_rect)
                if mask_rect is not None else None)
        return await run_erase_directory(
            src_dir, dst_dir, mask_png=mask_png, mask_rect=rect,
            hd_strategy=str(hd_strategy), crop_trigger=int(crop_trigger),
            crop_margin=int(crop_margin), resize_limit=int(resize_limit),
            device=str(device), model_dir=model_dir,
            debug_mask_path=debug_mask_path,
        )

    directory_fn.kind = "directory"  # type: ignore[attr-defined]
    directory_fn.stage_name = "erase"  # type: ignore[attr-defined]
    return directory_fn


register_stage("erase", make_erase_directory)
