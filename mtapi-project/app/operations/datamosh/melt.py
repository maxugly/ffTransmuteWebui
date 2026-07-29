"""
datamosh handler — individual mode.
"""
from __future__ import annotations

from pydantic import BaseModel, Field
from ...contract import OperationResult, OperationSpec, register
from ...output_dir_ctx import get_output_dir
from ...pathutil import finalize_output_path
from .common import _trim_and_mosh, _execute_mosh_pipeline

class DatamoshMeltParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Where to write the result; auto-named if omitted")
    tail: int = Field(18, ge=1, description="Frames of 'memory' in the smear")
    hdamp: int = Field(15, ge=0, le=100, description="Horizontal damping percent (0-100)")
    vdrift: int = Field(1, description="Constant per-frame vertical push")
    start_frame: int = Field(1, ge=1, description="First frame to mosh (1 = from start)")
    end_frame: int = Field(999999, ge=1, description="Last frame to mosh (default = to end)")
    dry_run: bool = Field(False, description="Show planned command without executing")


async def datamosh_melt(p: DatamoshMeltParams) -> OperationResult:
    from ...pathutil import finalize_output_path
    out = p.output_path or str(finalize_output_path(
        p.output_path,
        source=p.input_path,
        default_suffix="_melt",
        default_ext=".mp4",
        allowed_exts={".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm"},
        output_dir=get_output_dir(),
    ))
    return await _trim_and_mosh(
        "datamosh_melt",
        p.input_path,
        out,
        p.start_frame,
        p.end_frame,
        glitch_mode=0,
        glitch_params=[p.tail, p.hdamp, p.vdrift],
        dry_run=p.dry_run,
    )


register(OperationSpec(
    id="datamosh_melt",
    summary="Continuous motion-vector melt/drip effect",
    description="Accumulates motion vectors over previous frames to smear pixels continuously.",
    params_model=DatamoshMeltParams,
    handler=datamosh_melt,
    tags=["datamosh"],
))
