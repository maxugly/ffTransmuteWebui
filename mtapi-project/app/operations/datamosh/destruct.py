"""
datamosh handler — individual mode.
"""
from __future__ import annotations

from pydantic import BaseModel, Field
from ..contract import OperationResult, OperationSpec, register
from ..output_dir_ctx import get_output_dir
from ..pathutil import finalize_output_path
from .common import _trim_and_mosh, _execute_mosh_pipeline

class DatamoshDestructParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Where to write the result; auto-named if omitted")
    start_frame: int = Field(1, ge=0, description="Start frame of residual destruction")
    end_frame: int = Field(999999, ge=0, description="End frame of residual destruction")


async def datamosh_destruct(p: DatamoshDestructParams) -> OperationResult:
    from ..pathutil import finalize_output_path
    out = p.output_path or str(finalize_output_path(
        p.output_path, source=p.input_path, default_suffix="_destruct",
        default_ext=".mp4", allowed_exts={".mp4",".mkv",".avi",".mov",".m4v",".webm"},
        output_dir=get_output_dir(),
    ))
    return await _execute_mosh_pipeline(
        "datamosh_destruct",
        p.input_path,
        out,
        glitch_mode=2,
        glitch_params=[p.start_frame, p.end_frame, 0, 0, 0]
    )


register(OperationSpec(
    id="datamosh_destruct",
    summary="Residual Destruct (DCT Coefficient clearing)",
    description="Zeroes out macroblock corrections to trigger visual bleeding without scene cuts.",
    params_model=DatamoshDestructParams,
    handler=datamosh_destruct,
    tags=["datamosh"],
))
