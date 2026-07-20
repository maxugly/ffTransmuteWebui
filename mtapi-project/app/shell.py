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


async def run_command(argv: list[str], cwd: str | None = None) -> tuple[int, str, str]:
    """Run argv, wait for it, return (exit_code, stdout, stderr) as text."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    stdout_b, stderr_b = await proc.communicate()
    return (
        proc.returncode if proc.returncode is not None else -1,
        stdout_b.decode(errors="replace"),
        stderr_b.decode(errors="replace"),
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
