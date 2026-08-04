from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

from app.contract import OperationResult, OperationSpec, register
from app.staged_job import run_staged_job, StageSpec
from app.pathutil import finalize_output_path

class FastSAMParams(BaseModel):
    input_path: str = Field(..., description="Video or image path to extract from")
    output_dir: str | None = Field(None, description="Optional custom output directory")
    conf: float = Field(0.4, description="Confidence threshold")
    iou: float = Field(0.9, description="Intersection over union threshold")
    device: Literal["GPU", "CPU", "AUTO"] = Field("GPU", description="OpenVINO execution device")
    dry_run: bool = False

async def fastsam_op(p: FastSAMParams) -> OperationResult:
    out = finalize_output_path(
        None,
        source=p.input_path,
        default_suffix="_fastsam",
        default_ext=".png",  # Default to png, though run_staged_job might override for videos if mux_audio is used
        allowed_exts={".png", ".mp4", ".webm", ".mov", ".mkv"},
        output_dir=p.output_dir or None,
    )

    from app.filters.fastsam import make_fastsam_directory
    stage_fn = await make_fastsam_directory(conf=p.conf, iou=p.iou, device=p.device)
    
    return await run_staged_job(
        op_id="fastsam",
        prefix="fastsam_",
        input_path=p.input_path,
        output_path=str(out),
        dry_run=p.dry_run,
        dump_kwargs={},
        stages=[StageSpec("fastsam", "directory", stage_fn)],
        encode_kwargs={"codec": "prores_4444", "pix_fmt": "yuva444p10le"} # High quality transparent video if input is video
    )

register(OperationSpec(
    id="fastsam",
    summary="FastSAM object extraction via OpenVINO",
    description="Extracts main subjects from video or images using Fast Segment Anything Model (Intel Iris Xe FP16 optimized). Output is transparent.",
    params_model=FastSAMParams,
    handler=fastsam_op,
    tags=["fastsam", "openvino", "matting", "video", "image", "filter"],
))
