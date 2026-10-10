"""AI Rapper saved-track library: one JSON document per song under
~/.cache/mtapi/airapper.

Pure storage helpers — no FastAPI, no subprocess. The thin HTTP surface in
`routes/airapper.py` builds on this module; nothing else should.

Two-layer discipline (spec §4): this library is NOT the desk snapshot. The
workspace tiles (lyrics, tempo, key …) persist through the existing
`state.formState[tab]` capture that rides `pool_state.json` and
`*.ffproject.json`. This module holds only what the user explicitly saved as a
*song* — the same class of document as the skills library.

ORTHOGONAL to named projects: this library is never written into
`*.ffproject.json`. A saved song outlives any project.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

INDEX_VERSION = 1

MAX_TRACKS = 500
MAX_LYRICS_BYTES = 512 * 1024
MAX_TITLE_CHARS = 200
MAX_DESCRIPTION_CHARS = 2000
MAX_TAGS = 32
MAX_TAG_CHARS = 64
MAX_DETAIL_BYTES = 1024 * 1024

# Fields the store owns. Anything else in a posted payload is dropped, so a
# client cannot smuggle arbitrary keys into a file on disk.
_TRACK_FIELDS = (
    "title", "description", "lyrics", "tags",
    "tempo", "key", "swing", "meter",
)

_lock = threading.Lock()


def _cache_root() -> Path:
    env = os.environ.get("MTAPI_AIRAPPER_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    return Path.home() / ".cache" / "mtapi"


def airapper_dir() -> Path:
    return _cache_root() / "airapper"


def index_path() -> Path:
    return airapper_dir() / "tracks.json"


def track_path(track_id: str) -> Path:
    return airapper_dir() / f"{_safe_id(track_id)}.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# ── index ────────────────────────────────────────────────────────────────────

def _blank_index() -> dict:
    return {"version": INDEX_VERSION, "tracks": []}


def load_index() -> dict:
    """Tolerant read: corrupt or missing index → blank (never raise, never wipe)."""
    try:
        raw = index_path().read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, dict) and isinstance(data.get("tracks"), list):
            return data
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return _blank_index()


def _write_index(data: dict) -> None:
    root = airapper_dir()
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / "tracks.json.tmp"
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, index_path())


# ── validation ───────────────────────────────────────────────────────────────

def _safe_id(track_id: str) -> str:
    """Ids are hex uuids from this store. Anything else collapses to a digest-safe
    slug so a crafted path can never escape the library directory."""
    raw = str(track_id or "").strip()
    if raw and all(c in "0123456789abcdef" for c in raw.lower()) and len(raw) <= 64:
        return raw.lower()
    import hashlib
    return "x" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _clean_text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _clean_tags(value) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in value:
        tag = _clean_text(raw, MAX_TAG_CHARS)
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
        if len(out) >= MAX_TAGS:
            break
    return out


def _clean_tempo(value) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 95.0
    if v != v or v in (float("inf"), float("-inf")):  # NaN / inf
        return 95.0
    return round(min(200.0, max(40.0, v)), 2)


def _clean_swing(value) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    if v != v or v in (float("inf"), float("-inf")):
        return 0.0
    return round(min(100.0, max(0.0, v)), 2)


def _clean_key(value) -> str:
    return _clean_text(value, 8)


def _clean_meter(value) -> str:
    meter = _clean_text(value, 8)
    return meter if meter in ("4/4", "3/4", "6/8") else "4/4"


def normalize_track(payload: dict) -> dict:
    """Whitelist + clamp a posted payload into a storable track body."""
    src = payload if isinstance(payload, dict) else {}
    lyrics = str(src.get("lyrics") or "")
    if len(lyrics.encode("utf-8", errors="replace")) > MAX_LYRICS_BYTES:
        raise ValueError(
            f"Lyrics too large (> {MAX_LYRICS_BYTES // 1024} KB) — trim before saving"
        )
    return {
        "title": _clean_text(src.get("title"), MAX_TITLE_CHARS),
        "description": _clean_text(src.get("description"), MAX_DESCRIPTION_CHARS),
        "lyrics": lyrics,
        "tags": _clean_tags(src.get("tags")),
        "tempo": _clean_tempo(src.get("tempo")),
        "key": _clean_key(src.get("key")),
        "swing": _clean_swing(src.get("swing")),
        "meter": _clean_meter(src.get("meter")),
    }


# ── read ─────────────────────────────────────────────────────────────────────

def _read_track_file(track_id: str) -> dict | None:
    try:
        data = json.loads(track_path(track_id).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _summary(entry: dict) -> dict:
    """List rows carry the card fields only — never the whole lyrics body."""
    return {
        "id": str(entry.get("id") or ""),
        "title": str(entry.get("title") or ""),
        "description": str(entry.get("description") or ""),
        "tags": list(entry.get("tags") or []),
        "tempo": entry.get("tempo"),
        "key": str(entry.get("key") or ""),
        "swing": entry.get("swing"),
        "meter": str(entry.get("meter") or ""),
        "created_at": str(entry.get("created_at") or ""),
        "updated_at": str(entry.get("updated_at") or ""),
        "lyrics_bytes": len(str(entry.get("lyrics") or "").encode("utf-8", errors="replace")),
    }


def list_tracks() -> list[dict]:
    """Newest first. `created_at` descending — never title.length (spec §8)."""
    with _lock:
        entries = [dict(e) for e in (load_index().get("tracks") or [])]
    entries.sort(key=lambda e: str(e.get("created_at") or ""), reverse=True)
    return [_summary(e) for e in entries]


def find_by_id(track_id: str) -> dict | None:
    """Full track body from its own file; falls back to the index entry so a
    summary row still resolves if the file is missing."""
    wanted = str(track_id or "").strip()
    if not wanted:
        return None
    with _lock:
        for e in load_index().get("tracks") or []:
            if str(e.get("id")) == wanted:
                entry = dict(e)
                break
        else:
            return None
    body = _read_track_file(wanted)
    if body:
        merged = dict(entry)
        merged.update({k: body.get(k, merged.get(k)) for k in _TRACK_FIELDS})
        return merged
    return entry


def find_by_title(title: str) -> dict | None:
    want = _clean_text(title, MAX_TITLE_CHARS).lower()
    if not want:
        return None
    for e in load_index().get("tracks") or []:
        if str(e.get("title") or "").strip().lower() == want:
            return dict(e)
    return None


# ── write ────────────────────────────────────────────────────────────────────

def _write_track_file(track_id: str, body: dict) -> None:
    root = airapper_dir()
    root.mkdir(parents=True, exist_ok=True)
    dest = track_path(track_id)
    tmp = root / f"{dest.name}.tmp"
    tmp.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, dest)


def save_track(payload: dict, track_id: str | None = None) -> dict:
    """Create (no id) or update (with id). Enforces MAX_TRACKS on new tracks."""
    body = normalize_track(payload)
    with _lock:
        data = load_index()
        tracks = [dict(e) for e in (data.get("tracks") or [])]

        existing_idx = None
        if track_id:
            for i, e in enumerate(tracks):
                if str(e.get("id")) == str(track_id):
                    existing_idx = i
                    break

        if existing_idx is None:
            if len(tracks) >= MAX_TRACKS:
                raise ValueError(
                    f"Saved-song library is full ({MAX_TRACKS} tracks) — delete one first"
                )
            now = _now_iso()
            entry = dict(body)
            entry["id"] = uuid.uuid4().hex
            entry["created_at"] = now
            entry["updated_at"] = now
            tracks.append(entry)
        else:
            prior = tracks[existing_idx]
            entry = dict(body)
            entry["id"] = prior.get("id") or uuid.uuid4().hex
            entry["created_at"] = prior.get("created_at") or _now_iso()
            entry["updated_at"] = _now_iso()
            tracks[existing_idx] = entry

        _write_track_file(entry["id"], dict(body))
        data["version"] = INDEX_VERSION
        data["tracks"] = tracks
        _write_index(data)
    return _summary(entry)


def delete_track(track_id: str) -> bool:
    wanted = str(track_id or "").strip()
    if not wanted:
        return False
    with _lock:
        data = load_index()
        tracks = list(data.get("tracks") or [])
        kept = [e for e in tracks if str(e.get("id")) != wanted]
        if len(kept) == len(tracks):
            return False
        data["tracks"] = kept
        _write_index(data)
        # Index is the truth; a stray file must not fail the delete.
        try:
            track_path(wanted).unlink()
        except FileNotFoundError:
            pass
        except Exception:
            pass
    return True


def read_track_detail(track_id: str) -> dict:
    """Full body for the detail route, with a size guard like the skills store."""
    entry = find_by_id(track_id)
    if not entry:
        raise KeyError(track_id)
    total = len(str(entry.get("lyrics") or "").encode("utf-8", errors="replace"))
    total += len(str(entry.get("description") or "").encode("utf-8", errors="replace"))
    if total > MAX_DETAIL_BYTES:
        raise ValueError("Track too large to display (>1 MB)")
    return entry