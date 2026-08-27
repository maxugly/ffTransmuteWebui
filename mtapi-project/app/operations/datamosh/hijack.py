"""
datamosh handler — Visual Hijack (Motion-Vector Payload Injection).

Replaces the old splice-and-destroy approach with a clean MV-transfer pipeline:
the payload image becomes the visual content of the prediction chain while
the source video's motion vectors drive frame-to-frame motion.
"""
from __future__ import annotations

from pydantic import BaseModel, Field
from ...contract import OperationResult, OperationSpec, register
from ...output_dir_ctx import get_output_dir
from ...pathutil import finalize_output_path
from .common import _execute_hijack_pipeline


class DatamoshHijackParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Where to write the result; auto-named if omitted")
    inject_mode: str = Field("file", description="Source of injected image: 'file' or 'frame'")
    inject_image_path: str | None = Field(None, description="Absolute path to the image file (if mode is 'file')")
    inject_frame_num: int = Field(0, ge=0, description="Source frame number to extract (if mode is 'frame')")
    start_frame: int = Field(1, ge=1, description="Injection frame position where the glitch starts")
    end_frame: int = Field(999999, ge=1, description="Recovery frame position where the video recovers")
    transition_style: str = Field("smear", description="Motion behavior: 'smear' (apply source MVs) or 'freeze' (zero MVs)")
    mv_multiplier: float = Field(1.0, ge=0.0, le=10.0, description="Motion vector speed multiplier (1.0 = source speed)")


async def datamosh_hijack(p: DatamoshHijackParams) -> OperationResult:
    from ...pathutil import finalize_output_path
    out = p.output_path or str(finalize_output_path(
        p.output_path, source=p.input_path, default_suffix="_hijack",
        default_ext=".mp4", allowed_exts={".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm"},
        output_dir=get_output_dir(),
    ))
    return await _execute_hijack_pipeline(
        "datamosh_hijack",
        p.input_path,
        out,
        inject_mode=p.inject_mode,
        inject_image_path=p.inject_image_path,
        inject_frame_num=p.inject_frame_num,
        start_frame=p.start_frame,
        end_frame=p.end_frame,
        transition_style=p.transition_style,
        mv_multiplier=p.mv_multiplier,
    )


register(OperationSpec(
    id="datamosh_hijack",
    summary="Visual Hijack (Motion-Vector Payload Injection)",
    description=(
        "Injects an image into the prediction chain at a specific frame range. "
        "Source motion vectors are transferred to the payload stream, making the "
        "image content smear with the video's motion (smear) or hold still (freeze). "
        "Clean source resumes after the injection interval."
    ),
    params_model=DatamoshHijackParams,
    handler=datamosh_hijack,
    tags=["datamosh"],
))
