"""
JobWorkspace — isolated per-job temp directory for the unified video pipeline.

Each workspace lives under WORKSPACE_ROOT/{job_id}/ and contains:
  frames_in/       dumped PNGs from input video
  frames_out/      processed PNGs after filter function
  audio.ext        extracted audio stream for muxing
  metadata.json    fps, duration, frame count, input path, operation

Default root is on real disk (~/.cache/mtapi/jobs), NOT /tmp.
On many Linux setups /tmp is a small tmpfs (~RAM/2). A multi-minute join
dumping hundreds of thousands of PNGs will hit ENOSPC long before the 1TB+
data drive is full. Override with env MTAPI_JOBS_ROOT.

Lifecycle:
  - Created on job start. One workspace per concurrent job — no collisions.
  - Thread-safe: workspace path is derived from a unique job_id.
  - Cleaned up on success.
  - KEPT on failure (debuggable — inspect frames_in vs frames_out).
  - Cleanup behavior is configurable via keep_on_failure / keep_on_success.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

log = logging.getLogger("mtapi.job_workspace")


def _default_workspace_root() -> Path:
    # Prefer explicit env (absolute path on a big disk).
    env = (os.environ.get("MTAPI_JOBS_ROOT") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    # Real disk under user cache — survives small /tmp tmpfs.
    return (Path.home() / ".cache" / "mtapi" / "jobs").resolve()


WORKSPACE_ROOT = _default_workspace_root()


class JobWorkspace:
    """Per-job isolated filesystem workspace."""

    def __init__(self, job_id: str, prefix: str = "job_") -> None:
        self.job_id = job_id
        # Resolve root at construct time so env changes mid-process are rare/OK
        self.root = WORKSPACE_ROOT / f"{prefix}{job_id}"
        self.frames_in = self.root / "frames_in"
        self.frames_out = self.root / "frames_out"
        self.audio_path: Path | None = None
        self.metadata_path = self.root / "metadata.json"
        self._created = False

    def create(self) -> None:
        """Create all subdirectories. Idempotent — safe to call multiple times."""
        if self._created:
            return
        try:
            self.frames_in.mkdir(parents=True, exist_ok=True)
            self.frames_out.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            log.error(
                "Cannot create job workspace under %s (%s). "
                "If this is ENOSPC on /tmp, set MTAPI_JOBS_ROOT to a path on a large disk.",
                self.root,
                e,
            )
            raise
        self._created = True
        log.debug("job workspace ready: %s", self.root)

    def write_metadata(self, data: dict[str, Any]) -> None:
        """Write (or update) metadata.json."""
        self.root.mkdir(parents=True, exist_ok=True)
        self.metadata_path.write_text(
            json.dumps(data, indent=2, sort_keys=True), encoding="utf-8"
        )

    def read_metadata(self) -> dict[str, Any]:
        if not self.metadata_path.exists():
            return {}
        try:
            return json.loads(self.metadata_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def list_frames_in(self) -> list[Path]:
        if not self.frames_in.exists():
            return []
        return sorted(self.frames_in.glob("*.png"))

    def list_frames_out(self) -> list[Path]:
        if not self.frames_out.exists():
            return []
        return sorted(self.frames_out.glob("*.png"))

    def cleanup(self, *, keep_on_failure: bool = True, keep_on_success: bool = False) -> None:
        """Remove the workspace tree.

        By default: keep on failure (for debugging), remove on success.
        Set keep_on_success=True to always keep. Keep_on_failure=False to always remove.
        """
        if self.root.exists():
            if not keep_on_failure and not keep_on_success:
                shutil.rmtree(self.root, ignore_errors=True)
            elif not keep_on_success:
                shutil.rmtree(self.root, ignore_errors=True)

    def __str__(self) -> str:
        return str(self.root)

    def __repr__(self) -> str:
        return f"JobWorkspace({self.job_id!r})"
