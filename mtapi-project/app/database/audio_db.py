"""Unified media catalog database (spec: docs/media-catalog-spec.md).

One SQLite index over the user's audio, video and image library. Provenance is
three bits -- ``is_mine`` (master filter flag) plus the two orthogonal craft
facts ``made_by_me`` (human authorship) and ``ai_involved`` (AI the user ran
touched any part) -- all assignable by owned-directory rules, generator
auto-derive, or the manual provenance editor.

Write-time invariant (spec §6.4, locked): after any write,
``is_mine = is_mine OR made_by_me OR ai_involved``. A row whose
``mine_source`` is ``'manual'`` is never touched by heuristics.

Safeguard (spec §6.6): every provenance-triple change appends one
``provenance_log`` row (old triple → new triple, mechanism, batch_id). The log
is append-only in normal operation; retention is keep-all, with pruning of
entries older than 12 months reserved for an explicit future user action (no
pruning code exists today).

Stdlib only: this module imports nothing from the app so it can be exercised
directly by tests with a temporary database path.
"""

import hashlib
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

DB_PATH = os.path.join(os.path.expanduser("~"), ".ffTransmute", "media_catalog.db")

WEB_STRING_FIELDS = ("site", "author", "source_url", "video_id", "publish_date")

AUDIO_EXTENSIONS = {
    ".wav", ".mp3", ".aif", ".aiff", ".flac", ".m4a", ".ogg", ".opus",
}


def _get_env_db_path() -> str | None:
    env = os.environ.get("MTAPI_MEDIA_CATALOG_DB")
    if env:
        return os.path.expanduser(env)
    return None


def set_db_path(path: str) -> None:
    """Rebind the database path (tests point this at a temp file)."""
    global DB_PATH
    DB_PATH = os.path.abspath(os.path.expanduser(path))


def _current_db_path() -> str:
    return _get_env_db_path() or DB_PATH


def _now() -> str:
    return datetime.now().isoformat()


SCHEMA = """
-- Core media table (unified audio, video, image catalog)
CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    file_hash TEXT,
    type TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    is_mine INTEGER DEFAULT 0,
    made_by_me INTEGER DEFAULT 0,
    ai_involved INTEGER DEFAULT 0,
    mine_source TEXT,
    origin TEXT,
    site TEXT,
    is_youtube INTEGER,
    author TEXT,
    source_url TEXT,
    video_id TEXT,
    publish_date TEXT,
    tempo REAL,
    tempo_conf REAL,
    key_name TEXT,
    key_strength REAL,
    duration REAL,
    midi_path TEXT,
    sidecar_json_path TEXT,
    raw_metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);
CREATE INDEX IF NOT EXISTS idx_media_mine ON media(is_mine);
CREATE INDEX IF NOT EXISTS idx_media_hand ON media(made_by_me);
CREATE INDEX IF NOT EXISTS idx_media_ai ON media(ai_involved);
CREATE INDEX IF NOT EXISTS idx_media_origin ON media(origin);
CREATE INDEX IF NOT EXISTS idx_media_site ON media(site);
CREATE INDEX IF NOT EXISTS idx_media_tempo ON media(tempo);
CREATE INDEX IF NOT EXISTS idx_media_key ON media(key_name);
CREATE INDEX IF NOT EXISTS idx_media_hash ON media(file_hash);

-- Append-only provenance audit log (spec §6.6 safeguard)
CREATE TABLE IF NOT EXISTS provenance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,
    path TEXT NOT NULL,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    mechanism TEXT,
    old_is_mine INTEGER,
    old_made_by_me INTEGER,
    old_ai_involved INTEGER,
    old_mine_source TEXT,
    new_is_mine INTEGER,
    new_made_by_me INTEGER,
    new_ai_involved INTEGER,
    new_mine_source TEXT
);

CREATE INDEX IF NOT EXISTS idx_provlog_path ON provenance_log(path);
CREATE INDEX IF NOT EXISTS idx_provlog_batch ON provenance_log(batch_id);

-- Parked tables (carried from the audio-quarry scaffold) — DDL kept, unused
CREATE TABLE IF NOT EXISTS stems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
    stem_type TEXT NOT NULL,
    path TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS slices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
    stem_id INTEGER REFERENCES stems(id) ON DELETE CASCADE,
    slice_type TEXT NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL,
    path TEXT UNIQUE NOT NULL,
    metadata JSON
);

CREATE INDEX IF NOT EXISTS idx_slices_type ON slices(slice_type);
"""


