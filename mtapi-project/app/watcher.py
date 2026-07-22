"""
Folder watcher: when enabled, poll an input directory for new videos and
transcode them to DNxHR-LB .mov (Resolve-friendly) in the output directory.

Controlled via GET/POST /api/watcher. Default is OFF — never starts at boot
unless the API turns it on (and still defaults enabled=false on disk).
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

from .pathutil import unique_output_path

log = logging.getLogger("mtapi.watcher")

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".mpeg", ".mpg", ".wmv", ".mts", ".m2ts"}
POLL_S = 2.0
STABLE_S = 1.5  # file size must be unchanged this long before we take it
MAX_LOG = 80

_CONFIG_DIR = Path(__file__).resolve().parent.parent / "data"
_CONFIG_PATH = _CONFIG_DIR / "watcher.json"


@dataclass
class WatcherState:
    enabled: bool = False
    in_dir: str = ""
    out_dir: str = ""
    # 16:9 letterbox target AR (matches 2mv defaults; pixels used only for AR)
    target_width: int = 1920
    target_height: int = 1080
    resize_mode: str = "letterbox"  # letterbox | crop
    last_error: str | None = None
    last_event: str | None = None
    processing: str | None = None
    processed_count: int = 0
    failed_count: int = 0
    log_lines: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        d = asdict(self)
        d["running"] = _thread is not None and _thread.is_alive() and self.enabled
        d["in_dir_ok"] = bool(self.in_dir and Path(self.in_dir).expanduser().is_dir())
        d["out_dir_ok"] = bool(self.out_dir and Path(self.out_dir).expanduser().is_dir())
        return d


_state = WatcherState()
_lock = threading.RLock()
_stop = threading.Event()
_thread: threading.Thread | None = None
_seen_sizes: dict[str, tuple[int, float]] = {}  # path -> (size, first_stable_ts)
_processed_names: set[str] = set()


def _log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    log.info("%s", msg)
    with _lock:
        _state.log_lines.append(line)
        if len(_state.log_lines) > MAX_LOG:
            _state.log_lines = _state.log_lines[-MAX_LOG:]
        _state.last_event = msg


def _load_config() -> None:
    global _state
    if not _CONFIG_PATH.is_file():
        return
    try:
        data = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        with _lock:
            _state.enabled = False  # never auto-enable on process start
            _state.in_dir = str(data.get("in_dir") or "")
            _state.out_dir = str(data.get("out_dir") or "")
            _state.target_width = int(data.get("target_width") or 1920)
            _state.target_height = int(data.get("target_height") or 1080)
            mode = str(data.get("resize_mode") or "letterbox")
            _state.resize_mode = mode if mode in ("letterbox", "crop") else "letterbox"
    except Exception as e:
        log.warning("watcher config load failed: %s", e)


def _save_config() -> None:
    with _lock:
        payload = {
            "in_dir": _state.in_dir,
            "out_dir": _state.out_dir,
            "target_width": _state.target_width,
            "target_height": _state.target_height,
            "resize_mode": _state.resize_mode,
            # enabled intentionally NOT persisted as true boot default
            "enabled": False,
        }
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _CONFIG_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    except Exception as e:
        log.warning("watcher config save failed: %s", e)


def get_status() -> dict[str, Any]:
    with _lock:
        return _state.public()


def apply_config(
    *,
    enabled: bool | None = None,
    in_dir: str | None = None,
    out_dir: str | None = None,
    target_width: int | None = None,
    target_height: int | None = None,
    resize_mode: str | None = None,
) -> dict[str, Any]:
    with _lock:
        if in_dir is not None:
            _state.in_dir = str(in_dir).strip()
        if out_dir is not None:
            _state.out_dir = str(out_dir).strip()
        if target_width is not None:
            _state.target_width = max(2, int(target_width))
        if target_height is not None:
            _state.target_height = max(2, int(target_height))
        if resize_mode is not None:
            rm = str(resize_mode).strip().lower()
            if rm in ("letterbox", "crop"):
                _state.resize_mode = rm
        want_on = _state.enabled if enabled is None else bool(enabled)

        if want_on:
            err = _validate_dirs_unlocked()
            if err:
                _state.last_error = err
                _state.enabled = False
                _save_config_unlocked()
                return _state.public()
            _state.last_error = None
            _state.enabled = True
        else:
            _state.enabled = False
            _state.processing = None

        _save_config_unlocked()

    if want_on:
        _ensure_thread()
    else:
        _stop.set()

    with _lock:
        return _state.public()


def _save_config_unlocked() -> None:
    payload = {
        "in_dir": _state.in_dir,
        "out_dir": _state.out_dir,
        "target_width": _state.target_width,
        "target_height": _state.target_height,
        "resize_mode": _state.resize_mode,
        "enabled": False,
    }
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _CONFIG_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    except Exception as e:
        log.warning("watcher config save failed: %s", e)


def _validate_dirs_unlocked() -> str | None:
    if not _state.in_dir:
        return "Input directory is required"
    if not _state.out_dir:
        return "Output directory is required"
    inp = Path(_state.in_dir).expanduser()
    out = Path(_state.out_dir).expanduser()
    if not inp.is_dir():
        return f"Input is not a directory: {inp}"
    if not out.is_dir():
        try:
            out.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            return f"Cannot create output directory: {e}"
    if inp.resolve() == out.resolve():
        return "Input and output directories must be different"
    return None


def _ensure_thread() -> None:
    global _thread
    _stop.clear()
    if _thread is not None and _thread.is_alive():
        return
    _thread = threading.Thread(target=_loop, name="mtapi-watcher", daemon=True)
    _thread.start()
    _log("watcher started")


def _loop() -> None:
    while not _stop.is_set():
        with _lock:
            on = _state.enabled
            in_dir = _state.in_dir
            out_dir = _state.out_dir
            tw = _state.target_width
            th = _state.target_height
            mode = _state.resize_mode
        if not on:
            break
        try:
            _scan_once(in_dir, out_dir, tw, th, mode)
        except Exception as e:
            with _lock:
                _state.last_error = str(e)
            _log(f"scan error: {e}")
        _stop.wait(POLL_S)
    with _lock:
        _state.processing = None
    _log("watcher stopped")


def _scan_once(in_dir: str, out_dir: str, tw: int, th: int, mode: str) -> None:
    root = Path(in_dir).expanduser()
    if not root.is_dir():
        return
    now = time.time()
    candidates: list[Path] = []
    for p in sorted(root.iterdir()):
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.suffix.lower() not in VIDEO_EXTS:
            continue
        key = str(p)
        try:
            size = p.stat().st_size
        except OSError:
            continue
        if size <= 0:
            continue
        prev = _seen_sizes.get(key)
        if prev is None or prev[0] != size:
            _seen_sizes[key] = (size, now)
            continue
        # size stable
        if now - prev[1] < STABLE_S:
            continue
        if key in _processed_names:
            continue
        candidates.append(p)

    for p in candidates:
        with _lock:
            if not _state.enabled:
                return
            _state.processing = p.name
        ok = _process_one(p, Path(out_dir).expanduser(), tw, th, mode)
        with _lock:
            _state.processing = None
            if ok:
                _state.processed_count += 1
                _processed_names.add(str(p))
                _seen_sizes.pop(str(p), None)
            else:
                _state.failed_count += 1
                # don't immediately retry forever — mark seen so we skip until restart/size change
                _processed_names.add(str(p))


def _probe_dims(path: Path) -> tuple[int, int] | None:
    try:
        r = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "csv=s=x:p=0",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        line = (r.stdout or "").strip().splitlines()
        if not line:
            return None
        w, h = line[0].split("x", 1)
        return int(w), int(h)
    except Exception:
        return None


def _has_audio(path: Path) -> bool:
    try:
        r = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "a",
                "-show_entries", "stream=codec_type",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        return "audio" in (r.stdout or "")
    except Exception:
        return False


def _vf_for(iw: int, ih: int, tw: int, th: int, mode: str) -> str:
    """Match 2mv: keep native pixels when AR matches; else crop or letterbox without scale-up."""
    in_ar = iw / ih if ih else 1.0
    tg_ar = tw / th if th else 1.0
    if abs(in_ar - tg_ar) < 0.01:
        return "scale=trunc(iw/2)*2:trunc(ih/2)*2"

    iw_e = (iw // 2) * 2
    ih_e = (ih // 2) * 2
    if mode == "crop":
        if in_ar > tg_ar:
            ow = int((ih_e * tg_ar) / 2) * 2
            oh = ih_e
        else:
            ow = iw_e
            oh = int((iw_e / tg_ar) / 2) * 2
        return f"scale=trunc(iw/2)*2:trunc(ih/2)*2,crop={ow}:{oh}"
    # letterbox
    if in_ar > tg_ar:
        ow = iw_e
        oh = int((iw_e / tg_ar) / 2) * 2
    else:
        ow = int((ih_e * tg_ar) / 2) * 2
        oh = ih_e
    return f"scale=trunc(iw/2)*2:trunc(ih/2)*2,pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2:color=black"


def _process_one(src: Path, out_dir: Path, tw: int, th: int, mode: str) -> bool:
    _log(f"processing {src.name}")
    out_dir.mkdir(parents=True, exist_ok=True)
    base = src.stem
    dest = unique_output_path(out_dir / f"{base}_resolve.mov")
    work = dest.with_suffix(".partial.mov")

    dims = _probe_dims(src)
    if dims:
        vf = _vf_for(dims[0], dims[1], tw, th, mode)
    else:
        vf = "scale=trunc(iw/2)*2:trunc(ih/2)*2"

    has_a = _has_audio(src)
    if has_a:
        cmd = [
            "ffmpeg", "-hide_banner", "-y", "-i", str(src),
            "-vf", vf,
            "-c:v", "dnxhd", "-profile:v", "dnxhr_lb", "-pix_fmt", "yuv422p",
            "-c:a", "pcm_s16le",
            "-loglevel", "warning",
            str(work),
        ]
    else:
        cmd = [
            "ffmpeg", "-hide_banner", "-y",
            "-i", str(src),
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-vf", vf,
            "-c:v", "dnxhd", "-profile:v", "dnxhr_lb", "-pix_fmt", "yuv422p",
            "-c:a", "pcm_s16le",
            "-shortest",
            "-loglevel", "warning",
            str(work),
        ]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600 * 6, check=False)
    except Exception as e:
        with _lock:
            _state.last_error = str(e)
        _log(f"failed {src.name}: {e}")
        work.unlink(missing_ok=True)
        return False

    if r.returncode != 0:
        err = (r.stderr or r.stdout or "ffmpeg failed")[-500:]
        with _lock:
            _state.last_error = err
        _log(f"failed {src.name}: {err.splitlines()[-1] if err else 'ffmpeg error'}")
        work.unlink(missing_ok=True)
        return False

    try:
        work.replace(dest)
    except Exception:
        shutil.move(str(work), str(dest))

    # Move original next to a "done" sibling of in_dir if possible, else leave it
    dun = src.parent / "dun"
    try:
        dun.mkdir(exist_ok=True)
        shutil.move(str(src), str(dun / src.name))
    except Exception:
        # if move fails (permissions), leave source; already marked processed
        pass

    with _lock:
        _state.last_error = None
    _log(f"done → {dest.name}")
    return True


# Load paths on import; never auto-start.
_load_config()
