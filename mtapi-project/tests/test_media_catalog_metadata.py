"""Slice 8: embedded tags + tracker headers + tag-vs-detection comparison.

Tracker fixtures are synthesised byte-exact from the published header layouts,
so the parser is tested against real structures rather than mocked objects.
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.audio_pipeline.metadata import (  # noqa: E402
    build_tags,
    compare_with_tags,
    key_pitch_class,
    normalize_key_tag,
    parse_bpm,
    parse_camelot,
    parse_tracker_header,
)
from app.database import audio_db  # noqa: E402


# ── normalisation ──────────────────────────────────────────────────────────
@pytest.mark.parametrize("raw,expected", [
    ("Abm", "G# minor"),      # flat spelling → sharps, so it compares to detections
    ("A#m", "A# minor"),
    ("Ebm", "D# minor"),
    ("C major", "C major"),
    ("Cmaj", "C major"),
    ("F#min", "F# minor"),
    ("B", "B major"),
    ("", None),
    (None, None),
    ("garbage", None),
])
def test_normalize_key_tag(raw, expected):
    assert normalize_key_tag(raw) == expected


def test_key_pitch_class_is_enharmonic_safe():
    # E-flat minor and D-sharp minor are the same pitch class.
    assert key_pitch_class("D# minor") == key_pitch_class("Eb minor")
    assert key_pitch_class("G# minor") == key_pitch_class("Ab minor")
    # Different keys stay different.
    assert key_pitch_class("G# minor") != key_pitch_class("D# minor")


def test_parse_camelot_variants():
    assert parse_camelot("10a") == "10A"
    assert parse_camelot("1A") == "1A"
    assert parse_camelot(" 12b ") == "12B"
    assert parse_camelot("nope") is None
    assert parse_camelot(None) is None


def test_parse_bpm_bounds():
    assert parse_bpm("147") == 147.0
    assert parse_bpm("  90.5 bpm ") == 90.5
    assert parse_bpm("5") is None          # implausible
    assert parse_bpm("abc") is None
    assert parse_bpm(None) is None


# ── tracker headers ────────────────────────────────────────────────────────
def _write_xm(path: Path, name: str, tracker: str, bpm: int, channels=8):
    data = bytearray(276)
    data[0:17] = b"Extended Module: "
    data[17:37] = name.encode("cp437").ljust(20, b"\x00")[:20]
    data[37:39] = b"\x1a\x1a"
    data[39:59] = tracker.encode("cp437").ljust(20, b"\x00")[:20]
    struct.pack_into("<H", data, 60, 276)
    struct.pack_into("<H", data, 68, channels)
    struct.pack_into("<H", data, 78, bpm)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(data))


def test_xm_header(tmp_path):
    p = tmp_path / "acid.xm"
    _write_xm(p, "acidized beat", "MilkyTracker", 174)
    out = parse_tracker_header(p)
    assert out["header_format"] == "xm"
    assert out["title"] == "acidized beat"
    assert out["tracker"] == "MilkyTracker"
    assert out["bpm"] == 174
    assert out["channels"] == 8
    # The word "acid" in the module name is the acidized marker.
    assert out["acidized"] is True


def test_it_header(tmp_path):
    data = bytearray(192)
    data[0:4] = b"IMPM"
    data[4:30] = b"impulse tune".ljust(26, b"\x00")
    struct.pack_into("<H", data, 0x30, 150)   # initial tempo = BPM
    struct.pack_into("<H", data, 0x32, 6)     # initial speed
    struct.pack_into("<H", data, 0x40, 4)     # patterns
    p = tmp_path / "tune.it"
    p.write_bytes(bytes(data))
    out = parse_tracker_header(p)
    assert out["header_format"] == "it"
    assert out["title"] == "impulse tune"
    assert out["bpm"] == 150
    assert out["speed"] == 6


def test_s3m_header(tmp_path):
    data = bytearray(96)
    data[0:28] = b"scream tracker tune".ljust(28, b"\x00")
    data[28:30] = b"\x1a\x1a"
    struct.pack_into("<H", data, 46, 0x1320)  # tracker id
    p = tmp_path / "tune.s3m"
    p.write_bytes(bytes(data))
    out = parse_tracker_header(p)
    assert out["header_format"] == "s3m"
    assert out["title"] == "scream tracker tune"


def test_mod_header_and_sample_names(tmp_path):
    data = bytearray(1084)
    data[0:20] = b"classic mod".ljust(20, b"\x00")
    data[20:42] = b"bass sample".ljust(22, b"\x00")   # sample 1 name
    data[1080:1084] = b"M.K."
    p = tmp_path / "tune.mod"
    p.write_bytes(bytes(data))
    out = parse_tracker_header(p)
    assert out["header_format"] == "mod"
    assert out["title"] == "classic mod"
    assert "bass sample" in out["sample_names"]


def test_non_tracker_file_is_ignored(tmp_path):
    p = tmp_path / "audio.wav"
    p.write_bytes(b"RIFF" + b"\x00" * 200)
    assert parse_tracker_header(p) == {}
    # Wrong magic for the extension → no header claimed.
    bad = tmp_path / "fake.xm"
    bad.write_bytes(b"\x00" * 300)
    assert parse_tracker_header(bad) == {}


# ── merge + comparison ─────────────────────────────────────────────────────
def test_build_tags_prefers_tracker_on_conflict():
    tracker = {"title": "tracker title", "bpm": 174, "acidized": True}
    ff_raw = {"title": "container title", "bpm": "100", "camelot": "8A"}
    ff_norm = {"bpm": 100.0, "camelot": "8A", "key_canonical": "A minor",
               "initial_key_canonical": "A minor", "raw": {"encoder": "Lavf"}}
    merged = build_tags(ff_norm, ff_raw, tracker)
    # Tracker wins the conflict, container value kept as its own field.
    assert merged["title"] == "tracker title"
    assert merged["tracker_bpm"] == 174
    assert merged["bpm"] == 174
    assert merged["camelot"] == "8A"
    assert merged["acidized"] is True
    assert merged["raw_tags"]["encoder"] == "Lavf"


def test_compare_with_tags_detects_octave_disagreement():
    tags = {"bpm": 165.0, "initial_key_canonical": "A minor"}
    got = compare_with_tags(tags, {"tempo": 82.5, "key": "A minor"})
    assert got["tempo_vs_tag_bpm"] == -82.5
    assert got["tempo_ratio"] == 0.5
    assert got["tempo_octave_equivalent"] is True
    assert got["tempo_agrees_with_tag"] is False
    assert got["key_matches_tag"] is True


def test_compare_with_tags_flags_close_agreement():
    tags = {"bpm": 141.0}
    got = compare_with_tags(tags, {"tempo": 142.35})
    assert got["tempo_agrees_with_tag"] is True
    assert got["tempo_octave_equivalent"] is True


def test_compare_with_tags_detects_key_mismatch():
    # Abm (G# minor) vs Ebm (D# minor): a fifth apart, not the same key.
    tags = {"initial_key_canonical": "G# minor"}
    got = compare_with_tags(tags, {"tempo": 100.0, "key": "D# minor"})
    assert got["key_matches_tag"] is False
    assert got["key_pitch_class_delta"] == 7          # a fifth apart
    assert got["key_relative_of_tag"] is False


def test_compare_with_tags_recognises_relative_key():
    """G# minor and its relative major B major are the same pitch class set —
    a classic detector confusion that should be named, not called 'wrong'."""
    tags = {"initial_key_canonical": "G# minor"}
    got = compare_with_tags(tags, {"tempo": 100.0, "key": "B major"})
    assert got["key_matches_tag"] is False
    assert got["key_pitch_class_delta"] == 3          # minor third = relative
    assert got["key_relative_of_tag"] is True


def test_compare_with_nothing_is_empty():
    assert compare_with_tags(None, {}) == {}
    assert compare_with_tags({}, {"tempo": 120.0}) == {}


# ── schema migration ───────────────────────────────────────────────────────
def test_tag_columns_migrate_on_existing_db(tmp_path):
    """A database created BEFORE the tag columns must gain them without losing
    its rows — the user's catalog already holds real scans."""
    legacy = tmp_path / "legacy.db"
    import re
    import sqlite3
    # Build the *actual* previous-version media table: current SCHEMA minus the
    # tag columns, so this exercises the real upgrade path rather than a toy.
    legacy_schema = audio_db.SCHEMA
    for column in audio_db.TAG_COLUMNS:
        legacy_schema = re.sub(rf"^\s*{column}[^,]*,\n", "", legacy_schema,
                               flags=re.MULTILINE)
    legacy_schema = legacy_schema.split("-- Slice 8")[0]
    conn = sqlite3.connect(legacy)
    conn.executescript(legacy_schema)
    conn.execute(
        "INSERT INTO media (path, file_hash, type, status, tempo, key_name) "
        "VALUES ('/old/song.flac', 'h', 'audio', 'analyzed', 120.0, 'C major')")
    conn.commit()
    conn.close()

    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(legacy))
    try:
        audio_db.init_db()
        with audio_db.get_db() as db:
            cols = {r["name"] for r in db.execute("PRAGMA table_info(media)")}
            assert {"tag_bpm", "tag_key", "tag_camelot", "tags_json"} <= cols
            row = db.execute("SELECT path, tempo, key_name FROM media").fetchone()
            assert row["path"] == "/old/song.flac"   # data survived
            assert row["tempo"] == 120.0
            assert row["key_name"] == "C major"
    finally:
        audio_db.set_db_path(prev)


def test_save_tags_writes_promoted_columns(tmp_path):
    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(tmp_path / "c.db"))
    try:
        audio_db.init_db()
        audio_db.catalog_upsert("/x/track.flac", origin="import", owned_dirs=[],
                                generated_flag=False, status="scanned")
        audio_db.save_tags("/x/track.flac", {
            "title": "My Tune", "artist": "Me", "bpm": 147.0,
            "key_canonical": "G# minor", "initial_key_canonical": "G# minor",
            "camelot": "1A", "acidized": False, "raw_tags": {"encoder": "Lavf"},
        })
        row = audio_db.get_row("/x/track.flac")
        assert row["title"] == "My Tune"
        assert row["tag_bpm"] == 147.0
        assert row["tag_initial_key"] == "G# minor"
        assert row["tag_camelot"] == "1A"
        assert row["tag_acidized"] == 0
        assert "Lavf" in row["tags_json"]
    finally:
        audio_db.set_db_path(prev)