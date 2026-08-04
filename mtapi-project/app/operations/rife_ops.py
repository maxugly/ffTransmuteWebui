"""
RIFE frame interpolation — thin op over the shared directory stage.

dump → app.filters.rife.run_rife_directory → encode
See docs/rife-filter-cleanup-spec.md and docs/filter-platform-spec.md.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..frame_range import end_frame_field, start_frame_field
from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..staged_job import StageSpec, run_staged_job

RifeModel = Literal["rife-v4.6", "rife-v4", "rife-v2.4", "rife-v2.3"]

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class RifeParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    multiplier: int = Field(2, ge=2, le=128, description="Frame density (2 = double … 128 = extreme). out ≈ N×M")
    model: RifeModel = Field(
        "rife-v4.6", description="RIFE model variant. v4.6 is newest/cleanest.")
    tta: bool = Field(False, description="Spatial TTA mode — cleaner but slower")
    uhd: bool = Field(False, description="UHD mode for high-res sources")
    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = Field(False, description="Print command only")


async def rife_interpolate(p: RifeParams) -> OperationResult:
    """Thin bookend wrapper around the shared RIFE directory stage."""
    from ..filters.rife import make_rife_directory_fn

    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="rife",
            error=f"Input not found: {input_path}", dry_run=p.dry_run,
        )

    out = finalize_output_path(
        p.output_path, source=input_path, default_suffix="_rife",
        default_ext=".mp4", allowed_exts=VIDEO_EXTS,
    )

    rife_fn = make_rife_directory_fn(
        multiplier=p.multiplier, model=p.model, tta=p.tta, uhd=p.uhd,
    )

    return await run_staged_job(
        op_id="rife",
        prefix="rife_",
        input_path=input_path,
        output_path=out,
        dry_run=p.dry_run,
        dump_kwargs={"start_frame": p.start_frame, "end_frame": p.end_frame},
        stages=[
            StageSpec("rife", "directory", rife_fn,
                      progress_total=None),  # progress managed by dir watch
        ],
        encode_kwargs={"mux_audio": True},
        summary=f"rife {input_path.name} {p.multiplier}x {p.model}",
    )


register(OperationSpec(
    id="rife",
    summary="RIFE frame interpolation (AI slow-mo)",
    description=(
        "RIFE (Real-Time Intermediate Flow Estimation) via ncnn-vulkan. "
        "Directory stage: one binary pass over dumped PNGs. "
        "Doubles/quadruples frame rate with AI in-betweens. "
        "Models: rife-v4.6 (newest), rife-v4, rife-v2.4, rife-v2.3. "
        "Same stage factory as /ops/pipeline filter 'rife'."
    ),
    params_model=RifeParams,
    handler=rife_interpolate,
    tags=["rife", "interpolation", "slow-mo", "neural", "filter"],
))
