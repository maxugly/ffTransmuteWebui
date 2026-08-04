"""Upscale directory stage — NCNN Vulkan (Real-ESRGAN / RealSR / SRMD).

kind=directory. Shared by /ops/upscale and /ops/pipeline.
"""
from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from typing import Any

from .. import job_control
from . import register_stage


_ENGINE_BINARIES = ["realesrgan-ncnn-vulkan", "realsr-ncnn-vulkan", "srmd-ncnn-vulkan"]


def resolve_upscale_bin(engine: str) -> str:
    """Resolve the NCNN binary for the given engine."""
    if engine == "realesrgan":
        # Prefer realesrgan-ncnn-vulkan, fall back to realsr-ncnn-vulkan
        candidates = ["realesrgan-ncnn-vulkan", "realsr-ncnn-vulkan"]
    elif engine == "srmd":
        candidates = ["srmd-ncnn-vulkan"]
    else:
        raise ValueError(f"Unknown upscale engine: {engine}")

    for name in candidates:
        found = shutil.which(name)
        if found:
            return found
        bin_dir = Path(__file__).resolve().parents[1] / "bin"
        candidate = bin_dir / name
        if candidate.is_file():
            return str(candidate)

    raise RuntimeError(
        f"No {engine} binary found. Tried: {', '.join(candidates)}. "
        "Install realesrgan-ncnn-vulkan, realsr-ncnn-vulkan, or srmd-ncnn-vulkan."
    )


def resolve_upscale_models(engine: str, binary: str) -> str:
    """Return the -m (model-path) argument for the given engine/binary."""
    bin_name = os.path.basename(binary)

    if engine == "realesrgan":
        if bin_name == "realsr-ncnn-vulkan":
            # Use the bundled models from realsr release
            share_dir = Path(os.path.expanduser("~/.local/share/realsr-ncnn-vulkan"))
            for candidate in [
                share_dir / "models-DF2K_JPEG",
                share_dir / "models-DF2K",
                Path(binary).parent / "models-DF2K_JPEG",
                Path(binary).parent / "models-DF2K",
            ]:
                if candidate.is_dir():
                    return str(candidate)
            return "models-DF2K_JPEG"
        else:
            # realesrgan-ncnn-vulkan — look for models dir
            for candidate in [
                Path(os.path.expanduser("~/.local/share/realesrgan-ncnn-vulkan/models")),
                Path(binary).parent / "models",
                Path.cwd() / "models",
            ]:
                if candidate.is_dir():
                    return str(candidate)
            return "models"

    if engine == "srmd":
        for candidate in [
            Path(os.path.expanduser("~/.local/share/srmd-ncnn-vulkan/models-srmd")),
            Path(binary).parent / "models-srmd",
        ]:
            if candidate.is_dir():
                return str(candidate)
        return "models-srmd"

    return "models"


def _list_frame_pngs(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    frames = sorted(directory.glob("frame_*.png"))
    if not frames:
        frames = sorted(directory.glob("*.png"))
    return frames


async def run_upscale_directory(
    src_dir: Path | str,
    dst_dir: Path | str,
    *,
    engine: str = "realesrgan",
    scale: int = 4,
    tile_size: int = 256,
    model_name: str = "",
    srmd_noise: int = 3,
    tta: bool = False,
) -> dict[str, Any]:
    """Run an NCNN upscale binary in directory mode. Returns dict with frame counts."""
    src = Path(src_dir).resolve()
    dst = Path(dst_dir).resolve()
    dst.mkdir(parents=True, exist_ok=True)

    frames_in = _list_frame_pngs(src)
    if not frames_in:
        raise RuntimeError(f"No PNG frames in {src}")
    in_count = len(frames_in)

    binary = resolve_upscale_bin(engine)
    models_path = resolve_upscale_models(engine, binary)

    argv = [
        binary,
        "-i", str(src),
        "-o", str(dst),
        "-s", str(scale),
        "-t", str(tile_size),
        "-m", models_path,
    ]

    bin_name = os.path.basename(binary)
    if engine == "realesrgan":
        if bin_name == "realesrgan-ncnn-vulkan" and model_name:
            argv.extend(["-n", model_name])
    elif engine == "srmd":
        argv.extend(["-n", str(srmd_noise)])

    if tta:
        argv.append("-x")

    argv.append("-f")
    argv.append("png")

    job_control.check_cancelled()

    token = job_control.current_token()
    if token:
        job_control.start_dir_watch(
            token,
            directory=dst,
            total=in_count,
            phase="upscale",
            unit="frames",
            message=f"Upscale ({engine}) {0}/{in_count} frames",
        )

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        while proc.returncode is None:
            job_control.check_cancelled()
            await asyncio.sleep(0.5)
        _out_b, err_b = await proc.communicate()
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        if token:
            job_control.stop_dir_watch(token)
        raise
    finally:
        if token:
            job_control.stop_dir_watch(token)

    if proc.returncode != 0:
        err = (err_b or b"").decode(errors="replace")[-500:]
        raise RuntimeError(
            f"{os.path.basename(binary)} failed (exit {proc.returncode}): {err or 'no stderr'}"
        )

    out_count = len(_list_frame_pngs(dst))
    if out_count <= 0:
        raise RuntimeError(f"{engine} produced no frames in {dst}")

    if token:
        job_control.report_progress(
            f"upscale done: {out_count} frames",
            phase="upscale", current=out_count, total=out_count, unit="frames",
            token=token, watch_dir=str(dst), watch_count=out_count,
        )

    return {
        "frame_count_in": in_count,
        "frame_count_out": out_count,
        "command": " ".join(argv),
        "engine": engine,
        "scale": scale,
    }


def make_upscale_directory_fn(
    *,
    engine: str = "realesrgan",
    scale: int = 4,
    tile_size: int = 256,
    model_name: str = "",
    srmd_noise: int = 3,
    tta: bool = False,
    **_extra: Any,
):
    """Factory for pipeline registry. Returned callable has kind='directory'."""

    async def directory_fn(src_dir: Path, dst_dir: Path) -> dict[str, Any]:
        return await run_upscale_directory(
            src_dir,
            dst_dir,
            engine=str(engine),
            scale=int(scale),
            tile_size=int(tile_size),
            model_name=str(model_name),
            srmd_noise=int(srmd_noise),
            tta=bool(tta),
        )

    directory_fn.kind = "directory"  # type: ignore[attr-defined]
    directory_fn.stage_name = "upscale"  # type: ignore[attr-defined]
    return directory_fn


register_stage("upscale", make_upscale_directory_fn)
