"""
Dynamic mixing pipeline — POST /ops/pipeline.

Accepts an ordered list of filters applied to a single input video.
Each filter is resolved by name from the FILTER_REGISTRY.
Runs disk-based cascading stages via PipelineChain + JobWorkspace.
"""
from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control
from ..job_workspace import JobWorkspace
from ..pipeline_chain import PipelineChain
from ..video_pipeline import FilterFn

import uuid


# ── filter registry ────────────────────────────────────────────────────────

FILTER_REGISTRY: dict[str, Callable[..., FilterFn]] = {}


def _register_filter(name: str, factory: Callable[..., FilterFn]) -> None:
    FILTER_REGISTRY[name] = factory


# ── identity filter ────────────────────────────────────────────────────────

async def _identity_filter(src: Path, dst: Path, index: int) -> None:
    shutil.copy2(src, dst)

_register_filter("identity", lambda **kw: _identity_filter)


# ── deepdream filter ───────────────────────────────────────────────────────

def _make_deepdream_filter(**kw) -> FilterFn:
    from .deepdream.dream import dream_image
    import numpy as np
    from PIL import Image as PILImage

    image_kwargs = {k: v for k, v in kw.items() if k not in ("temporal_blend", "optical_flow")}

    last_arr = None

    async def _filter(src: Path, dst: Path, index: int) -> None:
        nonlocal last_arr
        # temporal blend
        curr = np.asarray(PILImage.open(src).convert("RGB"))
        dream_src = src
        if last_arr is not None and float(kw.get("temporal_blend", 1.0)) < 1.0:
            from .deepdream.dream import linear_blend
            blended = linear_blend(last_arr, curr, float(kw.get("temporal_blend", 0.85)))
            seed = dst.parent / f"_seed_{index:06d}.png"
            PILImage.fromarray(blended).save(seed)
            dream_src = seed
        dream_image(dream_src, dst, progress_cb=None, **image_kwargs)
        last_arr = np.asarray(PILImage.open(dst).convert("RGB"))

    return _filter


_register_filter("deepdream", _make_deepdream_filter)


# ── rife filter ────────────────────────────────────────────────────────────

_register_filter("rife", lambda **kw: None)  # placeholder — rife needs special handling


# ── pipeline params ────────────────────────────────────────────────────────

class PipelineFilter(BaseModel):
    name: str = Field(..., description="Filter name from FILTER_REGISTRY")
    params: dict[str, Any] = Field(default_factory=dict, description="Filter-specific kwargs")


class PipelineParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    filters: list[PipelineFilter] = Field(..., description="Ordered list of filters to apply")
    dry_run: bool = Field(False, description="Print planned chain without executing")


# ── handler ────────────────────────────────────────────────────────────────

async def pipeline_run(p: PipelineParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="pipeline",
            error=f"Input not found: {input_path}",
        )

    from ..pathutil import finalize_output_path

    out = finalize_output_path(
        p.output_path or None,
        source=input_path,
        default_suffix="_chain",
        default_ext=".mp4",
        allowed_exts={".mp4", ".mkv", ".mov", ".webm"},
    )

    filter_names = [f.name for f in p.filters]
    summary = f"pipeline: {' → '.join(filter_names)}"

    if p.dry_run:
        return OperationResult(
            ok=True, operation="pipeline", output_path=str(out),
            dry_run=True, command=summary,
            stdout=f"Chain: {' → '.join(filter_names)}\nOutput: {out}\n",
        )

    # Resolve filters
    chain: list[tuple[str, FilterFn]] = []
    for i, fspec in enumerate(p.filters):
        factory = FILTER_REGISTRY.get(fspec.name)
        if factory is None:
            return OperationResult(
                ok=False, operation="pipeline",
                error=f"Unknown filter: '{fspec.name}' (available: {list(FILTER_REGISTRY.keys())})",
            )
        try:
            filter_fn = factory(**fspec.params)
        except Exception as e:
            return OperationResult(
                ok=False, operation="pipeline",
                error=f"Failed to create filter '{fspec.name}': {e}",
            )
        chain.append((fspec.name, filter_fn))

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="chain_")
    success = False
    logs: list[str] = [summary]

    def progress_cb(msg: str, current: int, total: int) -> None:
        job_control.report_progress(
            msg, phase="pipeline", current=current, total=total, unit="frames",
        )

    try:
        pipe = PipelineChain(ws, chain)
        result_path = await pipe.run(
            input_path, out, progress_cb=progress_cb,
        )
        success = True
        logs.append(f"Output: {result_path}")

        return OperationResult(
            ok=True, operation="pipeline", output_path=str(result_path),
            command=summary, stdout="\n".join(logs),
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation="pipeline", error=str(e),
            command=summary, stdout="\n".join(logs), stderr=str(e),
        )
    finally:
        ws.cleanup(keep_on_failure=not success)


register(OperationSpec(
    id="pipeline",
    summary="Dynamic mixing pipeline — chain multiple filters",
    description=(
        "Apply an ordered list of filters to a single input video. "
        "Each filter processes every frame through cascading stage directories. "
        "Available filters: " + ", ".join(FILTER_REGISTRY.keys()) + "."
    ),
    params_model=PipelineParams,
    handler=pipeline_run,
    tags=["pipeline", "multi", "chain"],
))
