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
- inputs: `image` (N,3,512,512) f32 [0,1], `mask` (N,1,512,512) f32,
  1 = inpaint hole (publisher demo convention + synthetic-behavior proof:
  white box under a 1-mask inpaints to background, zero-mask is identity).
- output: `output` (N,3,512,512) f32 [0,255] (max exactly 255.0 observed).
- spatial dims are STATIC 512x512 (audit-2 finding 6 confirmed) so the
  filter letterboxes full frames into a 512 canvas and composites the hole
  back at full res — never stretches surviving pixels (invariant 4).
  Unmasked pixels are bit-preserved (measured mean abs diff 0.0); only
  masked pixels come from the model.

Geometry per frame (input W x H):
- scale s = min(512/W, 512/H, 1.0) — downscale only, never upscale.
- canvas (round(W*s), round(H*s)), BORDER_REFLECT_101 padded to 512x512.
- mask rasterized at FULL res from the normalized rect, dilated +
  blurred by feather_px, downscaled NEAREST to canvas, padded with 0.
- inference output unpadded, resized LINEAR back to W x H, composited:
  out = img*(1-m) + inpainted*m. Output dims = input dims always.
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


def ir_path_for(model_dir: Path | str) -> Path:
    return Path(model_dir).expanduser().resolve() / IR_XML_NAME


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


def get_compiled(model_dir: Path | str, device: str = "GPU") -> tuple[Any, str]:
    """Compile (or hit the lazy per-device cache). Returns (model, settled).

    `device` in GPU|CPU|AUTO. AUTO tries GPU then CPU; the fallback is
    logged and the settled device is returned for the op meta.
    Raises RuntimeError with the setup hint when the IR is missing.
    """
    import openvino as ov

    ir = ir_path_for(model_dir)
    if not ir.is_file():
        raise RuntimeError(
            f"LaMA IR missing at {ir} — open the Watermark tab LaMA Setup "
            f"row (Clean → Watermark → Setup) or POST "
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
        key = f"{ir}::{dev}"
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
) -> np.ndarray:
    """Full-res float32 mask (0..1, 1 = inpaint) from a normalized rect.

    Clamped to frame bounds; feather dilates then softens the edge.
    """
    mx, my, mw, mh = (float(v) for v in mask_rect)
    x0 = max(0, min(w, int(round(mx * w))))
    y0 = max(0, min(h, int(round(my * h))))
    x1 = max(0, min(w, int(round((mx + mw) * w))))
    y1 = max(0, min(h, int(round((my + mh) * h))))
    mask = np.zeros((h, w), dtype=np.float32)
    if x1 > x0 and y1 > y0:
        mask[y0:y1, x0:x1] = 1.0
    f = int(feather_px or 0)
    if f > 0:
        k = 2 * f + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        mask = cv2.dilate(mask, kernel)
        mask = cv2.GaussianBlur(mask, (k, k), 0)
        np.clip(mask, 0.0, 1.0, out=mask)
    return mask


def inpaint_image(
    bgr: np.ndarray,
    mask_full: np.ndarray,
    compiled: Any,
    spec: dict[str, Any],
    *,
    canvas: int = 512,
) -> np.ndarray:
    """Inpaint one BGR uint8 frame; shared by directory + image paths.

    `mask_full` is full-res float32 0..1, `spec` is `introspect_ir()`.
    Returns BGR uint8, same W x H.
    """
    h, w = bgr.shape[:2]
    s = min(canvas / w, canvas / h, 1.0)
    cw, ch = max(1, int(round(w * s))), max(1, int(round(h * s)))
    small_img = cv2.resize(bgr, (cw, ch),
                           interpolation=cv2.INTER_AREA if s < 1.0
                           else cv2.INTER_LINEAR)
    small_msk = cv2.resize(mask_full, (cw, ch),
                           interpolation=cv2.INTER_NEAREST)
    pad_b = canvas - ch
    pad_r = canvas - cw
    canvas_img = cv2.copyMakeBorder(small_img, 0, pad_b, 0, pad_r,
                                    cv2.BORDER_REFLECT_101)
    canvas_msk = cv2.copyMakeBorder(small_msk, 0, pad_b, 0, pad_r,
                                    cv2.BORDER_CONSTANT, value=0.0)
    rgb = cv2.cvtColor(canvas_img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    image_in = np.transpose(rgb, (2, 0, 1))[None]
    mask_in = canvas_msk[None, None, :, :].astype(np.float32)
    out = compiled({spec["image_name"]: image_in,
                    spec["mask_name"]: mask_in})[spec["output_name"]]
    out_rgb = np.transpose(out[0], (1, 2, 0)).astype(np.float32) / 255.0
    np.clip(out_rgb, 0.0, 1.0, out=out_rgb)
    out_small = cv2.resize(out_rgb[:ch, :cw, :], (w, h),
                           interpolation=cv2.INTER_LINEAR)
    out_bgr = cv2.cvtColor(out_small, cv2.COLOR_RGB2BGR)
    m = mask_full[:, :, None]
    base = bgr.astype(np.float32) / 255.0
    comp = base * (1.0 - m) + out_bgr * m
    np.clip(comp, 0.0, 1.0, out=comp)
    return (comp * 255.0 + 0.5).astype(np.uint8)


def clear_compiled_cache() -> None:
    _COMPILED.clear()


async def run_lama_directory(
    src_dir: Path | str,
    dst_dir: Path | str,
    *,
    mask_rect: tuple[float, float, float, float],
    feather_px: int = 1,
    device: str = "GPU",
    model_dir: Path | str | None = None,
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
    spec = introspect_ir(ir_path_for(mdir))
    compiled, settled = await asyncio.to_thread(get_compiled, mdir, device)

    token = job_control.current_token()
    mask_full: np.ndarray | None = None
    px_box: dict[str, int] = {}
    for i, frame_path in enumerate(frames):
        job_control.check_cancelled()
        img = await asyncio.to_thread(cv2.imread, str(frame_path))
        if img is None:
            raise RuntimeError(f"unreadable frame: {frame_path.name}")
        if mask_full is None:
            h, w = img.shape[:2]
            mask_full = rasterize_mask(w, h, mask_rect, feather_px)
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
            return inpaint_image(bgr, m, cm, spec, canvas=spec["size"])

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
            "frame_count": total, "device": settled, "mask_px": px_box}


def make_lama_directory(
    *,
    mask_rect: tuple[float, float, float, float],
    feather_px: int = 1,
    device: str = "GPU",
    model_dir: Path | str | None = None,
    **_extra: Any,
):
    """Factory for the pipeline registry. Returned callable kind=directory."""

    async def directory_fn(src_dir: Path, dst_dir: Path) -> dict[str, Any]:
        return await run_lama_directory(
            src_dir, dst_dir, mask_rect=tuple(float(v) for v in mask_rect),
            feather_px=int(feather_px), device=str(device),
            model_dir=model_dir,
        )

    directory_fn.kind = "directory"  # type: ignore[attr-defined]
    directory_fn.stage_name = "lama"  # type: ignore[attr-defined]
    return directory_fn


register_stage("lama", make_lama_directory)
