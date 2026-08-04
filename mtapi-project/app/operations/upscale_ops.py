"""
Upscale images or video frames using NCNN Vulkan (Real-ESRGAN / SRMD).

dump -> app.filters.upscale.run_upscale_directory -> encode (with optional re-grain)
See docs/backlog/upscale-spec.md and docs/filter-platform-spec.md.
"""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path

UpscaleEngine = Literal["realesrgan", "srmd"]

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


class UpscaleParams(BaseModel):
    input_path: str = Field(..., description="Source image or video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    engine: UpscaleEngine = Field("realesrgan", description="Upscale engine: realesrgan or srmd")
    scale: int = Field(4, ge=2, le=4, description="Upscale ratio (2, 3, or 4)")
    tile_size: int = Field(256, ge=0, description="Tile size (0=auto, >=32)")
    model_name: str = Field("", description="Model name for realesrgan. Blank=default.")
    srmd_noise: int = Field(3, ge=-1, le=10, description="SRMD denoise level (-1=preserve, 10=heavy)")
    tta: bool = Field(False, description="Spatial TTA mode — cleaner but slower")
    grain_strength: int = Field(0, ge=0, le=24, description="Re-grain strength (0=off, ~12 for film look)")
    start_frame: int = Field(1, ge=0, description="First source frame (1-based)")
    end_frame: int = Field(999999, ge=0, description="Last source frame (1-based)")
    dry_run: bool = Field(False, description="Print command only")


async def upscale_run(p: UpscaleParams) -> OperationResult:
    """Thin bookend wrapper around the upscale directory stage."""
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import probe, dump, encode, cleanup
    from ..filters.upscale import (
        run_upscale_directory, resolve_upscale_bin, resolve_upscale_models,
    )

    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False,
            operation="upscale",
            error=f"Input not found: {input_path}",
            dry_run=p.dry_run,
        )

    ext = input_path.suffix.lower()
    is_image = ext in IMAGE_EXTS

    if is_image:
        out = finalize_output_path(
            p.output_path,
            source=input_path,
            default_suffix=f"_x{p.scale}",
            default_ext=input_path.suffix if input_path.suffix else ".png",
            allowed_exts=IMAGE_EXTS,
        )
    else:
        out = finalize_output_path(
            p.output_path,
            source=input_path,
            default_suffix=f"_x{p.scale}",
            default_ext=".mp4",
            allowed_exts=VIDEO_EXTS,
        )

    engine_label = p.engine
    summary = f"upscale {input_path.name} {p.scale}x {engine_label}"

    if p.dry_run:
        try:
            bin_path = resolve_upscale_bin(p.engine)
        except RuntimeError as e:
            return OperationResult(
                ok=False, operation="upscale", error=str(e), dry_run=True,
            )
        dry = (
            f"# {'image' if is_image else 'dump'}\n"
            + (f"  direct CLI on image\n" if is_image else
               f"  ffmpeg -i {input_path} → frames_in/frame_%06d.png\n")
            + f"# upscale directory\n"
            f"  {bin_path} -i frames_in -o frames_out -s {p.scale} -t {p.tile_size}"
            + (f" -n {p.model_name}" if p.model_name else "")
            + (f" -n {p.srmd_noise}" if p.engine == "srmd" else "")
            + (" -x" if p.tta else "")
            + f" -f png\n"
            + (f"# re-grain\n  ffmpeg noise=c0s={p.grain_strength}..."
               if p.grain_strength > 0 else "")
            + (f"\n# {'encode' if not is_image else 'output'}\n"
               f"  {'ffmpeg -framerate <fps> -i frames_out/frame_%06d.png' if not is_image else '  (direct image output)'}"
               + (f" {out}" if not is_image else ""))
        )
        return OperationResult(
            ok=True,
            operation="upscale",
            output_path=str(out),
            dry_run=True,
            command=summary,
            stdout=dry,
        )

    if is_image:
        # Single image: direct CLI call
        from ..filters.upscale import resolve_upscale_bin, resolve_upscale_models
        import asyncio, os

        bin_path = resolve_upscale_bin(p.engine)
        models_path = resolve_upscale_models(p.engine, bin_path)
        bin_name = os.path.basename(bin_path)

        argv = [
            bin_path,
            "-i", str(input_path),
            "-o", str(out),
            "-s", str(p.scale),
            "-t", str(p.tile_size),
            "-m", models_path,
        ]
        if p.engine == "realesrgan":
            if bin_name == "realesrgan-ncnn-vulkan" and p.model_name:
                argv.extend(["-n", p.model_name])
        elif p.engine == "srmd":
            argv.extend(["-n", str(p.srmd_noise)])
        if p.tta:
            argv.append("-x")
        argv.extend(["-f", "png"])

        from ..shell import run_command

        cwd = str(Path(out).parent)
        rc, stdout, stderr = await run_command(argv, cwd=cwd)

        if rc != 0:
            return OperationResult(
                ok=False,
                operation="upscale",
                error=f"upscale failed (exit {rc}): {stderr[-500:]}",
                command=" ".join(argv),
                stdout=stdout,
                stderr=stderr,
            )

        return OperationResult(
            ok=True,
            operation="upscale",
            output_path=str(out),
            dry_run=False,
            command=" ".join(argv),
            stdout=stdout,
        )

    # Video path
    info = await probe(input_path)
    if info["frame_count"] <= 0 or info["fps"] <= 0:
        return OperationResult(
            ok=False,
            operation="upscale",
            error=f"Could not probe video: fps={info['fps']}, frames={info['frame_count']}",
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="upscale_")
    success = False
    logs: list[str] = [summary]

    try:
        dump_info = await dump(
            ws, input_path, start_frame=p.start_frame, end_frame=p.end_frame,
        )
        logs.append(
            f"dump: {dump_info['frame_count']} frames @ {dump_info['fps']} fps"
        )

        from .. import job_control
        job_control.report_progress(
            "upscale directory",
            phase="upscale",
            current=0,
            total=dump_info["frame_count"],
            unit="frames",
        )

        meta = await run_upscale_directory(
            ws.frames_in,
            ws.frames_out,
            engine=p.engine,
            scale=p.scale,
            tile_size=p.tile_size,
            model_name=p.model_name,
            srmd_noise=p.srmd_noise,
            tta=p.tta,
        )
        logs.append(
            f"upscale: {meta['frame_count_in']} -> {meta['frame_count_out']} frames"
        )
        logs.append(f"command: {meta['command']}")

        source_fps = float(dump_info["fps"])
        grain_vf: str | None = None
        if p.grain_strength > 0:
            gs = p.grain_strength
            grain_vf = f"noise=c0s={gs}:c1s={gs//2}:c2s={gs//2}:allf=t+g"
            logs.append(f"re-grain: strength={gs}")

        job_control.report_progress(
            "upscale encode",
            phase="encode",
            current=0,
            total=1,
            unit="pass",
        )

        result_path = await encode(
            ws, out, source_fps, mux_audio=True, extra_vf=grain_vf,
        )
        job_control.report_progress(
            "encode done",
            phase="encode",
            current=1,
            total=1,
            unit="pass",
        )
        logs.append(f"Output: {result_path} @ {source_fps} fps")
        success = True

        return OperationResult(
            ok=True,
            operation="upscale",
            output_path=str(result_path),
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
        )

    except Exception as e:
        return OperationResult(
            ok=False,
            operation="upscale",
            error=str(e),
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            stderr=str(e),
        )

    finally:
        await cleanup(ws, keep_on_failure=not success)


register(OperationSpec(
    id="upscale",
    summary="NCNN Vulkan upscale (Real-ESRGAN / SRMD) with optional re-grain",
    description=(
        "AI upscale using NCNN Vulkan binaries. Real-ESRGAN for clean digital sources, "
        "SRMD for noise-aware analog film upscaling. Images: direct CLI. "
        "Video: dump frames -> upscale directory -> encode. "
        "Optional FFmpeg re-grain post-pass for film grain. "
        "Also available as pipeline filter name 'upscale'."
    ),
    params_model=UpscaleParams,
    handler=upscale_run,
    tags=["upscale", "esrgan", "srmd", "ncnn", "neural", "filter", "re-grain"],
))
