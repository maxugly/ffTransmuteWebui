"""
Cooperative job cancellation + live progress for long-running ops.

Progress is polled by the UI via GET /api/job/{token} while the POST is open.

Directory watch: for opaque subprocesses (RIFE, ffmpeg dump) that write frames
to a known directory, a background thread counts PNG files every ~0.75 s and
reports progress so the UI never sits frozen on 0/N.
"""
from __future__ import annotations

import os
import re
import threading
import time
import uuid
from collections import deque
from typing import Any, Callable

# token -> Event (set means cancel requested)
_jobs: dict[str, threading.Event] = {}
# token -> progress snapshot
_progress: dict[str, dict[str, Any]] = {}
# token -> dir watch handle
_watches: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()
_tls = threading.local()

_WINDOW_S = 15.0       # sliding window for rate estimation
_WATCH_INTERVAL = 0.75  # seconds between dir scans
_MAX_SAMPLES = 60       # ring buffer cap


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
            "rate": None,
            "rate_h": None,
            "phase_started_at": now,
            "watch_dir": None,
            "watch_count": None,
            "latest_frame": None,
            "history": [],
            "_samples": deque(maxlen=_MAX_SAMPLES),
        }
    return ev


def unregister(token: str | None) -> None:
    if not token:
        return
    stop_dir_watch(token)
    with _lock:
        _jobs.pop(token, None)
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
    stop_dir_watch(token)
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
    if not token:
        return False
    stop_dir_watch(token)
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
    if is_cancelled():
        raise JobCancelled(getattr(_tls, "token", None))


def _compute_rate_eta(snap: dict[str, Any]) -> tuple[float | None, str | None, float | None]:
    """Compute phase-local rate and ETA from sample window.

    Returns (rate, rate_h, eta_s).  rate_h is a human string like "18/s".
    """
    cur = int(snap.get("current") or 0)
    tot = int(snap.get("total") or 0)
    samples: deque = snap.get("_samples", deque())
    phase_started = float(snap.get("phase_started_at") or snap.get("started_at") or time.time())
    now = time.time()

    rate: float | None = None
    rate_h: str | None = None

    # Window-based: look at samples in the last _WINDOW_S seconds
    recent = [(t, c) for t, c in samples if now - t <= _WINDOW_S]
    if len(recent) >= 2:
        dt = recent[-1][0] - recent[0][0]
        dc = recent[-1][1] - recent[0][1]
        if dt > 0.2 and dc > 0:
            rate = dc / dt
    elif cur > 0 and len(samples) >= 2:
        # Fallback: use all samples in this phase
        dt = samples[-1][0] - samples[0][0]
        dc = samples[-1][1] - samples[0][1]
        if dt > 0.5 and dc > 0:
            rate = dc / dt

    # Second fallback: use phase elapsed (first sample at 0)
    if rate is None and cur > 0:
        phase_elapsed = now - phase_started
        if phase_elapsed > 2.0:
            rate = cur / max(phase_elapsed, 1e-9)

    if rate is not None and rate > 1e-9:
        rate_h = f"{rate:.0f}/s" if rate >= 10 else f"{rate:.1f}/s"

    eta: float | None = None
    if rate is not None and rate > 1e-9 and tot > 0 and cur >= 0:
        remaining = max(0, tot - cur)
        if remaining <= 0:
            eta = 0.0
        else:
            eta = round(remaining / rate, 1)

    return rate, rate_h, eta


def report_progress(
    message: str = "",
    *,
    phase: str | None = None,
    current: int | None = None,
    total: int | None = None,
    unit: str | None = None,
    token: str | None = None,
    watch_dir: str | None = None,
    watch_count: int | None = None,
    latest_frame: str | None = None,
) -> None:
    """Update live progress for the bound (or explicit) job token.

    Phase-local rate & ETA: rate is computed from samples in the current
    phase using a short sliding window — never from job start.
    """
    tok = token or current_token()
    if not tok:
        return
    now = time.time()
    with _lock:
        snap = _progress.get(tok)
        if snap is None:
            return

        # Detect phase change → reset phase clock
        new_phase = phase if phase is not None else snap.get("phase")
        old_phase = snap.get("phase")
        if new_phase and new_phase != old_phase:
            snap["_samples"] = deque(maxlen=_MAX_SAMPLES)
            snap["phase_started_at"] = now

        if message:
            snap["message"] = message
            hist = snap.setdefault("history", [])
            hist.append({"t": now, "msg": message})
            if len(hist) > 200:
                del hist[:-200]
        if phase is not None:
            snap["phase"] = phase
        if current is not None:
            snap["current"] = int(current)
        if total is not None:
            snap["total"] = int(total)
        if unit is not None:
            snap["unit"] = unit
        if watch_dir is not None:
            snap["watch_dir"] = watch_dir
        if watch_count is not None:
            snap["watch_count"] = int(watch_count)
        if latest_frame is not None:
            snap["latest_frame"] = latest_frame

        # Record sample for rate computation
        cur = int(snap.get("current") or 0)
        samples: deque = snap.setdefault("_samples", deque(maxlen=_MAX_SAMPLES))
        samples.append((now, cur))

        if snap.get("status") == "running" or snap.get("status") == "cancelling":
            pass
        elif snap.get("status") not in ("done", "cancelled", "error"):
            snap["status"] = "running"

        # Compute rate / ETA
        rate, rate_h, eta = _compute_rate_eta(snap)

        tot = int(snap.get("total") or 0)
        pct = None
        if tot > 0 and cur >= 0:
            pct = round(100.0 * min(cur, tot) / tot, 1)

        snap["rate"] = rate
        snap["rate_h"] = rate_h
        snap["eta_s"] = eta
        snap["pct"] = pct
        snap["elapsed_s"] = round(now - float(snap.get("started_at") or now), 2)
        snap["updated_at"] = now


