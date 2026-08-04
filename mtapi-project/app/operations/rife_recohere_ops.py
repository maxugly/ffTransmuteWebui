"""RIFE Recoherence — RIFE M=2 on two stills + OpenVINO img2img on every mid."""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from PIL import Image
from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path

IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"})
VIDEO_EXTS = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"})

DEFAULT_POSITIVE = (
    "a single coherent object, well-composed scene, centered, sharp focus, "
    "highly detailed, intricate details, volumetric lighting, masterpiece, "
    "best quality, photorealistic"
)
DEFAULT_NEGATIVE = (
    "blurry, lowres, duplicate, double image, two images, split screen, "
    "collage, double exposure, ghosting, transparent, deformed, messy, "
    "incoherent, watermark, text"
)


class RifeRecohereParams(BaseModel):
    image_a: str = Field(..., description="First still (absolute path preferred)")
    image_b: str = Field(..., description="Second still")
    output_path: str | None = None
    # RIFE
    rife_model: str = Field("rife-v4.6")
    tta: bool = False
    uhd: bool = False
    # encode
    fps: float = Field(6.0, gt=0, le=60)
    save_stills: bool = False
    # img2img recoherence
    prompt: str = Field(DEFAULT_POSITIVE)
    negative_prompt: str = Field(DEFAULT_NEGATIVE)
    strength: float = Field(0.55, ge=0.05, le=0.95)
    guidance_scale: float = Field(1.5, ge=0.0, le=20.0)
    inference_steps: int = Field(8, ge=1, le=50)
    model_id: str = Field("rupeshs/LCM-dreamshaper-v7-openvino")
    device: str = Field("gpu")
    seed: int | None = Field(42)
    max_side: int = Field(0, ge=0)
    fit: str = Field("cover")
    dry_run: bool = False


def _validate_images(a: str, b: str) -> tuple[Path, Path]:
    pa = Path(a).expanduser().resolve()
    pb = Path(b).expanduser().resolve()
    if not pa.is_file():
        raise ValueError(f"image_a not found: {pa}")
    if not pb.is_file():
        raise ValueError(f"image_b not found: {pb}")
    if pa.suffix.lower() not in IMAGE_EXTS:
        raise ValueError(f"image_a is not a supported image: {pa}")
    if pb.suffix.lower() not in IMAGE_EXTS:
        raise ValueError(f"image_b is not a supported image: {pb}")
    return pa, pb


def _resolve_fit(fit: str) -> str:
    if fit == "cover":
        return "crop"
    if fit in ("letterbox", "crop", "stretch"):
        return fit
    return "crop"


def _mid_indices(frame_count: int) -> list[int]:
    """All frames between first and last (endpoints copy through)."""
    if frame_count < 3:
        raise ValueError(f"need at least 3 frames after RIFE, got {frame_count}")
    return list(range(1, frame_count - 1))


