"""Cut / trim — dump global frame range → encode (filter-platform bookends)."""
from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from ..frame_range import end_frame_field, start_frame_field
from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..staged_job import run_staged_job

VIDEO_EXTS = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"})


class CutParams(BaseModel):
    input_path: str = Field(..., description="Source video (absolute path preferred)")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = Field(False)


async def cut_run(p: CutParams) -> OperationResult:
    op = "cut"
    inp = Path(p.input_path).expanduser().resolve()
    if not inp.is_file():
        return OperationResult(ok=False, operation=op, error=f"Input not found: {inp}")

    if p.end_frame < p.start_frame and p.end_frame < 999999:
        return OperationResult(
            ok=False, operation=op,
            error=f"end_frame ({p.end_frame}) < start_frame ({p.start_frame})",
        )

    out = finalize_output_path(
        p.output_path, source=inp,
        default_suffix=f"_cut_{p.start_frame}-{p.end_frame}",
        default_ext=".mp4", allowed_exts=VIDEO_EXTS,
    )

    return await run_staged_job(
        op_id=op,
        prefix="cut_",
        input_path=inp,
        output_path=out,
        dry_run=p.dry_run,
        dump_kwargs={"start_frame": p.start_frame, "end_frame": p.end_frame},
        stages=[],  # dump → encode only
        encode_kwargs={"crf": 18, "mux_audio": True},
        summary=f"cut {inp.name} frames {p.start_frame}–{p.end_frame}",
    )


register(OperationSpec(
    id="cut",
    summary="Cut / trim video by frame range",
    description=(
        "Dump frames from start_frame–end_frame (1-based, global range) then encode "
        "to a short .mp4. Filter-platform bookends only — no effects."
    ),
    params_model=CutParams,
    handler=cut_run,
    tags=["cut", "trim", "bookends"],
))