@contextmanager
def get_db():
    db_path = _current_db_path()
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.commit()
        conn.close()


def init_db() -> None:
    with get_db() as db:
        db.executescript(SCHEMA)
        _migrate(db)


# Slice 8: tag/header columns. CREATE TABLE IF NOT EXISTS will not add columns to
# an existing database, and the catalog already holds real scanned rows — so the
# schema evolves by explicit ALTER TABLE rather than by asking the user to
# delete their data.
TAG_COLUMNS: dict[str, str] = {
    "title": "TEXT",
    "artist": "TEXT",
    "album": "TEXT",
    "tag_bpm": "REAL",
    "tag_key": "TEXT",
    "tag_initial_key": "TEXT",
    "tag_camelot": "TEXT",
    "tag_playlist_key": "TEXT",
    "tag_mood": "TEXT",
    "tag_genre": "TEXT",
    "tag_comment": "TEXT",
    "tag_encoder": "TEXT",
    "tag_acidized": "INTEGER",
    "tags_json": "JSON",
    # Source of truth per analysed field (Slice 9). The *effective* value lives in
    # tempo / key_name; the other reading is always kept alongside it, so choosing
    # a source is never destructive.
    "tempo_source": "TEXT",          # 'tagged' | 'detected'
    "tempo_source_manual": "INTEGER",  # 1 = the user picked it; 0 = default policy
    "tempo_detected": "REAL",         # the detector consensus, always kept
    "key_source": "TEXT",            # 'tagged' | 'detected'
    "key_source_manual": "INTEGER",
    "key_detected": "TEXT",          # the detector's key, always kept
    # Content classification (8.133): what the file is NOT — silence, broadband
    # noise, DC — computed numpy-side on every analysis pass. tempo_implausible
    # marks rows whose only tempo readings sat outside the [30, 300] band: the
    # effective value is NULL, the raw readings stay in the sidecar.
    "tempo_implausible": "INTEGER",
    "level_db": "REAL",
    "peak_db": "REAL",
    "flatness": "REAL",
    "content_class": "TEXT",         # 'ok' | 'silent' | 'noise-like' | 'dc-offset'
    # 8.135: derived artifacts (stems, MIDI) point at the track they came from;
    # the main catalog list hides them, the dive panel shows them.
    "derived_from": "TEXT",
}


def _migrate(db: sqlite3.Connection) -> None:
    existing = {row["name"] for row in db.execute("PRAGMA table_info(media)")}
    if not existing:
        return
    for column, decl in TAG_COLUMNS.items():
        if column not in existing:
            db.execute(f"ALTER TABLE media ADD COLUMN {column} {decl}")


def tag_indexes(db: sqlite3.Connection) -> None:
    """Index the promoted tag columns once they exist (idempotent)."""
    existing = {row["name"] for row in db.execute("PRAGMA table_info(media)")}
    for column in ("tag_bpm", "tag_key", "title", "artist", "content_class",
                   "derived_from"):
        if column in existing:
            name = f"idx_media_{column}"
            db.execute(f"CREATE INDEX IF NOT EXISTS {name} ON media({column})")


