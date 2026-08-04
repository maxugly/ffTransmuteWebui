"""In-memory FIFO job queue — one running op at a time.

See docs/job-queue-spec.md. Pending survives only in process memory (v1).
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass
from typing import Any, Literal

log = logging.getLogger("mtapi.job_queue")

Status = Literal["pending", "running", "done", "failed", "cancelled"]
HISTORY_CAP = 50


@dataclass
class QueueItem:
    id: str
    op_id: str
    body: dict[str, Any]
    label: str
    created_at: float
    status: Status = "pending"
    error: str | None = None
    result_summary: str | None = None
    started_at: float | None = None
    finished_at: float | None = None


_pending: deque[QueueItem] = deque()
_history: list[QueueItem] = []
_running: QueueItem | None = None
_lock = asyncio.Lock()
_wake = asyncio.Event()
_worker_task: asyncio.Task | None = None
_direct_busy = False  # true while a direct /ops/* POST is in flight


def set_direct_busy(busy: bool) -> None:
    global _direct_busy
    _direct_busy = bool(busy)
    if not busy:
        _wake.set()


def is_busy() -> bool:
    return _running is not None or _direct_busy


def _item_public(it: QueueItem) -> dict[str, Any]:
    d = asdict(it)
    # body can be large — keep for pending display of paths only
    return d


async def enqueue(op_id: str, body: dict[str, Any], label: str | None = None) -> dict[str, Any]:
    from .contract import REGISTRY

    if op_id not in REGISTRY:
        return {"ok": False, "error": f"unknown op: {op_id}"}
    item = QueueItem(
        id=uuid.uuid4().hex,
        op_id=op_id,
        body=dict(body or {}),
        label=(label or op_id).strip() or op_id,
        created_at=time.time(),
    )
    async with _lock:
        _pending.append(item)
        pos = len(_pending)
    _wake.set()
    log.info("queue enqueue %s %s pos=%s", item.id[:8], op_id, pos)
    return {"ok": True, "id": item.id, "position": pos, "label": item.label}


async def snapshot() -> dict[str, Any]:
    async with _lock:
        return {
            "ok": True,
            "busy": is_busy(),
            "direct_busy": _direct_busy,
            "running": _item_public(_running) if _running else None,
            "pending": [_item_public(x) for x in _pending],
            "history": [_item_public(x) for x in list(_history)[:HISTORY_CAP]],
            "pending_count": len(_pending),
        }


async def remove_pending(item_id: str) -> dict[str, Any]:
    async with _lock:
        for i, it in enumerate(_pending):
            if it.id == item_id:
                del _pending[i]
                return {"ok": True, "id": item_id, "removed": True}
    return {"ok": False, "error": "not pending", "id": item_id}


async def clear_pending() -> dict[str, Any]:
    async with _lock:
        n = len(_pending)
        _pending.clear()
    return {"ok": True, "cleared": n}


async def cancel_item(item_id: str) -> dict[str, Any]:
    from . import job_control

    async with _lock:
        for i, it in enumerate(_pending):
            if it.id == item_id:
                del _pending[i]
                it.status = "cancelled"
                it.finished_at = time.time()
                _push_history(it)
                return {"ok": True, "id": item_id, "status": "cancelled"}
        if _running and _running.id == item_id:
            job_control.request_cancel(item_id)
            return {"ok": True, "id": item_id, "status": "cancelling"}
    return {"ok": False, "error": "not found", "id": item_id}


def _push_history(item: QueueItem) -> None:
    _history.insert(0, item)
    del _history[HISTORY_CAP:]


async def _run_one(item: QueueItem) -> None:
    from . import job_control
    from .contract import REGISTRY
    from .op_runner import run_registered_op

    global _running
    spec = REGISTRY.get(item.op_id)
    if not spec:
        item.status = "failed"
        item.error = f"unknown op: {item.op_id}"
        item.finished_at = time.time()
        async with _lock:
            _push_history(item)
            _running = None
        return

    item.status = "running"
    item.started_at = time.time()
    async with _lock:
        _running = item

    try:
        params = spec.params_model(**item.body)
        result = await run_registered_op(spec, params, token=item.id)
        if result and getattr(result, "ok", False):
            item.status = "done"
            item.result_summary = getattr(result, "output_path", None) or "ok"
        else:
            err = (result.error if result else "failed") or "failed"
            if err == "Cancelled by user":
                item.status = "cancelled"
            else:
                item.status = "failed"
            item.error = err
            item.result_summary = err
    except job_control.JobCancelled:
        item.status = "cancelled"
        item.error = "Cancelled by user"
    except Exception as e:
        log.exception("queue job %s failed", item.id[:8])
        item.status = "failed"
        item.error = str(e)[:500]
        item.result_summary = item.error
    finally:
        item.finished_at = time.time()
        async with _lock:
            _push_history(item)
            _running = None
        _wake.set()


async def _worker_loop() -> None:
    log.info("job queue worker started")
    while True:
        try:
            await _wake.wait()
            _wake.clear()
            while True:
                if _direct_busy:
                    break
                async with _lock:
                    if _running is not None or not _pending:
                        item = None
                    else:
                        item = _pending.popleft()
                if item is None:
                    break
                await _run_one(item)
        except asyncio.CancelledError:
            log.info("job queue worker cancelled")
            raise
        except Exception:
            log.exception("job queue worker error — continuing")
            await asyncio.sleep(0.5)


def start_worker() -> None:
    global _worker_task
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.create_task(_worker_loop(), name="mtapi-job-queue")
