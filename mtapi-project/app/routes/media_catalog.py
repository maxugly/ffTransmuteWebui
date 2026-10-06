"""Unified Media Catalog HTTP surface (spec: docs/media-catalog-spec.md §9).

Five endpoints under /api/media-catalog:

- ``POST /ingest``  — lightweight upsert for the pool import hook (§5 path 4)
- ``POST /mark``    — manual provenance write (§6.2)
- ``POST /undo``    — batch provenance rollback (§6.6)
- ``GET  /query``   — faceted read for the Media Catalog tab (§10)
- ``GET  /status``  — counts + engine presence for the tab's Setup row

Invariant 10: every failure is HTTP 200 with ``{"ok": false, "error": ...}``.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

from ..database import audio_db
from ..media import performance as media_perf
from .pool import IMAGE_EXTENSIONS

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/media-catalog", tags=["media-catalog"])

_TONICS = ("C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb",
           "G", "G#", "Ab", "A", "A#", "Bb", "B")
_MAJOR_ALIASES = ("", "maj", "major")
_MINOR_ALIASES = ("m", "min", "minor")


def _build_canonical_keys() -> dict[str, str]:
    table: dict[str, str] = {}
    for tonic in _TONICS:
        low = tonic.lower()
        for alias in _MAJOR_ALIASES:
            for joiner in ("", " "):
                table[f"{low}{joiner}{alias}"] = f"{tonic} major"
        for alias in _MINOR_ALIASES:
            for joiner in ("", " "):
                table[f"{low}{joiner}{alias}"] = f"{tonic} minor"
    return table


_CANONICAL_KEYS: dict[str, str] = _build_canonical_keys()


def _is_video_file(path: Path) -> bool:
    # Deferred: main.py owns the canonical video list and imports this package.
    from ..main import VIDEO_EXTENSIONS
    return path.suffix.lower() in VIDEO_EXTENSIONS


def _is_image_file(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTENSIONS


def _owned_dirs() -> list[str]:
    try:
        settings = media_perf.load_settings()
    except Exception:  # settings unreadable — rules simply do not apply
        return []
    dirs = settings.get("owned_dirs")
    return list(dirs) if isinstance(dirs, list) else []


def _fail(error: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"ok": False, "error": str(error), **extra})


def _row_payload(row: dict[str, Any]) -> dict[str, Any]:
    # Analysis opinions live in raw_metadata; surface the headline disagreement
    # so the UI can flag a file the engines didn't agree on.
    raw = row.get("raw_metadata")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = None
    if not isinstance(raw, dict):
        raw = {}
    return {
        "path": row.get("path"),
        "name": Path(row["path"]).name if row.get("path") else "",
        "type": row.get("type"),
        "status": row.get("status"),
        "is_mine": bool(row.get("is_mine")),
        "made_by_me": bool(row.get("made_by_me")),
        "ai_involved": bool(row.get("ai_involved")),
        "mine_source": row.get("mine_source"),
        "origin": row.get("origin"),
        "site": row.get("site"),
        "is_youtube": bool(row.get("is_youtube")) if row.get("is_youtube") is not None else None,
        "author": row.get("author"),
        "source_url": row.get("source_url"),
        "publish_date": row.get("publish_date"),
        "tempo": row.get("tempo"),
        "tempo_conf": row.get("tempo_conf"),
        "key_name": row.get("key_name"),
        "key_strength": row.get("key_strength"),
        "duration": row.get("duration"),
        "midi_path": row.get("midi_path"),
        "sidecar_json_path": row.get("sidecar_json_path"),
        "tempo_spread_bpm": raw.get("tempo_spread_bpm"),
        "tempo_octave_split": raw.get("tempo_octave_split"),
        "tempo_votes": raw.get("tempo_votes"),
        "tempo_octave_minorities": raw.get("tempo_octave_minorities"),
        "tempo_source": row.get("tempo_source"),
        "tempo_source_manual": bool(row.get("tempo_source_manual")) if row.get("tempo_source_manual") is not None else None,
        "tempo_detected": row.get("tempo_detected"),
        "key_source": row.get("key_source"),
        "key_source_manual": bool(row.get("key_source_manual")) if row.get("key_source_manual") is not None else None,
        "key_detected": row.get("key_detected"),
        "tempo_vs_tag_bpm": raw.get("tempo_vs_tag_bpm"),
        "tempo_agrees_with_tag": raw.get("tempo_agrees_with_tag"),
        "tempo_octave_equivalent": raw.get("tempo_octave_equivalent"),
        "key_matches_tag": raw.get("key_matches_tag"),
        "key_pitch_class_delta": raw.get("key_pitch_class_delta"),
        "title": row.get("title"),
        "artist": row.get("artist"),
        "album": row.get("album"),
        "tag_bpm": row.get("tag_bpm"),
        "tag_key": row.get("tag_initial_key") or row.get("tag_key"),
        "tag_camelot": row.get("tag_camelot"),
        "tag_acidized": bool(row.get("tag_acidized")) if row.get("tag_acidized") is not None else None,
        "tempo_agreeing_engines": raw.get("tempo_agreeing_engines"),
        "tempo_engine": raw.get("tempo_engine"),
        "key_engine": raw.get("key_engine"),
        "beat_counts_by_engine": raw.get("beat_counts_by_engine"),
        "onset_counts_by_engine": raw.get("onset_counts_by_engine"),
        "notes_midi_path": raw.get("notes_midi_path"),
        "notes_midi_count": raw.get("notes_midi_count"),
        "midi_kind": raw.get("midi_kind"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def normalize_key(value: str | None) -> str | None:
    """'Cmaj' / 'c major' / 'C' → canonical 'C major' (None when unknown)."""
    if not value or not isinstance(value, str):
        return None
    return _CANONICAL_KEYS.get(value.strip().lower())


@router.get("/status")
async def catalog_status() -> JSONResponse:
    try:
        audio_db.init_db()
        with audio_db.get_db() as db:
            by_type = {
                r["type"]: r["n"]
                for r in db.execute("SELECT type, COUNT(*) AS n FROM media GROUP BY type")
            }
            by_status = {
                r["status"]: r["n"]
                for r in db.execute("SELECT status, COUNT(*) AS n FROM media GROUP BY status")
            }
            total = db.execute("SELECT COUNT(*) FROM media").fetchone()[0]
    except Exception as exc:
        return _fail(f"catalog status failed: {exc}")

    # One source of truth for engine availability (scanner knows the real roles:
    # Essentia covers key/tempo/beats/onsets, mido the tempo-map MIDI).
    from ..audio_pipeline.scanner import engine_status
    engines = engine_status()

    return JSONResponse({
        "ok": True,
        "db_path": audio_db._current_db_path(),
        "total": total,
        "by_type": by_type,
        "by_status": by_status,
        "owned_dirs": _owned_dirs(),
        "engines_present": engines,
    })


@router.get("/query")
async def catalog_query(request: Request) -> JSONResponse:
    params = request.query_params

    where: list[str] = []
    args: list[Any] = []

    if params.get("type") in ("audio", "video", "image"):
        where.append("type = ?")
        args.append(params["type"])
    for flag, column in (("mine", "is_mine"), ("hand", "made_by_me"), ("ai", "ai_involved")):
        raw = params.get(flag)
        if raw in ("1", "true", "yes"):
            where.append(f"{column} = 1")
        elif raw in ("0", "false", "no"):
            where.append(f"{column} = 0")
    if params.get("origin") in ("generated", "web", "import"):
        where.append("origin = ?")
        args.append(params["origin"])
    if params.get("site"):
        where.append("site = ?")
        args.append(params["site"].strip().lower())
    key = normalize_key(params.get("key"))
    if key:
        where.append("key_name = ?")
        args.append(key)
    try:
        tempo_min = float(params["tempo_min"]) if params.get("tempo_min") else None
        tempo_max = float(params["tempo_max"]) if params.get("tempo_max") else None
    except (TypeError, ValueError):
        tempo_min = tempo_max = None
    if tempo_min is not None:
        where.append("tempo >= ?")
        args.append(tempo_min)
    if tempo_max is not None:
        where.append("tempo <= ?")
        args.append(tempo_max)
    if params.get("status"):
        where.append("status = ?")
        args.append(params["status"].strip())
    if params.get("after"):
        where.append("IFNULL(publish_date,'') >= ?")
        args.append(params["after"].strip())
    if params.get("before"):
        where.append("IFNULL(publish_date,'') <= ?")
        args.append(params["before"].strip())
    if params.get("tag_key"):
        tk = normalize_key(params["tag_key"])
        if tk:
            where.append("(tag_initial_key = ? OR tag_key = ?)")
            args.extend([tk, tk])
    if params.get("tagged") == "1":
        where.append("(title IS NOT NULL OR artist IS NOT NULL OR tag_bpm IS NOT NULL "
                     "OR tag_key IS NOT NULL)")
    if params.get("acidized") == "1":
        where.append("tag_acidized = 1")
    if params.get("source") in ("tagged", "detected"):
        where.append("(tempo_source = ? OR key_source = ?)")
        args.extend([params["source"], params["source"]])
    if params.get("disagree") == "1":
        where.append("(tag_bpm IS NOT NULL AND tempo_detected IS NOT NULL "
                     "AND ABS(COALESCE(tempo_detected,0) - COALESCE(tag_bpm,0)) > 1.5)")
    if params.get("q"):
        where.append("(path LIKE ? OR IFNULL(author,'') LIKE ? "
                     "OR IFNULL(title,'') LIKE ? OR IFNULL(artist,'') LIKE ?)")
        needle = f"%{params['q'].strip()}%"
        args.extend([needle, needle, needle, needle])

    clause = f" WHERE {' AND '.join(where)}" if where else ""
    try:
        limit = max(1, min(1000, int(params.get("limit") or 200)))
        offset = max(0, int(params.get("offset") or 0))
    except (TypeError, ValueError):
        limit, offset = 200, 0

    order = params.get("order") or "recent"
    order_sql = {
        "recent": "is_mine DESC, IFNULL(updated_at,'') DESC",
        "path": "path COLLATE NOCASE ASC",
        "tempo": "IFNULL(tempo, 999999) ASC",
        "key": "IFNULL(key_name, '~') ASC, IFNULL(tempo, 999999) ASC",
        "duration": "IFNULL(duration, 0) DESC",
    }.get(order, "is_mine DESC, IFNULL(updated_at,'') DESC")

    try:
        audio_db.init_db()
        with audio_db.get_db() as db:
            total = db.execute(f"SELECT COUNT(*) FROM media{clause}", args).fetchone()[0]
            rows = db.execute(
                f"SELECT * FROM media{clause} ORDER BY {order_sql} LIMIT ? OFFSET ?",
                [*args, limit, offset],
            ).fetchall()
    except sqlite3.Error as exc:
        return _fail(f"catalog query failed: {exc}")

    return JSONResponse({
        "ok": True,
        "total": total,
        "limit": limit,
        "offset": offset,
        "rows": [_row_payload(dict(r)) for r in rows],
    })


@router.get("/history")
async def catalog_history(request: Request) -> JSONResponse:
    path = request.query_params.get("path")
    if not path:
        return _fail("path is required")
    try:
        entries = audio_db.provenance_history(path, limit=50)
    except sqlite3.Error as exc:
        return _fail(f"history failed: {exc}")
    return JSONResponse({"ok": True, "rows": entries})


@router.post("/ingest")
async def catalog_ingest(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return _fail("invalid JSON body")
    paths = body.get("paths")
    if not isinstance(paths, list) or not paths:
        return _fail("paths must be a non-empty list")
    paths = [p for p in paths if isinstance(p, str) and p.strip()][:500]
    if not paths:
        return _fail("paths must be a non-empty list")

    owned = _owned_dirs()
    upserted = 0
    skipped = 0
    rows: list[dict[str, Any]] = []
    for raw in paths:
        p = Path(raw.strip()).expanduser()
        try:
            if not p.is_file():
                skipped += 1
                continue
            audio_db.catalog_upsert(
                str(p),
                origin="import",
                owned_dirs=owned,
                status="pending",
                is_video_fn=_is_video_file,
                is_image_fn=_is_image_file,
            )
            upserted += 1
            stored = audio_db.get_row(str(p))
            if stored is not None:
                rows.append(_row_payload(stored))
        except sqlite3.Error as exc:
            log.warning("[media-catalog] ingest failed for %s: %s", p, exc)
            skipped += 1
    # `rows` lets the caller mirror provenance onto its own items so badges
    # appear for freshly imported files without a second round-trip.
    return JSONResponse({"ok": True, "upserted": upserted, "skipped": skipped, "rows": rows})


@router.post("/mark")
async def catalog_mark(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return _fail("invalid JSON body")
    path = body.get("path")
    if not isinstance(path, str) or not path.strip():
        return _fail("path is required")

    batch_id = body.get("batch_id") if isinstance(body.get("batch_id"), str) else None
    try:
        res = audio_db.mark(
            path,
            bool(body.get("is_mine")),
            bool(body.get("made_by_me")),
            bool(body.get("ai_involved")),
            batch_id=batch_id,
            is_video_fn=_is_video_file,
            is_image_fn=_is_image_file,
        )
    except sqlite3.Error as exc:
        return _fail(f"mark failed: {exc}")

    row = audio_db.get_row(path)
    return JSONResponse({
        "ok": True,
        "row_id": res["row_id"],
        "batch_id": res["batch_id"],
        "changed": res["changed"],
        "row": _row_payload(row) if row else None,
    })


@router.post("/generated")
async def catalog_generated(request: Request) -> JSONResponse:
    """Record an op-generated output: mine + AI-involved (spec §6.3)."""
    try:
        body = await request.json()
    except Exception:
        return _fail("invalid JSON body")
    path = body.get("path")
    if not isinstance(path, str) or not path.strip():
        return _fail("path is required")

    generated_by = body.get("generated_by")
    generated_by = generated_by if isinstance(generated_by, str) and generated_by.strip() else None

    try:
        res = audio_db.catalog_upsert(
            path,
            origin="generated",
            owned_dirs=_owned_dirs(),
            generated_flag=True,
            status="pending",
            is_video_fn=_is_video_file,
            is_image_fn=_is_image_file,
        )
    except sqlite3.Error as exc:
        return _fail(f"generated stamp failed: {exc}")

    row = audio_db.get_row(path)
    return JSONResponse({
        "ok": True,
        "row_id": res["row_id"],
        "changed": res["changed"],
        "batch_id": res["batch_id"],
        "generated_by": generated_by,
        "row": _row_payload(row) if row else None,
    })


@router.post("/source")
async def catalog_source(request: Request) -> JSONResponse:
    """Choose which stored reading is authoritative for tempo or key (spec §19).

    Non-destructive: this only picks which of the two stored numbers wins. Both
    remain on the row, and the choice is marked manual so later scans keep it.
    """
    try:
        body = await request.json()
    except Exception:
        return _fail("invalid JSON body")
    path = body.get("path")
    field = body.get("field")
    choice = body.get("source")
    if not isinstance(path, str) or not path.strip():
        return _fail("path is required")
    try:
        result = audio_db.set_source_of_truth(path, str(field), str(choice))
    except KeyError:
        return _fail(f"no catalog row for {path}")
    except ValueError as exc:
        return _fail(str(exc))
    row = audio_db.get_row(path)
    return JSONResponse({"ok": True, **result,
                         "row": _row_payload(row) if row else None})


@router.post("/undo")
async def catalog_undo(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return _fail("invalid JSON body")
    batch_id = body.get("batch_id")
    if not isinstance(batch_id, str) or not batch_id.strip():
        return _fail("batch_id is required")
    try:
        res = audio_db.undo_batch(batch_id.strip())
    except sqlite3.Error as exc:
        return _fail(f"undo failed: {exc}")
    return JSONResponse({"ok": True, **res})


def register(app: Any) -> None:
    app.include_router(router)