def apply_source_defaults(path: str) -> dict[str, Any]:
    """Apply the default policy to a row: when the owner tagged a value, the tag
    is the source of truth; otherwise the detection is.

    Only touches rows whose choice is not manual, so an explicit user selection
    survives every later scan. Nothing is overwritten: both numbers are stored.
    """
    abs_path = os.path.abspath(os.path.expanduser(path))
    with get_db() as db:
        row = db.execute("SELECT * FROM media WHERE path = ?", (abs_path,)).fetchone()
        if row is None:
            return {}
        updates: dict[str, Any] = {}

        if not row["tempo_source_manual"] and not row["tempo_source"]:
            if row["tag_bpm"] is not None:
                updates["tempo_source"] = "tagged"
            elif row["tempo"] is not None:
                updates["tempo_source"] = "detected"
        if not row["key_source_manual"] and not row["key_source"]:
            if row["tag_initial_key"] or row["tag_key"]:
                updates["key_source"] = "tagged"
            elif row["key_name"] is not None:
                updates["key_source"] = "detected"

        # Recompute the effective values from the stored candidates.
        tempo = row["tempo"]
        if updates.get("tempo_source") == "tagged" or row["tempo_source"] == "tagged":
            tempo = row["tag_bpm"] if row["tag_bpm"] is not None else row["tempo"]
        elif row["tempo_source"] == "detected" or updates.get("tempo_source") == "detected":
            tempo = row["tempo_detected"] if row["tempo_detected"] is not None else row["tempo"]
        if tempo != row["tempo"]:
            updates["tempo"] = tempo

        key = row["key_name"]
        if updates.get("key_source") == "tagged" or row["key_source"] == "tagged":
            key = row["tag_initial_key"] or row["tag_key"] or row["key_name"]
        elif row["key_source"] == "detected" or updates.get("key_source") == "detected":
            key = row["key_detected"] if row["key_detected"] is not None else row["key_name"]
        if key != row["key_name"]:
            updates["key_name"] = key

        if updates:
            updates["updated_at"] = datetime.now().isoformat()
            assignments = ", ".join(f"{k} = ?" for k in updates)
            db.execute(f"UPDATE media SET {assignments} WHERE path = ?",
                       [*updates.values(), abs_path])
        return updates


def set_source_of_truth(path: str, field: str, choice: str) -> dict[str, Any]:
    """User-facing switch: which reading wins for `tempo` or `key`.

    `choice` is 'tagged' or 'detected'. This only chooses which stored number is
    authoritative — both remain in the row, and the choice is marked manual so a
    rescan will not undo it.
    """
    if field not in ("tempo", "key"):
        raise ValueError(f"unknown field {field!r} (expected 'tempo' or 'key')")
    if choice not in ("tagged", "detected"):
        raise ValueError(f"unknown choice {choice!r} (expected 'tagged' or 'detected')")
    abs_path = os.path.abspath(os.path.expanduser(path))
    with get_db() as db:
        row = db.execute("SELECT * FROM media WHERE path = ?", (abs_path,)).fetchone()
        if row is None:
            raise KeyError(abs_path)
        if field == "tempo":
            if choice == "tagged" and row["tag_bpm"] is None:
                raise ValueError("this file has no tagged tempo to prefer")
            effective = row["tag_bpm"] if choice == "tagged" else (
                row["tempo_detected"] if row["tempo_detected"] is not None else row["tempo"])
            if effective is None:
                raise ValueError("no detected tempo stored")
            db.execute(
                "UPDATE media SET tempo = ?, tempo_source = ?, tempo_source_manual = 1, "
                "updated_at = ? WHERE path = ?",
                (effective, choice, datetime.now().isoformat(), abs_path),
            )
            return {"field": field, "source": choice, "value": effective}
        key = row["tag_initial_key"] or row["tag_key"] if choice == "tagged" else (
            row["key_detected"] if row["key_detected"] is not None else row["key_name"])
        if key is None:
            raise ValueError("no detected key stored")
        db.execute(
            "UPDATE media SET key_name = ?, key_source = ?, key_source_manual = 1, "
            "updated_at = ? WHERE path = ?",
            (key, choice, datetime.now().isoformat(), abs_path),
        )
        return {"field": field, "source": choice, "value": key}


