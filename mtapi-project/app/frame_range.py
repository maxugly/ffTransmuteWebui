"""Shared 1-based inclusive frame range fields for video ops.

Convention (matches datamosh):
  start_frame=1, end_frame=999999  → full clip
  start_frame / end_frame are 1-based inclusive source frame numbers.
"""
from __future__ import annotations

from pydantic import Field


def start_frame_field():
    return Field(
        1,
        ge=0,
        description="First frame to process (1-based inclusive). 1 = start of clip.",
    )


def end_frame_field():
    return Field(
        999999,
        ge=0,
        description="Last frame to process (1-based inclusive). Large value = end of clip.",
    )