# ── Directory watch ────────────────────────────────────────────────────────

def _scan_pngs(directory: str | os.PathLike) -> tuple[int, str | None]:
    """Count *.png files and return (count, path_of_max_numbered_png)."""
    count = 0
    best_path: str | None = None
    best_num = -1
    try:
        for entry in os.scandir(directory):
            if not entry.is_file() or not entry.name.endswith(".png"):
                continue
            count += 1
            m = re.search(r"(\d+)", entry.name)
            if m:
                n = int(m.group(1))
                if n > best_num:
                    best_num = n
                    best_path = entry.path
            elif best_path is None:
                best_path = entry.path
    except (OSError, FileNotFoundError):
        pass
    return count, best_path


def _dir_watch_loop(token: str, directory: str, total: int, phase: str,
                    unit: str, message: str) -> None:
    while True:
        with _lock:
            info = _watches.get(token)
            if not info or info.get("stopped"):
                break

        if is_cancelled(token):
            break

        count, latest = _scan_pngs(directory)

        report_progress(
            message or f"{phase} {count}/{total} {unit}",
            phase=phase, current=count, total=total, unit=unit,
            token=token, watch_dir=directory, watch_count=count,
            latest_frame=latest,
        )

        if count >= total > 0:
            break

        time.sleep(_WATCH_INTERVAL)


def start_dir_watch(
    token: str,
    directory: str | os.PathLike,
    total: int,
    phase: str,
    unit: str = "frames",
    message: str | None = None,
) -> str:
    """Start a background watch thread that counts files and reports progress.

    Returns the token (handle).  Call ``stop_dir_watch(token)`` to end.
    """
    stop_dir_watch(token)
    d = str(directory)

    t = threading.Thread(
        target=_dir_watch_loop,
        args=(token, d, total, phase, unit, message or ""),
        daemon=True,
    )
    with _lock:
        _watches[token] = {"thread": t, "stopped": False}
    t.start()
    return token


def stop_dir_watch(token: str) -> None:
    """Stop watching a directory.  Idempotent — safe to call multiple times."""
    with _lock:
        info = _watches.pop(token, None)
        if info:
            info["stopped"] = True


def get_progress(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    with _lock:
        snap = _progress.get(token)
        if not snap:
            return None
        out = dict(snap)
        # Strip internal fields
        out.pop("_samples", None)
        out["history"] = list(snap.get("history") or [])
        out["active"] = token in _jobs
        return out


def list_live_and_recent(*, recent_cap: int = 40) -> dict[str, Any]:
    """Read-only overview for the Jobs tab (does not affect cancellation or run).

    - live: tokens currently registered (in-flight server ops, including direct Run)
    - recent: finished/cancelled/error snapshots still held in memory
    """
    live: list[dict[str, Any]] = []
    recent: list[dict[str, Any]] = []
    with _lock:
        for token, snap in _progress.items():
            out = dict(snap)
            out.pop("_samples", None)
            out["history"] = list(snap.get("history") or [])
            out["active"] = token in _jobs
            out["token"] = token
            status = (out.get("status") or "").lower()
            if token in _jobs or status in ("running", "cancelling", "start"):
                live.append(out)
            elif status in ("done", "cancelled", "error", "failed"):
                recent.append(out)
    recent.sort(key=lambda s: float(s.get("updated_at") or 0), reverse=True)
    live.sort(key=lambda s: float(s.get("started_at") or 0))
    return {
        "live": live,
        "recent": recent[: max(1, int(recent_cap))],
        "live_count": len(live),
    }


def cancel_callback() -> Callable[[], None]:
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
