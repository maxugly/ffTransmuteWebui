from __future__ import annotations

from pathlib import Path
from typing import Literal

FitMode = Literal["letterbox", "crop", "stretch"]


async def conform_image(
    src: str | Path,
    dst: str | Path,
    width: int,
    height: int,
    fit: FitMode = "letterbox",
) -> None:
    w = _even(width)
    h = _even(height)
    dst_path = Path(dst)
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    if fit == "stretch":
        vf = f"scale={w}:{h}:flags=lanczos"
    elif fit == "crop":
        vf = (
            f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={w}:{h}"
        )
    else:
        vf = (
            f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black"
        )

    from ..shell import run_command

    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(Path(src).expanduser().resolve()),
        "-vf", vf,
        "-frames:v", "1",
        "-pix_fmt", "rgb24",
        str(dst_path),
    ]
    code, _, stderr = await run_command(argv)
    if code != 0:
        raise RuntimeError(
            f"ffmpeg conform failed (exit {code}): {stderr.strip() or 'no stderr'}"
        )


def _even(n: int) -> int:
    return n if n % 2 == 0 else n - 1
