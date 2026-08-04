"""Thin img2img op — stills or video via filter-platform dump → stage → encode."""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..frame_range import end_frame_field, start_frame_field
from ..pathutil import finalize_output_path

IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"})
VIDEO_EXTS = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"})


class Img2ImgParams(BaseModel):
    input_path: str | None = Field(
        None, description="Single image or video path (absolute preferred)"
    )
    image_paths: list[str] | None = Field(
        None, description="Ordered stills; used if input_path empty"
    )
    output_path: str | None = Field(None, description="Output file or dir for multi-still")
    prompt: str = Field(..., min_length=1, description="Positive prompt")
    negative_prompt: str = Field("", description="Negative prompt")
    strength: float = Field(0.35, ge=0.05, le=0.95)
    inference_steps: int = Field(4, ge=1, le=50)
    guidance_scale: float = Field(1.0, ge=0.0, le=20.0)
    model_id: str = Field("rupeshs/sd-turbo-openvino")
    device: str = Field("gpu", description="OpenVINO device: gpu | cpu")
    frame_indices: list[int] | None = Field(
        None, description="0-based frame indices to process (null = all)"
    )
    frame_range: list[int] | None = Field(
        None, description="Inclusive [start, end] 0-based alternative to indices"
    )
    max_side: int = Field(0, ge=0, description="Optional long-side cap (0 = native, %%8)")
    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = Field(False)


def _collect_stills(p: Img2ImgParams) -> list[Path]:
    paths: list[Path] = []
    if p.image_paths:
        for x in p.image_paths:
            paths.append(Path(x).expanduser().resolve())
    elif p.input_path:
        ip = Path(p.input_path).expanduser().resolve()
        if ip.suffix.lower() in IMAGE_EXTS:
            paths.append(ip)
    missing = [str(x) for x in paths if not x.is_file()]
    if missing:
        raise ValueError(f"Files not found: {', '.join(missing[:5])}")
    return paths


async def img2img_run(p: Img2ImgParams) -> OperationResult:
    from .. import job_control
    from ..filters.img2img import (
        run_img2img_directory,
        resolve_fastsd_python,
        resolve_fastsd_root,
    )
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import dump, encode as vp_encode

    op = "img2img"
    try:
        py = resolve_fastsd_python()
        root = resolve_fastsd_root()
    except RuntimeError as e:
        return OperationResult(ok=False, operation=op, error=str(e), dry_run=p.dry_run)

    # Video path
    if p.input_path:
        ip = Path(p.input_path).expanduser().resolve()
        if ip.is_file() and ip.suffix.lower() in VIDEO_EXTS:
            out = finalize_output_path(
                p.output_path,
                source=ip,
                default_suffix="_img2img",
                default_ext=".mp4",
                allowed_exts=VIDEO_EXTS,
            )
            summary = (
                f"img2img video {ip.name} strength={p.strength} "
                f"model={p.model_id} device={p.device}"
            )
            if p.dry_run:
                return OperationResult(
                    ok=True, operation=op, output_path=str(out), dry_run=True,
                    command=summary,
                    stdout=f"python={py}\nfastsd_root={root}\n{summary}\n",
                )
            ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="img2img_")
            success = False
            logs = [summary]
            try:
                ws.create()
                info = await dump(
                    ws, ip, start_frame=p.start_frame, end_frame=p.end_frame,
                )
                fps = float(info.get("fps") or 24)
                meta = await run_img2img_directory(
                    ws.frames_in, ws.frames_out,
                    prompt=p.prompt,
                    negative_prompt=p.negative_prompt,
                    strength=p.strength,
                    inference_steps=p.inference_steps,
                    guidance_scale=p.guidance_scale,
                    model_id=p.model_id,
                    device=p.device,
                    frame_indices=p.frame_indices,
                    frame_range=p.frame_range,
                    max_side=p.max_side,
                )
                logs.append(
                    f"frames={meta['frame_count']} img2img={meta['img2img_count']}"
                )
                result_path = await vp_encode(
                    ws, out, fps, mux_audio=True, frame_source_dir=ws.frames_out,
                )
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

    # Stills
    try:
        stills = _collect_stills(p)
    except ValueError as e:
        return OperationResult(ok=False, operation=op, error=str(e), dry_run=p.dry_run)

    if len(stills) < 1:
        return OperationResult(
            ok=False, operation=op,
            error="Provide input_path (image/video) or image_paths",
            dry_run=p.dry_run,
        )

    # Single still → single PNG out; multi → folder or first + suffix
    if len(stills) == 1:
        src0 = stills[0]
        out = finalize_output_path(
            p.output_path,
            source=src0,
            default_suffix="_img2img",
            default_ext=".png",
            allowed_exts=IMAGE_EXTS,
        )
    else:
        out_dir = Path(p.output_path).expanduser().resolve() if p.output_path else (
            stills[0].parent / f"{stills[0].stem}_img2img"
        )
        out = out_dir

    summary = (
        f"img2img stills K={len(stills)} strength={p.strength} model={p.model_id}"
    )
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, output_path=str(out), dry_run=True,
            command=summary,
            stdout=f"python={py}\n{summary}\npaths={[s.name for s in stills]}\n",
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="img2img_")
    success = False
    logs = [summary]
    try:
        ws.create()
        for i, sp in enumerate(stills):
            dst = ws.frames_in / f"frame_{i:06d}.png"
            # normalize to png
            if sp.suffix.lower() == ".png":
                shutil.copy2(sp, dst)
            else:
                from PIL import Image
                with Image.open(sp) as im:
                    im.convert("RGB").save(dst, format="PNG")

        meta = await run_img2img_directory(
            ws.frames_in, ws.frames_out,
            prompt=p.prompt,
            negative_prompt=p.negative_prompt,
            strength=p.strength,
            inference_steps=p.inference_steps,
            guidance_scale=p.guidance_scale,
            model_id=p.model_id,
            device=p.device,
            frame_indices=p.frame_indices,
            frame_range=p.frame_range,
            max_side=p.max_side,
        )
        logs.append(f"img2img_count={meta['img2img_count']}")

        outs = sorted(ws.frames_out.glob("frame_*.png"))
        if len(outs) == 1:
            Path(out).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(outs[0], out)
            result_path = str(out)
        else:
            out_dir = Path(out)
            out_dir.mkdir(parents=True, exist_ok=True)
            for i, f in enumerate(outs):
                name = stills[i].stem + "_img2img.png" if i < len(stills) else f.name
                shutil.copy2(f, out_dir / name)
            result_path = str(out_dir)

        success = True
        return OperationResult(
            ok=True, operation=op, output_path=result_path,
            command=summary, stdout="\n".join(logs),
        )
    except job_control.JobCancelled as e:
        return OperationResult(ok=False, operation=op, error=str(e), stdout="\n".join(logs))
    except Exception as e:
        return OperationResult(ok=False, operation=op, error=str(e), stdout="\n".join(logs))
    finally:
        ws.cleanup(keep_on_failure=not success)


register(OperationSpec(
    id="img2img",
    summary="OpenVINO img2img (FastSD GPU) on stills or video frames; optional index marks",
    description=(
        "Runs OVStableDiffusionImg2ImgPipeline via FastSD's Python env. "
        "Unmarked frames copy through. frame_indices are 0-based into the sequence. "
        "Default model rupeshs/sd-turbo-openvino, DEVICE=gpu. "
        "Also available as pipeline filter name 'img2img'."
    ),
    params_model=Img2ImgParams,
    handler=img2img_run,
    tags=["img2img", "openvino", "diffusion", "filter"],
))
