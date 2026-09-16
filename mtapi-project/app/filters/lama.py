"""LaMA inpaint directory stage — user-drawn static rectangle removal.

Engine `lama-openvino` (Watermark tab engine #2): dump →
`app/filters/lama.py` (`directory`) → encode, mid-chain PNG
`frame_%06d.png` from 0 (invariant 1).

Model: `Carve/LaMa-ONNX` `lama_fp32.onnx` (Apache-2.0, big-LaMA port),
converted once by setup to FP16 OpenVINO IR under
`mtapi-project/junk/models/lama/` (invariant 8). Runtime only compiles +
infers (in-process OV API; only subprocesses are the ffmpeg bookends owned
by `run_staged_job` — invariant 2).

Build-time introspection (2026-09-15, ov 2026.3.1, `available_devices ==
['CPU', 'GPU']`, `ov.Core().read_model` on the downloaded file):
- inputs: `image` (N,3,512,512) f32 [0,1], `mask` (N,1,512,512) f32 BINARY,
  1 = inpaint hole (soft/feathered values collapse the fill toward
  mid-intensity — proven 2026-09-16 — so `_run_canvas` binarizes at 0.5;
  publisher demo convention + synthetic-behavior proof: white box under a
  1-mask inpaints to background, zero-mask is identity).
- output: `output` (N,3,512,512) f32 [0,255] (max exactly 255.0 observed).
- spatial dims are STATIC 512x512 (audit-2 finding 6 confirmed) so the
  filter letterboxes full frames into a 512 canvas and composites the hole
  back at full res — never stretches surviving pixels (invariant 4).
  Unmasked pixels are bit-preserved (measured mean abs diff 0.0); only
  masked pixels come from the model.

Fixed-512 handling (exact path, no stretch of surviving pixels):
- every inference input is a 512x512 canvas built as: take the source
  array (full frame, or context crop), scale by
  s = min(512/W, 512/H, 1.0) — downscale only, never upscale — then
  BORDER_REFLECT_101 pad right/bottom to exactly 512x512. The mask is
  rasterized at source res, downscaled NEAREST, padded with 0.
- model output (0..255) is unpadded, resized LINEAR back to source size,
  and composited: out = src*(1-m) + model*m. Composite-only-inside-mask:
  where the feathered mask is 0 the output IS the source pixel (exact);
  the model contributes only where m > 0.

Context-crop inference (default; full-frame is the fallback):
- the feathered mask bbox is expanded by margin_px (default 32) per side
  and clamped to the frame; inference runs on that crop only, pasted back
  at its origin. A small corner watermark keeps near-native resolution
  through the fixed 512 bottleneck instead of being downscaled away with
  the whole frame.
- fallback to full-frame when margin_px <= 0, the mask is empty, or the
  expanded crop covers the whole frame.
- upscale_max (>1.0) lets small inputs upscale into the canvas (CUBIC)
  for extra model detail; 1.0 = downscale-only, legacy.

Finish pipeline (all optional, all composite-aware):
- blend linear (alpha) | poisson (seamlessClone) | mono (monochrome
  transfer: fill texture, source color — the lighter-box fix).
- sharpen (unsharp amount on the filled region) + sharpen_radius.
- color_match (per-channel mean/std of the fill matched to the ring).
- Model-bound mask is binarized at mask_thresh (default 0.5): soft masks
  collapse the LaMA fill toward mid-intensity (root-caused 2026-09-16).

Geometry per frame (input W x H):
- scale s = min(512/W, 512/H, 1.0) — downscale only, never upscale.
- canvas (round(W*s), round(H*s)), BORDER_REFLECT_101 padded to 512x512.
- mask rasterized at source res from the normalized rect, dilated +
  blurred by feather_px, downscaled NEAREST to canvas, padded with 0.
- inference output unpadded, resized LINEAR back to source W x H,
  composited: out = src*(1-m) + model*m. Output dims = input dims always.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .. import job_control
from . import register_stage

MODEL_FILENAME = "lama_fp32.onnx"
MODEL_REPO = "https://huggingface.co/Carve/LaMa-ONNX"
MODEL_LICENSE = "Apache-2.0"
IR_XML_NAME = "lama_fp32_fp16.xml"
IR_FP32_XML_NAME = "lama_fp32_fp32.xml"

BLEND_MODES = ("linear", "poisson", "mono")
PRECISIONS = ("fp16", "fp32")

# Lazy compiled-model cache: device -> compiled model. Max ~2 entries, no
# pre-compile at boot (16 GB shared-RAM box).
_COMPILED: "OrderedDict[str, Any]" = OrderedDict()
_INTROSPECTED: dict[str, dict[str, Any]] = {}


def lama_model_dir() -> Path:
    """Absolute weights dir: mtapi-project/junk/models/lama (invariant 8)."""
    return (
        Path(__file__).resolve().parent.parent.parent
        / "junk" / "models" / "lama"
    )


def ir_path_for(model_dir: Path | str, precision: str = "fp16") -> Path:
    name = IR_XML_NAME if (precision or "fp16").lower() != "fp32" \
        else IR_FP32_XML_NAME
    return Path(model_dir).expanduser().resolve() / name


def introspect_ir(ir_path: Path | str) -> dict[str, Any]:
    """Read static input geometry from the IR (no guessed constants).

    Returns {image_name, mask_name, output_name, size} where size is the
    static spatial edge (512 for Carve/LaMa-ONNX). Raises when the graph is
    not static-spatial (builder must handle, never silently stretch).
    """
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
            f"LaMA IR has non-static spatial dims {spatial} — refusing "
            f"(would need stretch; invariant 4)."
        )
    if spatial[0] != spatial[1]:
        raise RuntimeError(
            f"LaMA IR is non-square {spatial} — refusing (unhandled layout)."
        )
    out = {"image_name": image_name, "mask_name": mask_name,
           "output_name": output_name, "size": int(spatial[0])}
    _INTROSPECTED[key] = out
    return dict(out)


def get_compiled(model_dir: Path | str, device: str = "GPU",
                 precision: str = "fp16") -> tuple[Any, str]:
    """Compile (or hit the lazy per-device+precision cache).

    `device` in GPU|CPU|AUTO, `precision` in fp16|fp32. Returns (model, settled).
    Raises RuntimeError with the setup hint when the IR is missing.
    """
    import openvino as ov

    prec = (precision or "fp16").lower()
    if prec not in PRECISIONS:
        raise ValueError(f"precision must be fp16|fp32, got {precision!r}")
    ir = ir_path_for(model_dir, prec)
    if not ir.is_file():
        raise RuntimeError(
            f"LaMA {prec} IR missing at {ir} — re-run the Watermark tab LaMA "
            f"Setup row (Clean → Watermark → Setup) or POST "
            f"/ops/watermark_lama_setup."
        )
    want = (device or "GPU").upper()
    tried: list[str] = []
    candidates = [want] if want in ("GPU", "CPU") else ["GPU", "CPU"]
    if want not in ("GPU", "CPU") and want != "AUTO":
        raise ValueError(f"device must be GPU|CPU|AUTO, got {device!r}")
    core = ov.Core()
    last_err: Exception | None = None
    for dev in candidates:
        key = f"{ir}::{prec}::{dev}"
        hit = _COMPILED.get(key)
        if hit is not None:
            _COMPILED.move_to_end(key)
            return hit, dev
        try:
            compiled = core.compile_model(str(ir), dev)
        except Exception as e:  # noqa: BLE001 — fallback is the contract
            tried.append(dev)
            last_err = e
            continue
        _COMPILED[key] = compiled
        while len(_COMPILED) > 2:
            _COMPILED.popitem(last=False)
        if dev != want and want == "AUTO":
            print(f"[lama] device {tried[0] if tried else dev} unavailable "
                  f"({last_err}); settled on {dev}")
        return compiled, dev
    raise RuntimeError(
        f"LaMA compile failed on {candidates} (tried {tried}): {last_err}"
    )


def clear_compiled_cache() -> None:
    _COMPILED.clear()


def rasterize_mask(
    w: int, h: int,
    mask_rect: tuple[float, float, float, float],
    feather_px: int = 1,
    grow_px: int = 0,
) -> np.ndarray:
    """Full-res float32 mask (0..1, 1 = inpaint) from a normalized rect.

    Clamped to frame bounds; `grow_px` hard-dilates first (swallows
    antialiased text-edge halos), then feather dilates + softens the edge.
    """
    mx, my, mw, mh = (float(v) for v in mask_rect)
    x0 = max(0, min(w, int(round(mx * w))))
    y0 = max(0, min(h, int(round(my * h))))
    x1 = max(0, min(w, int(round((mx + mw) * w))))
    y1 = max(0, min(h, int(round((my + mh) * h))))
    mask = np.zeros((h, w), dtype=np.float32)
    if x1 > x0 and y1 > y0:
        mask[y0:y1, x0:x1] = 1.0
    g = int(grow_px or 0)
    if g > 0 and (mask > 0).any():
        gk = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * g + 1, 2 * g + 1))
        mask = cv2.dilate(mask, gk)
    f = int(feather_px or 0)
    if f > 0:
        k = 2 * f + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        mask = cv2.dilate(mask, kernel)
        mask = cv2.GaussianBlur(mask, (k, k), 0)
        np.clip(mask, 0.0, 1.0, out=mask)
    return mask


def compute_crop_box(
    w: int, h: int,
    mask: np.ndarray,
    margin_px: int = 32,
) -> dict[str, int] | None:
    """Context window around the feathered mask, expanded + clamped.

    Returns {x0, y0, x1, y1} or None when the crop path must fall back to
    full-frame (empty mask, or the expanded window covers the whole frame).
    """
    m = int(margin_px or 0)
    if m <= 0:
        return None
    ys, xs = np.nonzero(mask > 0)
    if xs.size == 0:
        return None
    x0 = max(0, int(xs.min()) - m)
    y0 = max(0, int(ys.min()) - m)
    x1 = min(w, int(xs.max()) + 1 + m)
    y1 = min(h, int(ys.max()) + 1 + m)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return None
    if x0 <= 0 and y0 <= 0 and x1 >= w and y1 >= h:
        return None  # no savings, no quality gain — full-frame fallback
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _run_canvas(
    bgr: np.ndarray,
    mask: np.ndarray,
    compiled: Any,
    spec: dict[str, Any],
    canvas: int,
    *,
    blend: str = "linear",
    sharpen: float = 0.0,
    sharpen_radius: float = 1.0,
    color_match: bool = False,
    mask_thresh: float = 0.5,
    upscale_max: float = 1.0,
) -> np.ndarray:
    """Fixed-512 canvas pipeline on an arbitrary BGR array.

    Letterbox (downscale-only by default, reflect pad) → OV infer (BINARY
    mask) → unpad → resize back → finish pipeline → composite. Returns BGR
    uint8, same size as input.

    Finish controls:
    - blend: "linear" (alpha composite), "poisson" (seamlessClone normal —
      texture + color from the fill), "mono" (monochrome transfer — fill
      texture, source color; the fix for a "lighter box").
    - sharpen: unsharp amount on the filled region (0 = off).
    - color_match: shift/scale the filled region's per-channel mean/std to
      the surrounding ring (kills flat-tint mismatch).
    - mask_thresh: binarization point of the model-bound mask.
    - upscale_max: allow upscaling small inputs up to this factor (detail
      for tiny watermarks; 1.0 = downscale-only, legacy).
    """
    mode = (blend or "linear").lower()
    if mode not in BLEND_MODES:
        raise ValueError(f"blend must be {'|'.join(BLEND_MODES)}, got {blend!r}")
    up = max(1.0, float(upscale_max or 1.0))
    h, w = bgr.shape[:2]
    s = min(canvas / w, canvas / h, up)
    cw, ch = max(1, int(round(w * s))), max(1, int(round(h * s)))
    interp = cv2.INTER_AREA if s < 1.0 else (
        cv2.INTER_LINEAR if s <= 1.0 else cv2.INTER_CUBIC)
    small_img = cv2.resize(bgr, (cw, ch), interpolation=interp)
    small_msk = cv2.resize(mask, (cw, ch),
                           interpolation=cv2.INTER_NEAREST)
    pad_b = canvas - ch
    pad_r = canvas - cw
    canvas_img = cv2.copyMakeBorder(small_img, 0, pad_b, 0, pad_r,
                                    cv2.BORDER_REFLECT_101)
    canvas_msk = cv2.copyMakeBorder(small_msk, 0, pad_b, 0, pad_r,
                                    cv2.BORDER_CONSTANT, value=0.0)
    rgb = cv2.cvtColor(canvas_img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    image_in = np.transpose(rgb, (2, 0, 1))[None]
    thr = min(0.9, max(0.1, float(mask_thresh)))
    mask_in = (canvas_msk > thr)[None, None, :, :].astype(np.float32)
    out = compiled({spec["image_name"]: image_in,
                    spec["mask_name"]: mask_in})[spec["output_name"]]
    out_rgb = np.transpose(out[0], (1, 2, 0)).astype(np.float32) / 255.0
    np.clip(out_rgb, 0.0, 1.0, out=out_rgb)
    out_small = cv2.resize(out_rgb[:ch, :cw, :], (w, h),
                           interpolation=cv2.INTER_LINEAR)
    out_bgr = cv2.cvtColor(out_small, cv2.COLOR_RGB2BGR)
    m = mask[:, :, None]
    base = bgr.astype(np.float32) / 255.0
    hole_bin = (mask > thr).astype(np.uint8)
    if mode == "linear" or not hole_bin.any():
        comp = base * (1.0 - m) + out_bgr * m
    else:
        flag = (cv2.NORMAL_CLONE if mode == "poisson"
                else cv2.MONOCHROME_TRANSFER)
        base8 = (np.clip(base, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        fill8 = (np.clip(out_bgr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        mask8 = (hole_bin * 255).astype(np.uint8)
        mom = cv2.moments(mask8)
        cx, cy = int(mom["m10"] / mom["m00"]), int(mom["m01"] / mom["m00"])
        comp = cv2.seamlessClone(fill8, base8, mask8, (cx, cy),
                                 flag).astype(np.float32) / 255.0
    amt = max(0.0, float(sharpen or 0.0))
    if amt > 0 and hole_bin.any():
        sig = min(3.0, max(0.5, float(sharpen_radius or 1.0)))
        blur = cv2.GaussianBlur(comp, (0, 0), sig)
        sharp = comp + amt * (comp - blur)
        np.clip(sharp, 0.0, 1.0, out=sharp)
        comp = comp * (1.0 - m) + sharp * m
    if color_match and hole_bin.any():
        ring = cv2.dilate(hole_bin,
                          cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7)))
        ring = ((ring > 0) & (hole_bin == 0))
        if ring.any():
            matched = comp.copy()
            for c in range(3):
                hole_px = comp[:, :, c][hole_bin > 0]
                ring_px = base[:, :, c][ring]
                mh, sh = float(hole_px.mean()), float(hole_px.std())
                mr, sr = float(ring_px.mean()), float(ring_px.std())
                gain = (sr / sh) if sh > 1e-3 else 0.0
                gain = min(4.0, max(0.25, gain))
                matched[:, :, c] = (comp[:, :, c] - mh) * gain + mr
            np.clip(matched, 0.0, 1.0, out=matched)
            comp = comp * (1.0 - m) + matched * m
    np.clip(comp, 0.0, 1.0, out=comp)
    return (comp * 255.0 + 0.5).astype(np.uint8)


def inpaint_image(
    bgr: np.ndarray,
    mask_full: np.ndarray,
    compiled: Any,
    spec: dict[str, Any],
    *,
    canvas: int = 512,
    margin_px: int = 0,
    blend: str = "linear",
    sharpen: float = 0.0,
    sharpen_radius: float = 1.0,
    color_match: bool = False,
    mask_thresh: float = 0.5,
    upscale_max: float = 1.0,
) -> np.ndarray:
    """Inpaint one BGR uint8 frame; shared by directory + image paths.

    `mask_full` is full-res float32 0..1, `spec` is `introspect_ir()`.
    With margin_px > 0 inference runs on the expanded mask bbox only and
    is pasted back at its origin (full-frame fallback otherwise).
    `blend`/`sharpen`/`color_match` form the finish pipeline (see
    `_run_canvas`). Returns BGR uint8, same W x H.
    """
    h, w = bgr.shape[:2]
    box = compute_crop_box(w, h, mask_full, margin_px) if margin_px > 0 else None
    finish = dict(blend=blend, sharpen=sharpen,
                  sharpen_radius=sharpen_radius, color_match=color_match,
                  mask_thresh=mask_thresh, upscale_max=upscale_max)
    if box is None:
        return _run_canvas(bgr, mask_full, compiled, spec, canvas, **finish)
    x0, y0, x1, y1 = box["x0"], box["y0"], box["x1"], box["y1"]
    crop = _run_canvas(bgr[y0:y1, x0:x1], mask_full[y0:y1, x0:x1],
                       compiled, spec, canvas, **finish)
    done = bgr.copy()
    done[y0:y1, x0:x1] = crop
    return done


async def run_lama_directory(
    src_dir: Path | str,
    dst_dir: Path | str,
    *,
    mask_rect: tuple[float, float, float, float],
    feather_px: int = 1,
    grow_px: int = 0,
    device: str = "GPU",
    precision: str = "fp16",
    model_dir: Path | str | None = None,
    margin_px: int = 32,
    blend: str = "linear",
    sharpen: float = 0.0,
    sharpen_radius: float = 1.0,
    color_match: bool = False,
    mask_thresh: float = 0.5,
    upscale_max: float = 1.0,
) -> dict[str, Any]:
    """Directory stage body: one fixed mask, LaMA per frame."""
    src = Path(src_dir).resolve()
    dst = Path(dst_dir).resolve()
    dst.mkdir(parents=True, exist_ok=True)
    frames = sorted(src.glob("frame_*.png"))
    if not frames:
        frames = sorted(src.glob("*.png"))
    total = len(frames)
    if total <= 0:
        raise RuntimeError(f"No PNG frames in {src}")

    mdir = Path(model_dir).expanduser().resolve() if model_dir else lama_model_dir()
    spec = introspect_ir(ir_path_for(mdir, precision))
    compiled, settled = await asyncio.to_thread(
        get_compiled, mdir, device, precision)

    token = job_control.current_token()
    mask_full: np.ndarray | None = None
    px_box: dict[str, int] = {}
    crop_box: dict[str, int] | None = None
    margin = int(margin_px or 0)
    for i, frame_path in enumerate(frames):
        job_control.check_cancelled()
        img = await asyncio.to_thread(cv2.imread, str(frame_path))
        if img is None:
            raise RuntimeError(f"unreadable frame: {frame_path.name}")
        if mask_full is None:
            h, w = img.shape[:2]
            mask_full = rasterize_mask(w, h, mask_rect, feather_px, grow_px)
            mx, my, mw, mh = (float(v) for v in mask_rect)
            px_box = {
                "x": max(0, min(w, int(round(mx * w)))),
                "y": max(0, min(h, int(round(my * h)))),
                "w": max(0, min(w, int(round((mx + mw) * w)))
                         - max(0, min(w, int(round(mx * w))))),
                "h": max(0, min(h, int(round((my + mh) * h)))
                         - max(0, min(h, int(round(my * h))))),
                "frame_w": w, "frame_h": h,
            }
            crop_box = compute_crop_box(w, h, mask_full, margin)
        else:
            h, w = img.shape[:2]
            if (w, h) != (px_box["frame_w"], px_box["frame_h"]):
                raise RuntimeError(
                    f"frame size changed mid-sequence "
                    f"({px_box['frame_w']}x{px_box['frame_h']} → {w}x{h}) — "
                    f"static-rect LaMA needs uniform frames."
                )

        def _infer(bgr: np.ndarray = img,
                   m: np.ndarray = mask_full,
                   cm: Any = compiled) -> np.ndarray:
            if token:
                job_control.bind(token)
            return inpaint_image(bgr, m, cm, spec, canvas=spec["size"],
                                 margin_px=margin, blend=blend,
                                 sharpen=sharpen,
                                 sharpen_radius=sharpen_radius,
                                 color_match=color_match,
                                 mask_thresh=mask_thresh,
                                 upscale_max=upscale_max)

        done = await asyncio.to_thread(_infer)
        ok = await asyncio.to_thread(cv2.imwrite,
                                     str(dst / frame_path.name), done)
        if not ok:
            raise RuntimeError(f"could not write {dst / frame_path.name}")
        if token:
            job_control.report_progress(
                f"lama {i + 1}/{total} frames",
                phase="lama", current=i + 1, total=total, unit="frames",
                token=token, latest_frame=str(dst / frame_path.name),
            )
    if token:
        job_control.report_progress(
            f"lama done: {total} frames",
            phase="lama", current=total, total=total, unit="frames",
            token=token, watch_dir=str(dst), watch_count=total,
        )
    return {"frame_count_in": total, "frame_count_out": total,
            "frame_count": total, "device": settled, "mask_px": px_box,
            "margin_px": margin, "crop_box": crop_box, "blend": blend,
            "precision": (precision or "fp16").lower()}


def make_lama_directory(
    *,
    mask_rect: tuple[float, float, float, float],
    feather_px: int = 1,
    grow_px: int = 0,
    device: str = "GPU",
    precision: str = "fp16",
    model_dir: Path | str | None = None,
    margin_px: int = 32,
    blend: str = "linear",
    sharpen: float = 0.0,
    sharpen_radius: float = 1.0,
    color_match: bool = False,
    mask_thresh: float = 0.5,
    upscale_max: float = 1.0,
    **_extra: Any,
):
    """Factory for the pipeline registry. Returned callable kind=directory."""

    async def directory_fn(src_dir: Path, dst_dir: Path) -> dict[str, Any]:
        return await run_lama_directory(
            src_dir, dst_dir, mask_rect=tuple(float(v) for v in mask_rect),
            feather_px=int(feather_px), grow_px=int(grow_px),
            device=str(device), precision=str(precision),
            model_dir=model_dir, margin_px=int(margin_px),
            blend=str(blend), sharpen=float(sharpen),
            sharpen_radius=float(sharpen_radius),
            color_match=bool(color_match),
            mask_thresh=float(mask_thresh),
            upscale_max=float(upscale_max),
        )

    directory_fn.kind = "directory"  # type: ignore[attr-defined]
    directory_fn.stage_name = "lama"  # type: ignore[attr-defined]
    return directory_fn


register_stage("lama", make_lama_directory)
