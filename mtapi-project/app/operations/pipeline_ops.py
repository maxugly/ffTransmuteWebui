"""
Dynamic mixing pipeline — POST /ops/pipeline.

Resolves stages from app.filters.STAGE_REGISTRY (plus local identity until
that moves). Supports per_frame and directory stages via PipelineChain.
"""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control
from ..job_workspace import JobWorkspace
from ..pipeline_chain import PipelineChain
from ..filters import get_stage_factory, list_stages


# identity stays local (trivial). deepdream + rife live in app.filters.
_LOCAL_REGISTRY: dict[str, Callable[..., Any]] = {}


def _register_local(name: str, factory: Callable[..., Any]) -> None:
    _LOCAL_REGISTRY[name] = factory


async def _identity_filter(src: Path, dst: Path, index: int) -> None:
    shutil.copy2(src, dst)


_register_local("identity", lambda **kw: _identity_filter)


def _resolve_factory(name: str) -> Callable[..., Any] | None:
    return get_stage_factory(name) or _LOCAL_REGISTRY.get(name)


def _available_filters() -> list[str]:
    names = set(list_stages()) | set(_LOCAL_REGISTRY.keys())
    return sorted(names)


class PipelineFilter(BaseModel):
    name: str = Field(..., description="Filter name from stage registry")
    params: dict[str, Any] = Field(default_factory=dict, description="Filter-specific kwargs")


class PipelineParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    filters: list[PipelineFilter] = Field(..., description="Ordered list of filters to apply")
    dry_run: bool = Field(False, description="Print planned chain without executing")


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
            stdout=(
                f"Chain: {' → '.join(filter_names)}\n"
                f"Available: {', '.join(_available_filters())}\n"
                f"Output: {out}\n"
            ),
        )

    chain: list[tuple[str, Any]] = []
    for fspec in p.filters:
        factory = _resolve_factory(fspec.name)
        if factory is None:
            return OperationResult(
                ok=False, operation="pipeline",
                error=(
                    f"Unknown filter: '{fspec.name}' "
                    f"(available: {_available_filters()})"
                ),
            )
        try:
            stage_fn = factory(**fspec.params)
        except Exception as e:
            return OperationResult(
                ok=False, operation="pipeline",
                error=f"Failed to create filter '{fspec.name}': {e}",
            )
        chain.append((fspec.name, stage_fn))

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
        "Supports per_frame and directory stages (e.g. rife). "
        "Available: " + ", ".join(_available_filters()) + "."
    ),
    params_model=PipelineParams,
    handler=pipeline_run,
    tags=["pipeline", "multi", "chain", "filter"],
))
