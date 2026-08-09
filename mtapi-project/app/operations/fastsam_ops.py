from __future__ import annotations

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


class FastSAMParams(BaseModel):
    input_path: str = Field(..., description="Video or image path to extract from")
    output_dir: str | None = Field(None, description="Optional custom output directory")
    conf: float = Field(0.4, description="Confidence threshold")
    iou: float = Field(0.9, description="Intersection over union threshold")
    device: Literal["GPU", "CPU", "AUTO"] = Field("GPU", description="OpenVINO execution device")
    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = False


async def fastsam_op(p: FastSAMParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="fastsam",
            error=f"Input not found: {input_path}", dry_run=p.dry_run,
        )

    ext = input_path.suffix.lower()
    is_image = ext in IMAGE_EXTS

    if is_image:
        out = finalize_output_path(
            None,
            source=input_path,
            default_suffix="_fastsam",
            default_ext=input_path.suffix or ".png",
            allowed_exts=IMAGE_EXTS,
            output_dir=p.output_dir or None,
        )
    else:
        out = finalize_output_path(
            None,
            source=input_path,
            default_suffix="_fastsam",
            default_ext=".mov",
            allowed_exts=VIDEO_EXTS,
            output_dir=p.output_dir or None,
        )

    summary = f"fastsam {input_path.name}"

    if p.dry_run:
        dry = (
            f"# {'image' if is_image else 'dump'}\n"
            + (f"  direct image inference\n" if is_image else
               f"  ffmpeg -i {input_path} → frames_in/frame_%06d.png\n")
            + f"# fastsam stage\n"
            + f"  conf={p.conf} iou={p.iou} device={p.device}\n"
            + (f"\n# output\n  {out}" if is_image else
               f"\n# encode\n  ffmpeg -framerate <fps> -i frames_out/frame_%06d.png {out}")
        )
        return OperationResult(
            ok=True, operation="fastsam", output_path=str(out),
            dry_run=True, command=summary, stdout=dry,
        )

    # ── Image path: direct inference ─────────────────────────────────────
    if is_image:
        import cv2
        from app.filters.fastsam import ensure_openvino_model
        from ultralytics import FastSAM

        ov_model_path = ensure_openvino_model(device=p.device)
        model = FastSAM(ov_model_path)

        ov_device = p.device
        if ov_device and not ov_device.lower().startswith("intel:") and ov_device.upper() != "CPU":
            ov_device = f"intel:{ov_device.lower()}"

        img = cv2.imread(str(input_path))
        if img is None:
            return OperationResult(
                ok=False, operation="fastsam",
                error=f"Failed to read image: {input_path}",
            )

        results = model(img, device=ov_device, conf=p.conf, iou=p.iou)

        if results and len(results) > 0 and results[0].masks is not None:
            mask = results[0].masks.data[0].cpu().numpy()
            mask = cv2.resize(mask, (img.shape[1], img.shape[0]))
            b, g, r = cv2.split(img)
            alpha = (mask * 255).astype(np.uint8)
            transparent_img = cv2.merge([b, g, r, alpha])
            cv2.imwrite(str(out), transparent_img)
        else:
            import shutil
            shutil.copy(input_path, out)

        from app import job_control
        token = job_control.current_token()
        if token:
            job_control.report_progress(
                "fastsam done",
                phase="done", current=1, total=1, unit="pass",
                latest_frame=str(out), token=token,
            )

        return OperationResult(
            ok=True, operation="fastsam", output_path=str(out),
            dry_run=False, command=summary,
        )

    # ── Video path: dump → fastsam → encode ──────────────────────────────
    from app.filters.fastsam import make_fastsam_directory
    stage_fn = await make_fastsam_directory(conf=p.conf, iou=p.iou, device=p.device)

    return await run_staged_job(
        op_id="fastsam",
        prefix="fastsam_",
        input_path=input_path,
        output_path=str(out),
        dry_run=p.dry_run,
        dump_kwargs={"start_frame": p.start_frame, "end_frame": p.end_frame},
        stages=[StageSpec("fastsam", "directory", stage_fn)],
        encode_kwargs={"codec": "prores", "pix_fmt": "yuva444p10le"},
        summary=summary,
    )


register(OperationSpec(
    id="fastsam",
    summary="FastSAM object extraction via OpenVINO",
    description="Extracts main subjects from video or images using Fast Segment Anything Model (Intel Iris Xe FP16 optimized). Output is transparent.",
    params_model=FastSAMParams,
    handler=fastsam_op,
    tags=["fastsam", "openvino", "matting", "video", "image", "filter"],
))
