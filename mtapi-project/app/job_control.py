"""
Cooperative job cancellation + live progress for long-running ops (DeepDream).

Not magic — Python/ffmpeg won't always die mid-syscall — but loops that call
``check_cancelled()`` will stop cleanly when the user hits Stop.

Progress is polled by the UI via GET /api/job/{token} while the POST is open.
"""
from __future__ import annotations

import threading
import time
import uuid
from typing import Any, Callable

# token -> Event (set means cancel requested)
_jobs: dict[str, threading.Event] = {}
# token -> progress snapshot
_progress: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()
_tls = threading.local()


class JobCancelled(Exception):
    """Raised by check_cancelled() when the user requested a stop."""

    def __init__(self, token: str | None = None):
        self.token = token
        super().__init__("Cancelled by user")


def new_token() -> str:
    return uuid.uuid4().hex


def register(token: str, *, operation: str | None = None) -> threading.Event:
    ev = threading.Event()
    now = time.time()
    with _lock:
        _jobs[token] = ev
        _progress[token] = {
            "token": token,
            "operation": operation,
            "status": "running",
            "message": "starting…",
            "phase": "start",
            "current": 0,
            "total": 0,
            "unit": "",
            "started_at": now,
            "updated_at": now,
            "elapsed_s": 0.0,
            "eta_s": None,
            "pct": None,
            "history": [],  # recent messages (tail)
        }
    return ev


def unregister(token: str | None) -> None:
    if not token:
        return
    with _lock:
        _jobs.pop(token, None)
        # Keep last progress snapshot so UI can read final status after POST ends
        snap = _progress.get(token)
        if snap is not None:
            now = time.time()
            if snap.get("status") in (None, "running", "cancelling", "start"):
                snap["status"] = "done"
            snap["updated_at"] = now
            snap["elapsed_s"] = round(now - float(snap.get("started_at") or now), 2)
    if getattr(_tls, "token", None) == token:
        _tls.token = None
        _tls.event = None


def finish(token: str | None, *, status: str = "done", message: str | None = None) -> None:
    if not token:
        return
    with _lock:
        snap = _progress.get(token)
        if not snap:
            return
        now = time.time()
        snap["status"] = status
        if message:
            snap["message"] = message
        snap["updated_at"] = now
        snap["elapsed_s"] = round(now - float(snap.get("started_at") or now), 2)
        if status in ("done", "cancelled", "error"):
            snap["eta_s"] = 0.0 if status == "done" else snap.get("eta_s")


def bind(token: str | None) -> None:
    """Bind token to this thread (call inside worker threads)."""
    if not token:
        _tls.token = None
        _tls.event = None
        return
    with _lock:
        ev = _jobs.get(token)
    _tls.token = token
    _tls.event = ev


def current_token() -> str | None:
    return getattr(_tls, "token", None)


def request_cancel(token: str) -> bool:
    """Mark a job cancelled. Returns True if the job was still registered."""
    if not token:
        return False
    with _lock:
        ev = _jobs.get(token)
        snap = _progress.get(token)
        if snap is not None:
            snap["status"] = "cancelling"
            snap["message"] = "cancel requested…"
            snap["updated_at"] = time.time()
    if ev is None:
        return False
    ev.set()
    return True


def is_cancelled(token: str | None = None) -> bool:
    tok = token or getattr(_tls, "token", None)
    if not tok:
        return False
    with _lock:
        ev = _jobs.get(tok)
    return bool(ev and ev.is_set())


def check_cancelled() -> None:
    """Raise JobCancelled if the current bound job was stopped."""
    if is_cancelled():
        raise JobCancelled(getattr(_tls, "token", None))


def report_progress(
    message: str = "",
    *,
    phase: str | None = None,
    current: int | None = None,
    total: int | None = None,
    unit: str | None = None,
    token: str | None = None,
) -> None:
    """Update live progress for the bound (or explicit) job token."""
    tok = token or current_token()
    if not tok:
        return
    now = time.time()
    with _lock:
        snap = _progress.get(tok)
        if snap is None:
            return
        started = float(snap.get("started_at") or now)
        elapsed = now - started
        if message:
            snap["message"] = message
            hist = snap.setdefault("history", [])
            hist.append({"t": now, "msg": message})
            if len(hist) > 40:
                del hist[:-40]
        if phase is not None:
            snap["phase"] = phase
        if current is not None:
            snap["current"] = int(current)
        if total is not None:
            snap["total"] = int(total)
        if unit is not None:
            snap["unit"] = unit

        cur = int(snap.get("current") or 0)
        tot = int(snap.get("total") or 0)
        pct = None
        eta = None
        if tot > 0 and cur >= 0:
            pct = round(100.0 * min(cur, tot) / tot, 1)
            if cur > 0 and elapsed > 0.5:
                rate = cur / elapsed
                remaining = max(0, tot - cur)
                eta = round(remaining / rate, 1) if rate > 1e-9 else None
        snap["pct"] = pct
        snap["eta_s"] = eta
        snap["elapsed_s"] = round(elapsed, 2)
        snap["updated_at"] = now
        if snap.get("status") == "running" or snap.get("status") == "cancelling":
            pass
        elif snap.get("status") not in ("done", "cancelled", "error"):
            snap["status"] = "running"


def get_progress(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    with _lock:
        snap = _progress.get(token)
        if not snap:
            return None
        # copy so callers can't mutate
        out = dict(snap)
        out["history"] = list(snap.get("history") or [])
        # still active?
        out["active"] = token in _jobs
        return out


def cancel_callback() -> Callable[[], None]:
    """Return a zero-arg callback that raises JobCancelled when needed."""

    def _cb() -> None:
        check_cancelled()

    return _cb


def format_duration(seconds: float | None) -> str:
    if seconds is None:
        return "—"
    s = max(0, int(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m {sec:02d}s"
    if m:
        return f"{m}m {sec:02d}s"
    return f"{sec}s"
