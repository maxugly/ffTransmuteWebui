"""
RIFE frame interpolation — wraps rife-ncnn-vulkan for the typed ops registry.
"""
from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..shell import run_command

RifeModel = Literal["rife-v4.6", "rife-v4", "rife-v2.4", "rife-v2.3"]

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}

_RIFE_BIN = "/usr/bin/rife-ncnn-vulkan"


class RifeParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    multiplier: int = Field(2, ge=2, le=8, description="Frame multiplier (2 = double, 4 = quadruple)")
    model: RifeModel = Field(
        "rife-v4.6", description="RIFE model variant. v4.6 is newest/cleanest.")
    tta: bool = Field(False, description="Spatial TTA mode — cleaner but slower")
    uhd: bool = Field(False, description="UHD mode for high-res sources")
    dry_run: bool = Field(False, description="Print command only")


# TODO: remove after verifying no remaining callers
async def _ffprobe_frame_count(input_path: Path) -> int:
    from ..probe import probe_frame_count
    return await probe_frame_count(str(input_path))

# TODO: remove after verifying no remaining callers
async def _ffprobe_fps(input_path: Path) -> float:
    from ..probe import probe_fps
    return await probe_fps(str(input_path))


async def rife_interpolate(p: RifeParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False,
            operation="rife",
            error=f"Input not found: {input_path}",
            dry_run=p.dry_run,
        )

    from ..pathutil import finalize_output_path

    out = finalize_output_path(
        p.output_path,
        source=input_path,
        default_suffix="_rife",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )

    # ---- probe ----
    fps = await _ffprobe_fps(input_path)
    frame_count = await _ffprobe_frame_count(input_path)

    if fps <= 0 or frame_count <= 0:
        return OperationResult(
            ok=False,
            operation="rife",
            error=f"Could not probe video: fps={fps}, frames={frame_count}",
            dry_run=p.dry_run,
        )

    total_out_frames = frame_count * p.multiplier
    out_fps = fps * p.multiplier

    # ---- build command string ----
    dump_cmd = (
        f"ffmpeg -i {input_path} -an -vsync 0 -start_number 0 "
        f"<tmpdir>/frame_%06d.png"
    )
    rife_flags = f"-n {total_out_frames} -m {p.model} -f frame_%06d.png"
    if p.tta:
        rife_flags += " -x"
    if p.uhd:
        rife_flags += " -u"
    rife_cmd = f"rife-ncnn-vulkan -i <tmpdir> -o <tmpdir_out> {rife_flags} -v"
    enc_cmd = (
        f"ffmpeg -framerate {out_fps:.6g} -start_number 1 "
        f"-i <tmpdir_out>/frame_%06d.png -an "
        f"-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p {out}"
    )
    summary = (
        f"rife {input_path.name} {p.multiplier}x {p.model} "
        f"({frame_count}f→{total_out_frames}f, {fps:.2f}→{out_fps:.2f} fps)"
    )
    full_cmd = f"# dump\n{dump_cmd}\n# rife\n{rife_cmd}\n# encode\n{enc_cmd}"

    if p.dry_run:
        return OperationResult(
            ok=True,
            operation="rife",
            output_path=str(out),
            dry_run=True,
            command=summary,
            stdout=full_cmd,
        )

    # ---- execute ----
    tmpdir = None
    logs: list[str] = [summary]

    try:
        tmpdir = tempfile.mkdtemp(prefix="rife_")
        tmpdir_in = Path(tmpdir) / "in"
        tmpdir_out = Path(tmpdir) / "out"
        tmpdir_in.mkdir()
        tmpdir_out.mkdir()

        in_pattern = str(tmpdir_in / "frame_%06d.png")
        out_pattern = str(tmpdir_out / "frame_%06d.png")

        # 1. dump PNGs
        code, stdout, stderr = await run_command([
            "ffmpeg", "-y",
            "-i", str(input_path),
            "-an",
            "-vsync", "0",
            "-start_number", "0",
            in_pattern,
        ])
        if code != 0:
            logs.append(f"ffmpeg dump failed (exit {code})")
            logs.append(stderr)
            return OperationResult(
                ok=False,
                operation="rife",
                dry_run=False,
                command=summary,
                stdout="\n".join(logs),
                stderr=stderr,
                error=f"ffmpeg PNG dump failed with exit code {code}",
            )

        # 2. rife-ncnn-vulkan
        rife_argv = [
            _RIFE_BIN,
            "-i", str(tmpdir_in),
            "-o", str(tmpdir_out),
            "-n", str(total_out_frames),
            "-m", p.model,
            "-f", "frame_%06d.png",
            "-v",
        ]
        if p.tta:
            rife_argv.append("-x")
        if p.uhd:
            rife_argv.append("-u")

        proc = await asyncio.create_subprocess_exec(
            *rife_argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout_b, stderr_b = await proc.communicate()
        rife_stderr = stderr_b.decode(errors="replace")
        logs.append(rife_stderr)

        if proc.returncode != 0:
            return OperationResult(
                ok=False,
                operation="rife",
                dry_run=False,
                command=summary,
                stdout="\n".join(logs),
                error=f"rife-ncnn-vulkan failed with exit code {proc.returncode}",
            )

        # 3. re-encode
        code, stdout, stderr = await run_command([
            "ffmpeg", "-y",
            "-framerate", str(out_fps),
            "-start_number", "1",
            "-i", out_pattern,
            "-an",
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            str(out),
        ])
        if code != 0:
            logs.append(f"ffmpeg encode failed (exit {code})")
            logs.append(stderr)
            return OperationResult(
                ok=False,
                operation="rife",
                dry_run=False,
                command=summary,
                stdout="\n".join(logs),
                stderr=stderr,
                error=f"ffmpeg re-encode failed with exit code {code}",
            )

        logs.append(f"Output: {out}")
        return OperationResult(
            ok=True,
            operation="rife",
            output_path=str(out),
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
        )

    except Exception as e:
        return OperationResult(
            ok=False,
            operation="rife",
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            stderr=str(e),
            error=str(e),
        )

    finally:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)


register(OperationSpec(
    id="rife",
    summary="RIFE frame interpolation (AI slow-mo)",
    description=(
        "RIFE (Real-Time Intermediate Flow Estimation) via ncnn-vulkan. "
        "Doubles/quadruples frame rate with AI-generated in-between frames. "
        "Models: rife-v4.6 (newest, cleanest), rife-v4, rife-v2.4, rife-v2.3."
    ),
    params_model=RifeParams,
    handler=rife_interpolate,
    tags=["rife", "interpolation", "slow-mo", "neural"],
))
