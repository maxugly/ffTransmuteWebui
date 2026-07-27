"""
Shells out to the bash tools in bin/, and a couple of small parsers for
the conventions those tools already follow on stdout.

Everything here runs via create_subprocess_exec with an argv list, never
shell=True — paths with spaces or stray shell metacharacters shouldn't be
able to do anything but fail cleanly.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

BIN_DIR = Path(os.environ.get("MTAPI_BIN_DIR", Path(__file__).resolve().parent.parent / "bin"))

TRANSMUTE = str(BIN_DIR / "transmute")
DATAMOSH = str(BIN_DIR / "datamosh.sh")

_VIDEO_OUT_EXTS = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"})


def ensure_video_output_path(output_path: str | None) -> str | None:
    """ffmpeg cannot guess a muxer for extensionless paths like '.../1'."""
    if not output_path:
        return output_path
    p = output_path.strip()
    if not p:
        return None
    lower = p.lower()
    if any(lower.endswith(ext) for ext in _VIDEO_OUT_EXTS):
        return p
    base_stem, ext = os.path.splitext(p)
    if ext and len(ext) <= 6 and ext[1:].isalnum():
        return base_stem + ".mp4"
    return p + ".mp4"


# TODO: remove — use app.probe.probe_duration directly
async def probe_duration(path: str) -> float:
    from .probe import probe_duration as _pd
    return await _pd(path)

async def run_command(argv: list[str], cwd: str | None = None) -> tuple[int, str, str]:
    """Run argv, wait for it, return (exit_code, stdout, stderr) as text.

    stderr is streamed to the 'mtapi' logger in real-time so the server
    terminal shows ffmpeg progress, errors, and warnings as they happen —
    not just a silent wait followed by a result at the end.
    """
    import logging
    _log = logging.getLogger("mtapi")

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )

    async def _read_stderr() -> str:
        lines: list[str] = []
        while True:
            line = await proc.stderr.readline()  # type: ignore[union-attr]
            if not line:
                break
            decoded = line.decode(errors="replace").rstrip("\n")
            if decoded.strip():
                _log.info("[%s] %s", argv[0] if argv else "?", decoded)
            lines.append(decoded)
        return "\n".join(lines)

    stderr_task = asyncio.create_task(_read_stderr())
    stdout_b = await proc.stdout.read()  # type: ignore[union-attr]
    stderr_text = await stderr_task
    await proc.wait()

    return (
        proc.returncode if proc.returncode is not None else -1,
        stdout_b.decode(errors="replace"),
        stderr_text,
    )


def parse_line(stdout: str, prefix: str) -> str | None:
    """Pull the value off the first 'PREFIX: value' line in stdout.

    transmute always echoes 'Output: <path>' and 'Command: <argv>' before
    it runs (or would run, on -d) something — this is how we find out what
    it actually named a file without re-deriving its naming logic in
    Python and risking the two copies drifting apart.
    """
    for line in stdout.splitlines():
        if line.startswith(prefix):
            return line[len(prefix):].strip()
    return None


def check_tools() -> list[str]:
    """Return a list of human-readable warnings for anything missing.

    Called once at startup (see main.py) and logged, not enforced — a
    missing tool should fail loudly on first use, not block the server
    from starting up for operations that don't need it.
    """
    warnings: list[str] = []
    for name, path in (("transmute", TRANSMUTE), ("datamosh.sh", DATAMOSH)):
        if not Path(path).is_file():
            warnings.append(f"{name} not found at {path}")
    for name in ("ffgac", "ffedit", "ffmpeg", "ffprobe"):
        found = any((Path(d) / name).is_file() for d in os.environ.get("PATH", "").split(os.pathsep))
        if not found:
            warnings.append(f"'{name}' not found on PATH — operations that need it will fail")
    return warnings
