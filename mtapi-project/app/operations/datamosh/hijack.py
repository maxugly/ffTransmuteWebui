"""
datamosh handler — individual mode.
"""
from __future__ import annotations

from pydantic import BaseModel, Field
from ..contract import OperationResult, OperationSpec, register
from ..output_dir_ctx import get_output_dir
from ..pathutil import finalize_output_path
from .common import _trim_and_mosh, _execute_mosh_pipeline

class DatamoshHijackParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Where to write the result; auto-named if omitted")
    inject_mode: str = Field("file", description="Source of injected image: 'file' or 'frame'")
    inject_image_path: str | None = Field(None, description="Absolute path to the image file (if mode is 'file')")
    inject_frame_num: int = Field(0, ge=0, description="Source frame number to extract (if mode is 'frame')")
    start_frame: int = Field(1, ge=1, description="Injection frame position where the glitch starts")
    end_frame: int = Field(999999, ge=1, description="Recovery frame position where the video recovers")
    transition_style: str = Field("smear", description="Glitch transition behavior: 'smear' (clear residuals, keep vectors) or 'freeze' (clear residuals, zero vectors)")


async def datamosh_hijack(p: DatamoshHijackParams) -> OperationResult:
    from ..pathutil import finalize_output_path
    out = p.output_path or str(finalize_output_path(
        p.output_path, source=p.input_path, default_suffix="_hijack",
        default_ext=".mp4", allowed_exts={".mp4",".mkv",".avi",".mov",".m4v",".webm"},
        output_dir=get_output_dir(),
    ))
    mode_val = 2 if p.transition_style == "smear" else 4
    relative_end = p.end_frame - p.start_frame
    if relative_end < 0:
        relative_end = 999999
        
    return await _execute_mosh_pipeline(
        "datamosh_hijack",
        p.input_path,
        out,
        glitch_mode=mode_val,
        glitch_params=[0, relative_end, 100, 0, 0], # start relative frame 0, end relative end_frame
        inject_mode=p.inject_mode,
        inject_image_path=p.inject_image_path,
        inject_frame_num=p.inject_frame_num,
        start_frame=p.start_frame,
        end_frame=p.end_frame
    )


register(OperationSpec(
    id="datamosh_hijack",
    summary="Visual Hijack (P-Frame Image Injection)",
    description="Injects an image at a specific frame, dragging it with video motion or freezing it, and recovers at an end frame.",
    params_model=DatamoshHijackParams,
    handler=datamosh_hijack,
    tags=["datamosh"],
))
