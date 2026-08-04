"""
JobWorkspace — isolated per-job temp directory for the unified video pipeline.

Each workspace lives at /tmp/mtapi_jobs/{job_id}/ and contains:
  frames_in/       dumped PNGs from input video
  frames_out/      processed PNGs after filter function
  audio.ext        extracted audio stream for muxing
  metadata.json    fps, duration, frame count, input path, operation

Lifecycle:
  - Created on job start. One workspace per concurrent job — no collisions.
  - Thread-safe: workspace path is derived from a unique job_id.
  - Cleaned up on success.
  - KEPT on failure (debuggable — inspect frames_in vs frames_out).
  - Cleanup behavior is configurable via keep_on_failure / keep_on_success.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path("/tmp/mtapi_jobs")


class JobWorkspace:
    """Per-job isolated filesystem workspace."""

    def __init__(self, job_id: str, prefix: str = "job_") -> None:
        self.job_id = job_id
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
        self.frames_in.mkdir(parents=True, exist_ok=True)
        self.frames_out.mkdir(parents=True, exist_ok=True)
        self._created = True

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
