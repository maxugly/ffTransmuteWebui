"""Slice 9: everything stored, one chosen source of truth per field.

The contract these tests pin down:
  * both readings always survive (nothing destructive)
  * the default is the owner's tag when one exists
  * an explicit user choice survives later scans and new tags
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.database import audio_db  # noqa: E402


@pytest.fixture
def db(tmp_path):
    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(tmp_path / "c.db"))
    audio_db.init_db()
    audio_db.catalog_upsert("/m/track.flac", origin="import", owned_dirs=[],
                            generated_flag=False, status="analyzed")
    yield
    audio_db.set_db_path(prev)


def _seed_detection(tempo: float, key: str) -> None:
    with audio_db.get_db() as conn:
        conn.execute(
            "UPDATE media SET tempo = ?, tempo_detected = ?, key_name = ?, key_detected = ? "
            "WHERE path = ?", (tempo, tempo, key, key, "/m/track.flac"))


def _seed_tag(bpm: float | None = None, key: str | None = None) -> None:
    audio_db.save_tags("/m/track.flac", {
        "bpm": bpm, "initial_key_canonical": key, "key_canonical": key,
    })


# ── default policy ────────────────────────────────────────────────────────
def test_detection_only_row_uses_detection(db):
    _seed_detection(120.4, "C major")
    audio_db.apply_source_defaults("/m/track.flac")
    row = audio_db.get_row("/m/track.flac")
    assert row["tempo_source"] == "detected"
    assert row["tempo"] == 120.4
    assert row["key_source"] == "detected"


def test_tagged_tempo_wins_by_default(db):
    _seed_detection(120.4, "C major")
    _seed_tag(bpm=141.0)          # save_tags applies the default policy
    row = audio_db.get_row("/m/track.flac")
    assert row["tempo_source"] == "tagged"
    assert row["tempo"] == 141.0          # the tag is authoritative
    assert row["tempo_detected"] == 120.4  # and the detection is still there


def test_tagged_key_wins_by_default(db):
    _seed_detection(120.4, "C major")
    _seed_tag(bpm=141.0, key="G# minor")
    row = audio_db.get_row("/m/track.flac")
    assert row["key_source"] == "tagged"
    assert row["key_name"] == "G# minor"
    assert row["key_detected"] == "C major"


def test_partial_tag_leaves_the_other_field_on_detection(db):
    _seed_detection(120.4, "C major")
    _seed_tag(bpm=141.0)          # tempo tagged, key not
    row = audio_db.get_row("/m/track.flac")
    assert row["tempo_source"] == "tagged"
    assert row["key_source"] == "detected"
    assert row["key_name"] == "C major"


# ── switching ─────────────────────────────────────────────────────────────
def test_switch_to_detected_is_not_destructive(db):
    _seed_detection(120.4, "C major")
    _seed_tag(bpm=141.0)
    res = audio_db.set_source_of_truth("/m/track.flac", "tempo", "detected")
    assert res["source"] == "detected"
    row = audio_db.get_row("/m/track.flac")
    assert row["tempo"] == 120.4
    assert row["tempo_detected"] == 120.4
    assert row["tag_bpm"] == 141.0          # the tag is untouched
    assert row["tempo_source_manual"] == 1


def test_switch_back_to_tagged(db):
    _seed_detection(120.4, "C major")
    _seed_tag(bpm=141.0)
    audio_db.set_source_of_truth("/m/track.flac", "tempo", "detected")
    audio_db.set_source_of_truth("/m/track.flac", "tempo", "tagged")
    row = audio_db.get_row("/m/track.flac")
    assert row["tempo"] == 141.0
    assert row["tempo_detected"] == 120.4


def test_manual_choice_survives_a_new_tag(db):
    """The user picked 'detected'; a later scan adding a tag must not flip it."""
    _seed_detection(120.4, "C major")
    _seed_tag(bpm=141.0)
    audio_db.set_source_of_truth("/m/track.flac", "tempo", "detected")
    _seed_tag(bpm=150.0)          # re-tag, e.g. the owner corrected themselves
    row = audio_db.get_row("/m/track.flac")
    assert row["tempo_source"] == "detected"
    assert row["tempo"] == 120.4
    assert row["tag_bpm"] == 150.0          # newest tag stored, still not in charge


def test_key_switch_is_independent_of_tempo(db):
    _seed_detection(120.4, "C major")
    _seed_tag(bpm=141.0, key="G# minor")
    audio_db.set_source_of_truth("/m/track.flac", "key", "detected")
    row = audio_db.get_row("/m/track.flac")
    assert row["key_name"] == "C major" and row["key_source"] == "detected"
    assert row["tempo"] == 141.0 and row["tempo_source"] == "tagged"


# ── refusals ──────────────────────────────────────────────────────────────
def test_cannot_prefer_a_tag_that_does_not_exist(db):
    _seed_detection(120.4, "C major")
    with pytest.raises(ValueError, match="no tagged tempo"):
        audio_db.set_source_of_truth("/m/track.flac", "tempo", "tagged")


def test_unknown_field_or_choice_is_refused(db):
    with pytest.raises(ValueError):
        audio_db.set_source_of_truth("/m/track.flac", "loudness", "tagged")
    with pytest.raises(ValueError):
        audio_db.set_source_of_truth("/m/track.flac", "tempo", "vibes")
    with pytest.raises(KeyError):
        audio_db.set_source_of_truth("/nope.flac", "tempo", "tagged")


# ── backfill over pre-existing rows ───────────────────────────────────────
def test_backfill_applies_defaults_to_older_rows(tmp_path):
    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(tmp_path / "old.db"))
    try:
        audio_db.init_db()
        audio_db.catalog_upsert("/m/a.flac", origin="import", owned_dirs=[],
                                generated_flag=False, status="analyzed")
        audio_db.catalog_upsert("/m/b.flac", origin="import", owned_dirs=[],
                                generated_flag=False, status="analyzed")
        with audio_db.get_db() as conn:      # simulate rows written before §19
            conn.execute("UPDATE media SET tempo_source=NULL, key_source=NULL,"
                         " tempo=100.0, tempo_detected=100.0")
            conn.execute("UPDATE media SET tag_bpm=140.0 WHERE path='/m/a.flac'")
        applied = audio_db.backfill_source_of_truth()
        assert applied >= 1
        a = audio_db.get_row("/m/a.flac")
        b = audio_db.get_row("/m/b.flac")
        assert (a["tempo_source"], a["tempo"]) == ("tagged", 140.0)
        assert (b["tempo_source"], b["tempo"]) == ("detected", 100.0)
        assert a["tempo_detected"] == 100.0  # detection preserved
    finally:
        audio_db.set_db_path(prev)
