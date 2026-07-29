"""
datamosh handler — individual mode.
"""
from __future__ import annotations

from pydantic import BaseModel, Field
from ...contract import OperationResult, OperationSpec, register
from ...output_dir_ctx import get_output_dir
from ...pathutil import finalize_output_path
from .common import _trim_and_mosh, _execute_mosh_pipeline

class DatamoshMvHackParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Where to write the result; auto-named if omitted")
    start_frame: int = Field(1, ge=0, description="Start frame of vector override")
    end_frame: int = Field(999999, ge=0, description="End frame of vector override")
    multiplier: float = Field(1.0, description="Motion speed multiplier (e.g. 0.0 to freeze, 2.0 to double)")
    drift_h: int = Field(0, description="Constant horizontal pixel drift nudge")
    drift_v: int = Field(0, description="Constant vertical pixel drift nudge")


async def datamosh_mv_hack(p: DatamoshMvHackParams) -> OperationResult:
    from ...pathutil import finalize_output_path
    out = p.output_path or str(finalize_output_path(
        p.output_path, source=p.input_path, default_suffix="_mvhack",
        default_ext=".mp4", allowed_exts={".mp4",".mkv",".avi",".mov",".m4v",".webm"},
        output_dir=get_output_dir(),
    ))
    mult_percent = int(round(p.multiplier * 100))
    return await _execute_mosh_pipeline(
        "datamosh_mv_hack",
        p.input_path,
        out,
        glitch_mode=3,
        glitch_params=[p.start_frame, p.end_frame, mult_percent, p.drift_h, p.drift_v]
    )


register(OperationSpec(
    id="datamosh_mv_hack",
    summary="Motion Vector Hack (Custom motion warping)",
    description="Directly scales or drift-nudges motion vectors within a target frame range.",
    params_model=DatamoshMvHackParams,
    handler=datamosh_mv_hack,
    tags=["datamosh"],
))
