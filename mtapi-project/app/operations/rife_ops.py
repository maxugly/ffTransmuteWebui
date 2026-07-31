"""
RIFE frame interpolation — thin op over the shared directory stage.

dump → app.filters.rife.run_rife_directory → encode
See docs/rife-filter-cleanup-spec.md and docs/filter-platform-spec.md.
"""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path

RifeModel = Literal["rife-v4.6", "rife-v4", "rife-v2.4", "rife-v2.3"]

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class RifeParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    multiplier: int = Field(2, ge=2, le=8, description="Frame multiplier (2 = double, 4 = quadruple)")
    model: RifeModel = Field(
        "rife-v4.6", description="RIFE model variant. v4.6 is newest/cleanest.")
    tta: bool = Field(False, description="Spatial TTA mode — cleaner but slower")
    uhd: bool = Field(False, description="UHD mode for high-res sources")
    dry_run: bool = Field(False, description="Print command only")


async def rife_interpolate(p: RifeParams) -> OperationResult:
    """Thin bookend wrapper around the shared RIFE directory stage."""
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import probe, dump, encode, cleanup
    from ..filters.rife import run_rife_directory, resolve_rife_bin

    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False,
            operation="rife",
            error=f"Input not found: {input_path}",
            dry_run=p.dry_run,
        )

    out = finalize_output_path(
        p.output_path,
        source=input_path,
        default_suffix="_rife",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )

    summary = (
        f"rife {input_path.name} {p.multiplier}x {p.model} "
        f"(directory stage → {p.multiplier}x frames/fps)"
    )

    if p.dry_run:
        try:
            bin_path = resolve_rife_bin()
        except RuntimeError as e:
            return OperationResult(
                ok=False, operation="rife", error=str(e), dry_run=True,
            )
        dry = (
            f"# dump\nffmpeg -i {input_path} → frames_in/frame_%06d.png\n"
            f"# rife directory\n{bin_path} -i frames_in -o frames_out "
            f"-n <N*{p.multiplier}> -m {p.model} -f frame_%06d.png\n"
            f"# encode\nffmpeg -framerate <fps*{p.multiplier}> "
            f"-i frames_out/frame_%06d.png {out}"
        )
        return OperationResult(
            ok=True,
            operation="rife",
            output_path=str(out),
            dry_run=True,
            command=summary,
            stdout=dry,
        )

    info = await probe(input_path)
    if info["frame_count"] <= 0 or info["fps"] <= 0:
        return OperationResult(
            ok=False,
            operation="rife",
            error=f"Could not probe video: fps={info['fps']}, frames={info['frame_count']}",
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="rife_")
    success = False
    logs: list[str] = [summary]

    try:
        dump_info = await dump(ws, input_path)
        logs.append(f"dump: {dump_info['frame_count']} frames @ {dump_info['fps']} fps")

        from .. import job_control
        job_control.report_progress(
            "rife directory interpolate",
            phase="rife",
            current=0,
            total=dump_info["frame_count"] * p.multiplier,
            unit="frames",
        )

        meta = await run_rife_directory(
            ws.frames_in,
            ws.frames_out,
            multiplier=p.multiplier,
            model=p.model,
            tta=p.tta,
            uhd=p.uhd,
        )
        logs.append(
            f"rife: {meta['frame_count_in']} → {meta['frame_count_out']} frames"
        )
        logs.append(f"command: {meta['command']}")

        in_n = max(int(meta["frame_count_in"]), 1)
        out_n = int(meta["frame_count_out"])
        out_fps = float(dump_info["fps"]) * (out_n / in_n)

        job_control.report_progress(
            "rife encode",
            phase="encode",
            current=out_n,
            total=out_n,
            unit="frames",
        )

        result_path = await encode(ws, out, out_fps, mux_audio=True)
        logs.append(f"Output: {result_path} @ {out_fps:.4g} fps")
        success = True

        return OperationResult(
            ok=True,
            operation="rife",
            output_path=str(result_path),
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
        )

    except Exception as e:
        return OperationResult(
            ok=False,
            operation="rife",
            error=str(e),
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            stderr=str(e),
        )

    finally:
        await cleanup(ws, keep_on_failure=not success)


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
