from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, Field

import cv2
import numpy as np

from app.contract import OperationResult, OperationSpec, register
from app.frame_range import end_frame_field, start_frame_field
from app.staged_job import StageSpec, run_staged_job
from app.pathutil import finalize_output_path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class DepthmapParams(BaseModel):
    input_path: str = Field(..., description="Video or image path to extract depth from")
    output_dir: str | None = Field(None, description="Optional custom output directory")
    device: Literal["CPU", "GPU", "AUTO"] = Field("CPU", description="OpenVINO execution device (CPU runs INT8 VNNI at ~1s)")
    colormap: Literal["grayscale", "inferno", "magma", "plasma", "viridis"] = Field("grayscale", description="Depth map color representation")
    invert: bool = Field(False, description="Invert depth (default white=near, black=far)")
    input_size: int = Field(518, description="Model input spatial size (multiple of 14, default 518)")
    model_id: Literal["depth-anything-v2-small"] = Field("depth-anything-v2-small", description="Model architecture")
    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = False
    keep_model_warm: bool = Field(False, description="Keep the model resident between runs")


async def depthmap_op(p: DepthmapParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="depthmap",
            error=f"Input not found: {input_path}", dry_run=p.dry_run,
        )

    ext = input_path.suffix.lower()
    is_image = ext in IMAGE_EXTS

    if is_image:
        out = finalize_output_path(
            None,
            source=input_path,
            default_suffix="_depth",
            default_ext=input_path.suffix or ".png",
            allowed_exts=IMAGE_EXTS,
            output_dir=p.output_dir or None,
        )
    else:
        out = finalize_output_path(
            None,
            source=input_path,
            default_suffix="_depth",
            default_ext=".mp4",
            allowed_exts=VIDEO_EXTS,
            output_dir=p.output_dir or None,
        )

    summary = f"depthmap {input_path.name}"

    if p.dry_run:
        dry = (
            f"# {'image' if is_image else 'dump'}\n"
            + (f"  direct image inference\n" if is_image else
               f"  ffmpeg -i {input_path} → frames_in/frame_%06d.png\n")
            + f"# depthmap stage\n"
            + f"  model={p.model_id} (INT8) colormap={p.colormap} invert={p.invert} device={p.device} size={p.input_size}\n"
            + (f"\n# output\n  {out}" if is_image else
               f"\n# encode\n  ffmpeg -framerate <fps> -i frames_out/frame_%06d.png {out}")
        )
        return OperationResult(
            ok=True, operation="depthmap", output_path=str(out),
            dry_run=True, command=summary, stdout=dry,
        )

    # ── Image path: direct inference ─────────────────────────────────────
    if is_image:
        from app.filters.depthmap import ensure_depth_model, get_runtime_model, predict_depth_runtime

        ov_model_path = await asyncio.to_thread(ensure_depth_model, model_id=p.model_id, device=p.device)
        model = await asyncio.to_thread(get_runtime_model, ov_model_path, keep_warm=p.keep_model_warm, model_id=p.model_id, device=p.device)

        ov_device = p.device
        if ov_device and not ov_device.lower().startswith("intel:") and ov_device.upper() != "CPU":
            ov_device = f"intel:{ov_device.lower()}"

        img = cv2.imread(str(input_path))
        if img is None:
            return OperationResult(
                ok=False, operation="depthmap",
                error=f"Failed to read image: {input_path}",
            )

        out_depth = await asyncio.to_thread(
            predict_depth_runtime, model, img,
            model_id=p.model_id, model_path=ov_model_path, device=ov_device,
            input_size=p.input_size, colormap=p.colormap, invert=p.invert,
        )

        cv2.imwrite(str(out), out_depth)

        from app import job_control
        token = job_control.current_token()
        if token:
            job_control.report_progress(
                "depthmap done",
                phase="done", current=1, total=1, unit="pass",
                latest_frame=str(out), token=token,
            )

        return OperationResult(
            ok=True, operation="depthmap", output_path=str(out),
            dry_run=False, command=summary,
        )

    # ── Video path: dump → depthmap → encode ─────────────────────────────
    from app.filters.depthmap import make_depthmap_directory
    stage_fn = await make_depthmap_directory(
        device=p.device, input_size=p.input_size, colormap=p.colormap,
        invert=p.invert, model_id=p.model_id, keep_model_warm=p.keep_model_warm,
    )

    return await run_staged_job(
        op_id="depthmap",
        prefix="depthmap_",
        input_path=input_path,
        output_path=str(out),
        dry_run=p.dry_run,
        dump_kwargs={"start_frame": p.start_frame, "end_frame": p.end_frame},
        stages=[StageSpec("depthmap", "directory", stage_fn)],
        encode_kwargs={"codec": "h264", "pix_fmt": "yuv420p"},
        summary=summary,
    )


register(OperationSpec(
    id="depthmap",
    summary="Depth Anything V2 monocular depth estimation",
    description="Estimates dense metric/relative depth maps from images or video using Depth Anything V2-S (OpenVINO INT8, ~1s). Outputs grayscale or false-color depth video/image.",
    params_model=DepthmapParams,
    handler=depthmap_op,
    tags=["depthmap", "depth", "depth-anything", "openvino", "int8", "video", "image", "filter"],
))
