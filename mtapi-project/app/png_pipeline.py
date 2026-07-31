"""DEPRECATED — use app.video_pipeline + JobWorkspace.

This module remains only as a thin compatibility shim:
  - dump_sync / encode_sync re-export video_pipeline sync helpers
  - PngFramePipeline raises if used (no new call sites)

Do not import this module in new code.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .video_pipeline import dump_frames_sync as dump_sync  # noqa: F401
from .video_pipeline import encode_frames_sync as encode_sync  # noqa: F401


class PngFramePipeline:
    """Removed. Use JobWorkspace + video_pipeline.dump/process/encode."""

    def __init__(self, prefix: str = "mtapi_") -> None:
        raise RuntimeError(
            "PngFramePipeline is removed. Use app.job_workspace.JobWorkspace + "
            "app.video_pipeline.dump/process/encode (or dump_frames_sync / "
            "encode_frames_sync for sync helpers). See docs/filter-platform-spec.md."
        )

    def cleanup(self) -> None:
        return

    @property
    def tmpdir(self) -> Path | None:
        return None

    async def dump(self, *args: Any, **kwargs: Any) -> Path:
        raise RuntimeError("PngFramePipeline.dump is removed")

    async def encode(self, *args: Any, **kwargs: Any) -> str:
        raise RuntimeError("PngFramePipeline.encode is removed")
