"""
datamosh handler — individual mode.
"""
from __future__ import annotations

from pydantic import BaseModel, Field
from ...contract import OperationResult, OperationSpec, register
from ...output_dir_ctx import get_output_dir
from ...pathutil import finalize_output_path
from .common import _trim_and_mosh, _execute_mosh_pipeline

class DatamoshClassicParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Where to write the result; auto-named if omitted")
    start_frame: int = Field(1, ge=1, description="First frame to mosh (1 = from start)")
    end_frame: int = Field(999999, ge=1, description="Last frame to mosh (default = to end)")
    dry_run: bool = Field(False, description="Show planned command without executing")


async def datamosh_classic(p: DatamoshClassicParams) -> OperationResult:
    from ...pathutil import finalize_output_path
    out = p.output_path or str(finalize_output_path(
        p.output_path, source=p.input_path, default_suffix="_classic",
        default_ext=".mp4", allowed_exts={".mp4",".mkv",".avi",".mov",".m4v",".webm"},
        output_dir=get_output_dir(),
    ))
    return await _trim_and_mosh(
        "datamosh_classic",
        p.input_path,
        out,
        p.start_frame,
        p.end_frame,
        glitch_mode=1,
        glitch_params=[],
        dry_run=p.dry_run,
    )


register(OperationSpec(
    id="datamosh_classic",
    summary="Keyframe-suppression mosh at existing cuts",
    description="Suppresses all keyframes. Glitches appear naturally at hard camera cuts.",
    params_model=DatamoshClassicParams,
    handler=datamosh_classic,
    tags=["datamosh"],
))
