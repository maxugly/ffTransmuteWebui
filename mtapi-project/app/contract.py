"""
The operation contract.

Every tool in this API — whether it shells out to transmute, datamosh.sh,
or something added next month — is one OperationSpec: a typed Pydantic
params model, an async handler that takes an instance of that model and
returns an OperationResult, plus some display metadata.

main.py turns every registered OperationSpec into its own POST route at
startup. Nothing in here knows about FastAPI, HTTP, or ffmpeg — it's just
the shape that both sides (routes on one end, tool wrappers on the other)
agree to.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Type

from pydantic import BaseModel, Field


class OperationResult(BaseModel):
    """What every operation hands back, success or failure."""

    ok: bool
    operation: str = Field(description="id of the operation that produced this result")
    output_path: str | None = Field(None, description="Path to the file this operation produced")
    dry_run: bool = Field(False, description="True if this was a dry run — output_path is what WOULD be written, not a real file")
    command: str | None = Field(None, description="The underlying shell command, when the tool reports it")
    stdout: str = ""
    stderr: str = ""
    error: str | None = Field(None, description="Set when ok is False — short, human-readable failure reason")


@dataclass
class OperationSpec:
    id: str
    summary: str
    description: str
    params_model: Type[BaseModel]
    handler: Callable[[BaseModel], Awaitable[OperationResult]]
    tags: list[str] = field(default_factory=list)


REGISTRY: dict[str, OperationSpec] = {}


def register(spec: OperationSpec) -> None:
    if spec.id in REGISTRY:
        raise ValueError(f"duplicate operation id: {spec.id!r} (already registered)")
    REGISTRY[spec.id] = spec
