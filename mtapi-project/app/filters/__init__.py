"""Frame-stage factories for the filter platform.

Stages transform image sequences on disk. Bookends (dump/encode) live in
video_pipeline. See docs/filter-platform-spec.md.
"""
from __future__ import annotations

from typing import Any, Callable, Literal

StageKind = Literal["per_frame", "directory"]

# name -> factory(**params) -> callable
# per_frame: FilterFn (input_png, output_png, index)
# directory: async (src_dir, dst_dir) -> dict  (must set .kind = "directory")
STAGE_REGISTRY: dict[str, Callable[..., Any]] = {}


def register_stage(name: str, factory: Callable[..., Any]) -> None:
    STAGE_REGISTRY[name] = factory


def get_stage_factory(name: str) -> Callable[..., Any] | None:
    return STAGE_REGISTRY.get(name)


def list_stages() -> list[str]:
    return sorted(STAGE_REGISTRY.keys())


# Side-effect registration of built-in stages
from . import rife as _rife  # noqa: E402, F401
from . import deepdream as _deepdream  # noqa: E402, F401
from . import withoutbg as _withoutbg  # noqa: E402, F401
from . import styletransfer as _styletransfer  # noqa: E402, F401
from . import speedramp as _speedramp  # noqa: E402, F401
from . import img2img as _img2img  # noqa: E402, F401
from . import upscale as _upscale  # noqa: E402, F401
from . import fastsam as _fastsam  # noqa: E402, F401
