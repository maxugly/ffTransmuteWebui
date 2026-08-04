"""Shared execution path for POST /ops/* and the job queue worker."""
from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel

from . import job_control
from . import media
from .contract import OperationResult, OperationSpec

log = logging.getLogger("mtapi.op_runner")


def _params_input_path(params: BaseModel) -> str | None:
    for key in ("input_path", "image_a", "image_path"):
        v = getattr(params, key, None)
        if isinstance(v, str) and v.strip():
            return v.strip()
    paths = getattr(params, "image_paths", None) or getattr(params, "input_paths", None)
    if isinstance(paths, list) and paths:
        return str(paths[0])
    return None


async def run_registered_op(
    spec: OperationSpec,
    params: BaseModel,
    *,
    token: str,
) -> OperationResult:
    """Register/bind/progress/finish lifecycle around a registry handler."""
    job_control.register(token, operation=spec.id)
    job_control.bind(token)
    job_control.report_progress(
        f"running {spec.id}",
        phase="start",
        current=0,
        total=0,
        token=token,
    )
    result: OperationResult | None = None
    try:
        result = await spec.handler(params)
        if result and not result.ok and result.error == "Cancelled by user":
            job_control.finish(token, status="cancelled", message="Cancelled by user")
        elif result and result.ok:
            job_control.finish(token, status="done", message="complete")
        else:
            job_control.finish(
                token,
                status="error",
                message=(result.error if result else "failed") or "failed",
            )
    except job_control.JobCancelled:
        log.info("op %s cancelled (token=%s…)", spec.id, token[:8])
        job_control.finish(token, status="cancelled", message="Cancelled by user")
        result = OperationResult(
            ok=False,
            operation=spec.id,
            error="Cancelled by user",
            dry_run=False,
        )
    except Exception as e:
        if "Cancelled by user" in str(e):
            job_control.finish(token, status="cancelled", message="Cancelled by user")
            result = OperationResult(
                ok=False,
                operation=spec.id,
                error="Cancelled by user",
                dry_run=False,
            )
        else:
            job_control.finish(token, status="error", message=str(e)[:200])
            job_control.unregister(token)
            raise
    finally:
        job_control.unregister(token)

    if result is None:
        result = OperationResult(ok=False, operation=spec.id, error="no result")

    try:
        await media.record_operation(
            _params_input_path(params),
            operation=spec.id,
            output_path=result.output_path,
            ok=result.ok,
            dry_run=result.dry_run,
        )
    except Exception as e:
        log.warning("media history hook failed for %s: %s", spec.id, e)

    return result
