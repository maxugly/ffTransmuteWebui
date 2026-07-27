"""Shared dump-PNGs → process → re-encode → cleanup pipeline.

Every neural op does the same three ffmpeg bookends:
1. dump input to PNG frames
2. (op-specific processing between dump and encode)
3. encode processed frames back to video

This class handles steps 1 + 3 + cleanup. The middle step stays in each op.
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path


class PngFramePipeline:
    """Dump video to PNGs, then encode PNGs back to video. Do not reuse.

    Usage:
        pipeline = PngFramePipeline(prefix="rife_")
        try:
            frame_dir = await pipeline.dump(input_path, fps=24, vsync=0, start_number=0)
            # ... op processes frames in frame_dir ...
            await pipeline.encode(frame_dir, output_path, fps=48, crf=18)
        finally:
            pipeline.cleanup()
    """

    def __init__(self, prefix: str = "mtapi_") -> None:
        self._prefix = prefix
        self._tmpdir: str | None = None

    @property
    def tmpdir(self) -> Path | None:
        """The temp directory root (available after dump())."""
        return Path(self._tmpdir) if self._tmpdir else None

    # ── dump ─────────────────────────────────────────────────────────

    async def dump(
        self,
        input_path: str | Path,
        *,
        fps: float | None = None,
        vsync: int = 0,
        start_number: int = 0,
        frame_pattern: str = "frame_%06d.png",
        audio: bool = False,
    ) -> Path:
        """ffmpeg dump: input → PNG sequence in tempdir. Returns tempdir Path."""
        from .shell import run_command

        self._tmpdir = tempfile.mkdtemp(prefix=self._prefix)
        tmp = Path(self._tmpdir)
        out_pattern = str(tmp / frame_pattern)

        argv: list[str] = [
            "ffmpeg", "-y",
            "-i", str(input_path),
            "-fps_mode", "passthrough" if vsync == 0 else "cfr",
            "-start_number", str(start_number),
        ]
        if not audio:
            argv.append("-an")
        if fps is not None:
            argv.extend(["-r", str(fps)])
        argv.append(out_pattern)

        code, _, stderr = await run_command(argv)
        if code != 0:
            shutil.rmtree(self._tmpdir, ignore_errors=True)
            raise RuntimeError(
                f"ffmpeg PNG dump failed (exit {code}): {stderr.strip() or 'no stderr'}"
            )
        return tmp

    # ── encode ───────────────────────────────────────────────────────

    async def encode(
        self,
        frame_dir: str | Path,
        output_path: str | Path,
        fps: float,
        *,
        start_number: int = 1,
        frame_pattern: str = "frame_%06d.png",
        codec: str = "libx264",
        preset: str = "fast",
        crf: int = 18,
        pix_fmt: str = "yuv420p",
        audio: bool = False,
        audio_codec: str = "aac",
        audio_bitrate: str = "192k",
    ) -> None:
        """ffmpeg encode: PNG sequence → video."""
        from .shell import run_command

        fdir = Path(frame_dir)
        argv: list[str] = [
            "ffmpeg", "-y",
            "-framerate", str(fps),
            "-start_number", str(start_number),
            "-i", str(fdir / frame_pattern),
        ]
        if not audio:
            argv.append("-an")
        argv.extend([
            "-c:v", codec,
            "-preset", preset,
            "-crf", str(crf),
            "-pix_fmt", pix_fmt,
        ])
        if audio:
            argv.extend(["-c:a", audio_codec, "-b:a", audio_bitrate])
        argv.append(str(output_path))

        code, _, stderr = await run_command(argv)
        if code != 0:
            raise RuntimeError(
                f"ffmpeg re-encode failed (exit {code}): {stderr.strip() or 'no stderr'}"
            )

    # ── cleanup ──────────────────────────────────────────────────────

    def cleanup(self) -> None:
        """Remove tempdir. Idempotent — safe to call multiple times."""
        if self._tmpdir is not None:
            shutil.rmtree(self._tmpdir, ignore_errors=True)
            self._tmpdir = None
