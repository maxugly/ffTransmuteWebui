"""
RIFE frame interpolation — wraps rife-ncnn-vulkan for the typed ops registry.

v2 handler uses VideoPipeline + JobWorkspace (frame-by-frame filter_fn).
Legacy handler uses PngFramePipeline (whole-directory subprocess).
"""
from __future__ import annotations

import asyncio
import shutil
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


async def rife_interpolate(p: RifeParams) -> OperationResult:
    """Frame-by-frame RIFE using VideoPipeline + JobWorkspace.

    Each frame pair is interpolated incrementally via rife-ncnn-vulkan.
    Pipeline handles dump, progress, cancel, encode, and cleanup.
    """
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import probe, dump, process, encode, cleanup

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
        f"(→{p.multiplier}x frames, →{p.multiplier}x fps)"
    )

    if p.dry_run:
        dump_cmd = f"ffmpeg -i {input_path} -an -vsync 0 frames_in/frame_%06d.png"
        enc_cmd = f"ffmpeg -framerate <outfps> -i frames_out/frame_%06d.png {out}"
        return OperationResult(
            ok=True,
            operation="rife",
            output_path=str(out),
            dry_run=True,
            command=summary,
            stdout=f"# dump\n{dump_cmd}\n# rife filter per frame pair\n# encode\n{enc_cmd}",
        )

    info = await probe(input_path)
    if info["frame_count"] <= 0 or info["fps"] <= 0:
        return OperationResult(
            ok=False,
            operation="rife",
            error=f"Could not probe video: fps={info['fps']}, frames={info['frame_count']}",
        )

    out_fps = info["fps"] * p.multiplier

    import uuid
    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="rife_")
    success = False
    logs: list[str] = [summary]

    # ── filter_fn closure with managed output index ────────────────────
    out_index = 0
    previous_frame: Path | None = None
    workspace_ref = ws

    async def rife_filter(input_png: Path, output_png: Path, index: int) -> None:
        nonlocal out_index, previous_frame

        if index == 0:
            for _ in range(p.multiplier):
                dst = workspace_ref.frames_out / f"frame_{out_index:06d}.png"
                shutil.copy2(input_png, dst)
                out_index += 1
            previous_frame = input_png
            return

        steps = [i / p.multiplier for i in range(1, p.multiplier)]
        for step in steps:
            interp_dst = workspace_ref.frames_out / f"frame_{out_index:06d}.png"
            rife_argv = [
                _RIFE_BIN,
                "-0", str(previous_frame),
                "-1", str(input_png),
                "-o", str(interp_dst),
                "-s", str(step),
                "-m", p.model,
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
            stdout_b, stderr_b = await proc.communicate()
            if proc.returncode != 0:
                err = stderr_b.decode(errors="replace")[-300:]
                raise RuntimeError(
                    f"rife-ncnn-vulkan failed on index {index} step {step}: {err}"
                )
            out_index += 1

        dst = workspace_ref.frames_out / f"frame_{out_index:06d}.png"
        shutil.copy2(input_png, dst)
        out_index += 1
        previous_frame = input_png

    try:
        dump_info = await dump(ws, input_path)
        logs.append(f"dump: {dump_info['frame_count']} frames")

        from .. import job_control
        def progress_cb(current: int, total: int) -> None:
            job_control.report_progress(
                f"rife frame {current}/{total}",
                phase="rife-frames",
                current=current,
                total=total,
                unit="frames",
            )

        processed = await process(ws, rife_filter, progress_cb=progress_cb)
        logs.append(f"process: {processed} frames in → {out_index} frames out")

        result_path = await encode(ws, out, out_fps, mux_audio=True)
        logs.append(f"Output: {result_path}")
        success = True

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
            error=str(e),
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            stderr=str(e),
        )

    finally:
        await cleanup(ws, keep_on_failure=not success)


# ── Legacy handler (PngFramePipeline whole-directory subprocess) ──────────
async def rife_interpolate_legacy(p: RifeParams) -> OperationResult:
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
    from ..png_pipeline import PngFramePipeline
    pipeline = PngFramePipeline(prefix="rife_")
    logs: list[str] = [summary]

    try:
        frame_dir = await pipeline.dump(
            input_path, vsync=0, start_number=0,
        )
        tmpdir_out = pipeline.tmpdir / "out"
        tmpdir_out.mkdir()
        out_pattern = str(tmpdir_out / "frame_%06d.png")

        # 2. rife-ncnn-vulkan
        rife_argv = [
            _RIFE_BIN,
            "-i", str(frame_dir),
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
        await pipeline.encode(
            tmpdir_out, out, out_fps,
            start_number=1, frame_pattern="frame_%06d.png",
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
        pipeline.cleanup()


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