async def rife_recohere_run(p: RifeRecohereParams) -> OperationResult:
    from .. import job_control
    from ..filters.img2img import (
        run_img2img_directory,
        resolve_fastsd_python,
        resolve_fastsd_root,
    )
    from ..filters.rife import run_rife_directory, resolve_rife_bin
    from ..image_sort.conform import conform_image
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import encode as vp_encode

    op = "rife_recohere"
    try:
        pa, pb = _validate_images(p.image_a, p.image_b)
    except ValueError as e:
        return OperationResult(ok=False, operation=op, error=str(e))

    # FastSD check early
    try:
        py = resolve_fastsd_python()
        root = resolve_fastsd_root()
    except RuntimeError as e:
        return OperationResult(ok=False, operation=op, error=str(e))

    # RIFE bin check
    try:
        resolve_rife_bin()
    except RuntimeError as e:
        return OperationResult(ok=False, operation=op, error=str(e))

    out = finalize_output_path(
        p.output_path,
        source=pa,
        default_suffix="_rife_recohere",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )

    summary = (
        f"rife_recohere  A={pa.name}  B={pb.name}"
        f"  strength={p.strength}  steps={p.inference_steps}"
        f"  model={p.model_id}  fit={p.fit}  fps={p.fps}"
    )

    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, output_path=str(out), dry_run=True,
            command=summary,
            stdout=(
                f"FastSD python: {py}\n"
                f"FastSD root: {root}\n"
                f"A: {pa}\nB: {pb}\n"
                f"fit: {p.fit} → conform as {_resolve_fit(p.fit)}\n"
                f"RIFE: M=2 model={p.rife_model} tta={p.tta} uhd={p.uhd}\n"
                f"  target frames = 2×2 = 4 (A · mid · mid · B typical)\n"
                f"img2img: every mid (not endpoints); strength={p.strength}\n"
                f"encode: fps={p.fps}\n"
                f"output: {out}\n"
                + (f"save_stills: yes\n" if p.save_stills else "")
            ),
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="rife_recohere_")
    success = False
    logs: list[str] = [summary]
    job_token = job_control.current_token()

    def progress_cb(msg: str, **kw):
        logs.append(msg)
        try:
            job_control.report_progress(msg, token=job_token, **kw)
        except Exception:
            pass
        job_control.check_cancelled()

    target_fit = _resolve_fit(p.fit)

    try:
        # ── Geometry: size from A ──
        with Image.open(pa) as im:
            bw, bh = im.width, im.height
        bw = bw if bw % 2 == 0 else bw - 1
        bh = bh if bh % 2 == 0 else bh - 1
        logs.append(f"conform target: {bw}x{bh} even  fit={target_fit}")

        # ── phase: conform ──
        progress_cb(
            "conforming 2 keyframes…",
            phase="conform", current=0, total=2, unit="frames",
        )
        ws.create()

        await conform_image(pa, ws.frames_in / "frame_000000.png", bw, bh, fit=target_fit)
        progress_cb(
            "conformed A", phase="conform", current=1, total=2, unit="frames",
        )
        await conform_image(pb, ws.frames_in / "frame_000001.png", bw, bh, fit=target_fit)
        progress_cb(
            "conformed B", phase="conform", current=2, total=2, unit="frames",
        )

        # ── phase: rife M=2 → typically 4 frames (2 inputs × 2) ──
        progress_cb(
            "RIFE 2x interpolate…",
            phase="rife", current=0, total=4, unit="frames",
        )
        meta = await run_rife_directory(
            ws.frames_in, ws.frames_out,
            multiplier=2, model=p.rife_model, tta=p.tta, uhd=p.uhd,
        )
        out_count = int(meta["frame_count_out"])
        logs.append(
            f"rife: {meta['frame_count_in']} → {out_count} frames"
            + f"  model={p.rife_model}"
        )

        # Keep every frame. Expect 3 or 4 (target is 4 = K×M).
        if out_count not in (3, 4):
            raise RuntimeError(
                f"expected 3 or 4 frames after RIFE M=2 on 2 inputs, got {out_count}"
            )
        mid_idxs = _mid_indices(out_count)
        logs.append(
            f"rife: keep all {out_count} frames; "
            f"img2img mids {mid_idxs} (A/B endpoints untouched)"
        )
        progress_cb(
            f"rife done: {out_count} frames",
            phase="rife", current=out_count, total=out_count, unit="frames",
        )

        # ── phase: img2img every mid ──
        # 3 frames → indices [1]; 4 frames → [1, 2]
        n_mids = len(mid_idxs)
        progress_cb(
            f"img2img {n_mids} mid(s)…",
            phase="img2img", current=0, total=n_mids, unit="frames",
        )

        for f in ws.frames_in.glob("frame_*.png"):
            f.unlink()

        img2img_meta = await run_img2img_directory(
            ws.frames_out, ws.frames_in,
            prompt=p.prompt,
            negative_prompt=p.negative_prompt,
            strength=p.strength,
            inference_steps=p.inference_steps,
            guidance_scale=p.guidance_scale,
            model_id=p.model_id,
            device=p.device,
            frame_indices=mid_idxs,
            max_side=p.max_side,
        )
        logs.append(
            f"img2img: {img2img_meta['frame_count']} total"
            f"  {img2img_meta['img2img_count']} rewritten  indices={mid_idxs}"
            f"  model={p.model_id}"
        )
        if p.seed is not None:
            logs.append(f"seed={p.seed} (forward compat; not yet passed to worker)")

        encode_dir = ws.frames_in
        for idx in range(out_count):
            fpath = encode_dir / f"frame_{idx:06d}.png"
            if not fpath.is_file():
                raise RuntimeError(
                    f"missing frame after img2img: {fpath.name} "
                    f"(expected {out_count} frames)"
                )

        progress_cb(
            f"img2img done ({n_mids} mid(s))",
            phase="img2img", current=n_mids, total=n_mids, unit="frames",
        )

        # ── phase: encode ──
        progress_cb(
            f"encode {out_count} frames @ {p.fps} fps…",
            phase="encode", current=0, total=1, unit="pass",
        )
        result_path = await vp_encode(
            ws, out, p.fps,
            crf=18, mux_audio=False,
            frame_source_dir=encode_dir,
        )
        progress_cb(
            "encoded",
            phase="encode", current=1, total=1, unit="pass",
        )
        logs.append(f"encode: {result_path}  ({out_count} frames @ {p.fps} fps)")

        # ── optional: save stills ──
        if p.save_stills:
            out_parent = Path(out).parent
            n_saved = 0
            for idx in range(out_count):
                src = encode_dir / f"frame_{idx:06d}.png"
                dst = out_parent / f"{Path(out).stem}_{idx:03d}.png"
                if src.is_file():
                    shutil.copy2(src, dst)
                    n_saved += 1
            logs.append(f"stills: saved {n_saved} PNGs → {out_parent}")

        success = True
        return OperationResult(
            ok=True, operation=op, output_path=str(result_path),
            command=summary, stdout="\n".join(logs),
        )

    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation=op, error=str(e), stdout="\n".join(logs),
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation=op, error=str(e), stdout="\n".join(logs),
        )
    finally:
        ws.cleanup(keep_on_failure=not success)


register(OperationSpec(
    id="rife_recohere",
    summary="RIFE mids + OpenVINO img2img ghost collapse (all mids per pair)",
    description=(
        "Takes two stills A + B, conforms to same geometry, runs RIFE M=2 "
        "(target 4 frames: A · mid · mid · B). OpenVINO img2img runs on every "
        "mid (not endpoints) with a recoherence prompt so ghost blends become "
        "coherent frames. Encodes the full strip as a short .mp4. "
        "Requires FastSD GPU env and rife-ncnn-vulkan."
    ),
    params_model=RifeRecohereParams,
    handler=rife_recohere_run,
    tags=["rife", "recoherence", "img2img", "openvino"],
))