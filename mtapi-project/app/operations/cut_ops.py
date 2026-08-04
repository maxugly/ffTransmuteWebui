"""Cut / trim — dump global frame range → encode (filter-platform bookends)."""
from __future__ import annotations

import uuid
from pathlib import Path

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path

VIDEO_EXTS = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"})


class CutParams(BaseModel):
    input_path: str = Field(..., description="Source video (absolute path preferred)")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    start_frame: int = Field(1, ge=0, description="First frame 1-based inclusive")
    end_frame: int = Field(999999, ge=0, description="Last frame 1-based inclusive")
    dry_run: bool = Field(False)


async def cut_run(p: CutParams) -> OperationResult:
    from .. import job_control
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import dump, encode as vp_encode

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
        p.output_path,
        source=inp,
        default_suffix=f"_cut_{p.start_frame}-{p.end_frame}",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )
    summary = f"cut {inp.name} frames {p.start_frame}–{p.end_frame}"
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, output_path=str(out), dry_run=True,
            command=summary,
            stdout=f"{summary}\noutput: {out}\n",
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="cut_")
    success = False
    logs = [summary]
    token = job_control.current_token()

    try:
        ws.create()
        job_control.report_progress(
            "dump range…", phase="dump", current=0, total=0, unit="frames", token=token,
        )
        dump_info = await dump(
            ws, inp,
            start_frame=p.start_frame,
            end_frame=p.end_frame,
        )
        n = int(dump_info.get("frame_count") or 0)
        fps = float(dump_info.get("fps") or 24)
        logs.append(f"dump: {n} frames @ {fps} fps")
        if n < 1:
            return OperationResult(
                ok=False, operation=op, error="dump produced no frames",
                stdout="\n".join(logs),
            )

        job_control.report_progress(
            f"encode {n} frames…", phase="encode", current=0, total=n, unit="frames",
            token=token,
        )
        result_path = await vp_encode(
            ws, out, fps,
            crf=18, mux_audio=True,
            frame_source_dir=ws.frames_in,
        )
        logs.append(f"encode: {result_path}")
        success = True
        return OperationResult(
            ok=True, operation=op, output_path=str(result_path),
            command=summary, stdout="\n".join(logs),
        )
    except job_control.JobCancelled as e:
        return OperationResult(ok=False, operation=op, error=str(e), stdout="\n".join(logs))
    except Exception as e:
        return OperationResult(ok=False, operation=op, error=str(e), stdout="\n".join(logs))
    finally:
        ws.cleanup(keep_on_failure=not success)


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