def backfill_detected_from_sidecars(limit: int = 5000) -> int:
    """Recover the detection for rows analysed BEFORE the detected/source split
    existed.

    Those rows had their detection in `tempo` / `key_name`; once a tag became
    authoritative those columns were reused for the effective value, so the
    detection survives only in the sibling `.json` sidecar. This reads it back.
    Nothing is invented: rows with no sidecar keep NULL.
    """
    import json as _json

    with get_db() as db:
        _migrate(db)
        tag_indexes(db)
        rows = db.execute(
            "SELECT path, sidecar_json_path FROM media "
            "WHERE (tempo_detected IS NULL OR key_detected IS NULL) "
            "AND sidecar_json_path IS NOT NULL LIMIT ?", (limit,)).fetchall()
    recovered = 0
    for row in rows:
        sidecar = Path(row["sidecar_json_path"])
        if not sidecar.is_file():
            continue
        try:
            payload = _json.loads(sidecar.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        with get_db() as db:
            cur = db.execute(
                "UPDATE media SET "
                "  tempo_detected = COALESCE(tempo_detected, ?), "
                "  key_detected = COALESCE(key_detected, ?), "
                "  updated_at = ? WHERE path = ?",
                (payload.get("tempo"), payload.get("key"),
                 datetime.now().isoformat(), row["path"]),
            )
            recovered += cur.rowcount or 0
    return recovered


def backfill_source_of_truth(limit: int = 5000) -> int:
    """Apply the default policy across rows scanned before this feature existed."""
    with get_db() as db:
        _migrate(db)
        tag_indexes(db)
        paths = [r["path"] for r in db.execute(
            "SELECT path FROM media WHERE tempo_source IS NULL OR key_source IS NULL "
            "LIMIT ?", (limit,))]
    applied = 0
    for path in paths:
        if apply_source_defaults(path):
            applied += 1
    # Detection first, so a default choice has both candidates to choose from.
    backfill_detected_from_sidecars()
    return applied


def save_tags(path: str, tags: dict[str, Any]) -> None:
    """Persist extracted tags onto the catalog row (idempotent)."""
    abs_path = os.path.abspath(os.path.expanduser(path))
    payload = {
        "title": tags.get("title"),
        "artist": tags.get("artist"),
        "album": tags.get("album"),
        "tag_bpm": tags.get("bpm"),
        "tag_key": tags.get("key_canonical"),
        "tag_initial_key": tags.get("initial_key_canonical"),
        "tag_camelot": tags.get("camelot"),
        "tag_playlist_key": tags.get("playlist_key") or tags.get("playlistkey"),
        "tag_mood": tags.get("mood"),
        "tag_genre": tags.get("genre"),
        "tag_comment": tags.get("comment"),
        "tag_encoder": tags.get("encoder"),
        "tag_acidized": 1 if tags.get("acidized") else (0 if tags.get("acidized") is False else None),
        "tags_json": json.dumps(tags, ensure_ascii=False, default=str),
    }
    assignments = ", ".join(f"{col} = ?" for col in payload)
    with get_db() as db:
        _migrate(db)
        tag_indexes(db)
        db.execute(
            f"UPDATE media SET {assignments}, updated_at = ? WHERE path = ?",
            [*payload.values(), datetime.now().isoformat(), abs_path],
        )
    # A new tag changes which number is authoritative by default — but only if
    # the user has not already chosen a source for this row.
    apply_source_defaults(abs_path)


def classify_type(
    path: str,
    is_video_fn: Callable[[Path], bool] | None = None,
    is_image_fn: Callable[[Path], bool] | None = None,
) -> str:
    """Audio by extension; video/image by the app's own predicates."""
    p = Path(path)
    if p.suffix.lower() in AUDIO_EXTENSIONS:
        return "audio"
    if is_video_fn is not None and is_video_fn(p):
        return "video"
    if is_image_fn is not None and is_image_fn(p):
        return "image"
    return "unknown"


def quick_hash(path: str) -> str | None:
    """Content hash of the first 1MB — fast dedup key for huge libraries."""
    try:
        with open(path, "rb") as f:
            data = f.read(1024 * 1024)
    except OSError:
        return None
    return hashlib.md5(data).hexdigest()


def path_is_owned(path: str, owned_dirs: list[str] | None) -> bool:
    """True when `path` sits inside one of the owned directories.

    Uses real path containment, not string prefix: `/music2` must not match a
    rule for `/music`.
    """
    if not owned_dirs:
        return False
    abs_path = os.path.abspath(path)
    for entry in owned_dirs:
        if not isinstance(entry, str) or not entry.strip():
            continue
        owned = os.path.abspath(os.path.expanduser(entry))
        try:
            if os.path.commonpath([abs_path, owned]) == owned:
                return True
        except ValueError:
            # Different drives / mixed absolute-relative: not a match.
            continue
    return False


def _provenance_strength(source: str | None) -> int:
    if source == "manual":
        return 3
    if source == "generated":
        return 2
    if source == "dir_rule":
        return 1
    return 0


def _log_provenance(
    db: sqlite3.Connection,
    batch_id: str,
    path: str,
    old_triple: tuple[int, int, int, str | None],
    new_triple: tuple[int, int, int, str | None],
    mechanism: str,
) -> bool:
    """Append one audit row when the provenance triple actually changed."""
    if old_triple == new_triple:
        return False
    db.execute(
        """
        INSERT INTO provenance_log (
            batch_id, path, mechanism,
            old_is_mine, old_made_by_me, old_ai_involved, old_mine_source,
            new_is_mine, new_made_by_me, new_ai_involved, new_mine_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            batch_id,
            path,
            mechanism,
            old_triple[0], old_triple[1], old_triple[2], old_triple[3],
            new_triple[0], new_triple[1], new_triple[2], new_triple[3],
        ),
    )
    return True


def _web_values(
    existing: sqlite3.Row | None,
    web_fields: dict[str, Any] | None,
) -> dict[str, Any]:
    """Merge provided web fields over existing values; never wipe."""
    values: dict[str, Any] = {}
    for key in WEB_STRING_FIELDS:
        incoming = web_fields.get(key) if web_fields else None
        if isinstance(incoming, str) and incoming.strip():
            values[key] = incoming.strip()
        elif existing is not None and existing[key]:
            values[key] = existing[key]
        else:
            values[key] = None
    incoming_yt = web_fields.get("is_youtube") if web_fields else None
    if incoming_yt is not None:
        values["is_youtube"] = 1 if incoming_yt else 0
    elif existing is not None and existing["is_youtube"] is not None:
        values["is_youtube"] = 1 if existing["is_youtube"] else 0
    else:
        values["is_youtube"] = None
    return values


def catalog_upsert(
    path: str,
    *,
    origin: str | None = None,
    web_fields: dict[str, Any] | None = None,
    owned_dirs: list[str] | None = None,
    generated_flag: bool = False,
    status: str = "pending",
    batch_id: str | None = None,
    is_video_fn: Callable[[Path], bool] | None = None,
    is_image_fn: Callable[[Path], bool] | None = None,
    derived_from: str | None = None,
) -> dict[str, Any]:
    """Upsert one media file, resolving provenance per spec §6.

    ``derived_from`` marks artifacts a tool produced FROM a track (stems,
    MIDI transcriptions) — they exist in the DB for provenance and queries but
    are excluded from the catalog's main list (see /query include_derived).

    Returns ``{row_id, path, type, changed, batch_id}`` where ``changed`` means
    the provenance triple actually changed (what gets an audit row).
    """
    abs_path = os.path.abspath(os.path.expanduser(path))
    media_type = classify_type(abs_path, is_video_fn, is_image_fn)
    file_hash = quick_hash(abs_path)
    bid = batch_id or str(uuid.uuid4())

    with get_db() as db:
        row = db.execute("SELECT * FROM media WHERE path = ?", (abs_path,)).fetchone()

        if row is None:
            is_mine = 0
            made_by_me = 0
            ai_involved = 0
            mine_source: str | None = None
            final_origin = origin
        else:
            is_mine = 1 if row["is_mine"] else 0
            made_by_me = 1 if row["made_by_me"] else 0
            ai_involved = 1 if row["ai_involved"] else 0
            mine_source = row["mine_source"]
            final_origin = row["origin"] or origin

        # Heuristic claims. A manual row is never re-asserted (§6.2/§6.4).
        applied_mechanism: str | None = None
        if row is None or row["mine_source"] != "manual":
            candidates: list[str] = []
            if path_is_owned(abs_path, owned_dirs):
                candidates.append("dir_rule")
            if generated_flag:
                candidates.append("generated")
            for mechanism in candidates:
                if _provenance_strength(mechanism) > _provenance_strength(mine_source):
                    mine_source = mechanism
                    is_mine = 1
                    if mechanism == "generated":
                        ai_involved = 1
                    applied_mechanism = mechanism
                elif mechanism == "generated" and not ai_involved:
                    # Same strength already held (generated) but the bit was
                    # cleared manually elsewhere — respect the invariant.
                    ai_involved = 1
                    is_mine = 1
                    applied_mechanism = mechanism

        if web_fields:
            final_origin = "web"
        elif generated_flag:
            final_origin = "generated"

        # Write-time invariant (§6.4).
        is_mine = 1 if (is_mine or made_by_me or ai_involved) else 0

        web = _web_values(row, web_fields)
        old_triple = (
            (1 if row["is_mine"] else 0, 1 if row["made_by_me"] else 0,
             1 if row["ai_involved"] else 0, row["mine_source"])
            if row is not None else (0, 0, 0, None)
        )
        new_triple = (is_mine, made_by_me, ai_involved, mine_source)
        now = _now()

        if row is None:
            cur = db.execute(
                """
                INSERT INTO media (
                    path, file_hash, type, status,
                    is_mine, made_by_me, ai_involved, mine_source, origin,
                    site, is_youtube, author, source_url, video_id, publish_date,
                    derived_from, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    abs_path, file_hash, media_type, status,
                    is_mine, made_by_me, ai_involved, mine_source, final_origin,
                    web["site"], web["is_youtube"], web["author"],
                    web["source_url"], web["video_id"], web["publish_date"],
                    derived_from, now, now,
                ),
            )
            row_id = cur.lastrowid
        else:
            db.execute(
                """
                UPDATE media SET
                    file_hash = ?, type = ?, status = ?,
                    is_mine = ?, made_by_me = ?, ai_involved = ?, mine_source = ?,
                    origin = ?, site = ?, is_youtube = ?, author = ?,
                    source_url = ?, video_id = ?, publish_date = ?,
                    derived_from = COALESCE(?, derived_from), updated_at = ?
                WHERE path = ?
                """,
                (
                    file_hash, media_type, status,
                    is_mine, made_by_me, ai_involved, mine_source, final_origin,
                    web["site"], web["is_youtube"], web["author"],
                    web["source_url"], web["video_id"], web["publish_date"],
                    derived_from, now, abs_path,
                ),
            )
            row_id = row["id"]

        logged = _log_provenance(
            db, bid, abs_path, old_triple, new_triple,
            applied_mechanism or "manual",
        )
        return {
            "row_id": row_id,
            "path": abs_path,
            "type": media_type,
            "changed": logged,
            "batch_id": bid,
        }


def mark(
    path: str,
    is_mine: Any,
    made_by_me: Any,
    ai_involved: Any,
    batch_id: str | None = None,
    *,
    is_video_fn: Callable[[Path], bool] | None = None,
    is_image_fn: Callable[[Path], bool] | None = None,
) -> dict[str, Any]:
    """Manual provenance write (§6.2). Creates the row when never ingested.

    ``mine_source`` is always ``'manual'`` — including when all three bits are
    cleared, which is the record of an explicit disclaimer and the only way
    provenance is ever cleared.
    """
    abs_path = os.path.abspath(os.path.expanduser(path))
    new_is_mine = 1 if (is_mine or made_by_me or ai_involved) else 0
    new_hand = 1 if made_by_me else 0
    new_ai = 1 if ai_involved else 0
    new_triple = (new_is_mine, new_hand, new_ai, "manual")
    bid = batch_id or str(uuid.uuid4())

    with get_db() as db:
        row = db.execute("SELECT * FROM media WHERE path = ?", (abs_path,)).fetchone()
        old_triple = (
            (1 if row["is_mine"] else 0, 1 if row["made_by_me"] else 0,
             1 if row["ai_involved"] else 0, row["mine_source"])
            if row is not None else (0, 0, 0, None)
        )
        now = _now()

        if row is None:
            cur = db.execute(
                """
                INSERT INTO media (
                    path, file_hash, type, status,
                    is_mine, made_by_me, ai_involved, mine_source,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    abs_path,
                    quick_hash(abs_path),
                    classify_type(abs_path, is_video_fn, is_image_fn),
                    "pending",
                    new_is_mine, new_hand, new_ai, "manual",
                    now, now,
                ),
            )
            row_id = cur.lastrowid
        else:
            db.execute(
                """
                UPDATE media SET
                    is_mine = ?, made_by_me = ?, ai_involved = ?,
                    mine_source = ?, updated_at = ?
                WHERE path = ?
                """,
                (new_is_mine, new_hand, new_ai, "manual", now, abs_path),
            )
            row_id = row["id"]

        logged = _log_provenance(db, bid, abs_path, old_triple, new_triple, "manual")
        return {"row_id": row_id, "path": abs_path, "changed": logged, "batch_id": bid}


def undo_batch(batch_id: str) -> dict[str, Any]:
    """Restore the pre-batch provenance triple for every path in `batch_id`.

    Takes the FIRST audit entry per path (the true pre-batch state), restores
    only the provenance triple + ``mine_source`` — never analysis columns — and
    logs each restore under a fresh batch id so undo is itself undoable.
    """
    with get_db() as db:
        entries = db.execute(
            "SELECT * FROM provenance_log WHERE batch_id = ? ORDER BY id ASC",
            (batch_id,),
        ).fetchall()
        if not entries:
            return {"restored": 0, "batch_id": None, "paths": []}

        pre_batch: dict[str, sqlite3.Row] = {}
        for entry in entries:
            pre_batch.setdefault(entry["path"], entry)

        new_batch = str(uuid.uuid4())
        restored: list[str] = []

        for path, entry in pre_batch.items():
            row = db.execute("SELECT * FROM media WHERE path = ?", (path,)).fetchone()
            if row is None:
                continue
            current = (
                1 if row["is_mine"] else 0,
                1 if row["made_by_me"] else 0,
                1 if row["ai_involved"] else 0,
                row["mine_source"],
            )
            target = (
                1 if entry["old_is_mine"] else 0,
                1 if entry["old_made_by_me"] else 0,
                1 if entry["old_ai_involved"] else 0,
                entry["old_mine_source"],
            )
            if current == target:
                continue
            db.execute(
                """
                UPDATE media SET
                    is_mine = ?, made_by_me = ?, ai_involved = ?,
                    mine_source = ?, updated_at = ?
                WHERE path = ?
                """,
                (target[0], target[1], target[2], target[3], _now(), path),
            )
            _log_provenance(db, new_batch, path, current, target, "undo")
            restored.append(path)

        return {"restored": len(restored), "batch_id": new_batch, "paths": restored}


def get_row(path: str) -> dict[str, Any] | None:
    """Read one row as a plain dict (used by routes and tests)."""
    abs_path = os.path.abspath(os.path.expanduser(path))
    with get_db() as db:
        row = db.execute("SELECT * FROM media WHERE path = ?", (abs_path,)).fetchone()
        return dict(row) if row is not None else None


def provenance_history(path: str, limit: int = 20) -> list[dict[str, Any]]:
    """Most recent audit entries for one path (newest first)."""
    abs_path = os.path.abspath(os.path.expanduser(path))
    with get_db() as db:
        rows = db.execute(
            """
            SELECT * FROM provenance_log WHERE path = ?
            ORDER BY id DESC LIMIT ?
            """,
            (abs_path, int(limit)),
        ).fetchall()
        return [dict(r) for r in rows]