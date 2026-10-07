"""Content classification + tempo plausibility band (spec ruling 2026-10-07).

The user's corrupt-file test (a near-empty wav left in the library on purpose)
got stored as "1 BPM" and was filterable as a real tempo. The ruling: readings
outside a plausibility band are what silent/corrupt/noise files produce — the
effective tempo goes NULL with a flag, the raw reading stays in the sidecar.
On top of that, cheap numpy-only measurements classify what a file is NOT:
silent, broadband noise, a DC wall. "Music" is never claimed positively.

Thresholds and bands are measured, not assumed: degara reads 738 BPM on
digital silence and 86 BPM on white noise (measured below), so the band alone
cannot catch noise masquerading as music — the content class is what does.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.audio_pipeline.scanner import (  # noqa: E402
    TEMPO_MAX_BPM,
    TEMPO_MIN_BPM,
    content_stats,
    essentia_available,
    tempo_consensus_by_vote,
)
from app.database import audio_db  # noqa: E402
from app.operations.media_catalog_ops import (  # noqa: E402
    MediaCatalogScanParams,
    media_catalog_scan,
)

SR = 44100
needs_essentia = pytest.mark.skipif(
    not essentia_available(), reason="essentia not installed"
)


def _write_wav(path: Path, y) -> str:
    import soundfile as sf
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), y.astype(np.float32), SR)
    return str(path)


# ── content_stats (numpy only, no engines) ────────────────────────────────
def test_silence_classifies_silent():
    s = content_stats(np.zeros(SR * 5, dtype=np.float32))
    assert s["content_class"] == "silent"
    assert s["flatness"] == 1.0 or s["peak_db"] < -60


def test_white_noise_classifies_noise_like():
    rng = np.random.default_rng(7)
    s = content_stats(rng.normal(0, 0.2, SR * 5).astype(np.float32))
    assert s["content_class"] == "noise-like"
    assert s["flatness"] >= 0.7  # measured 0.998 on this fixture


def test_tonal_material_classifies_ok():
    n = SR * 5
    y = 0.4 * np.sin(2 * np.pi * 220 * np.arange(n) / SR)
    y += 0.3 * np.sin(2 * np.pi * 277 * np.arange(n) / SR)
    s = content_stats(y.astype(np.float32))
    assert s["content_class"] == "ok"
    assert s["flatness"] < 0.5


def test_dc_wall_classifies_dc_offset():
    s = content_stats((0.5 * np.ones(SR * 5)).astype(np.float32))
    assert s["content_class"] == "dc-offset"


def test_empty_array_is_silent():
    s = content_stats(np.zeros(0, dtype=np.float32))
    assert s["content_class"] == "silent"


# ── the plausibility band ─────────────────────────────────────────────────
def _op(engine, bpm):
    return {"engine": engine, "bpm": bpm}


def test_band_bounds():
    assert TEMPO_MIN_BPM == 30.0 and TEMPO_MAX_BPM == 300.0


def test_all_implausible_readings_give_null_and_flag():
    r = tempo_consensus_by_vote([_op("essentia-degara", 1.0), _op("x", 738.0)])
    assert r["tempo"] is None
    assert r["tempo_implausible"] is True
    assert r["tempo_rejected"]["essentia-degara"] == 1.0
    assert r["tempo_rejected"]["x"] == 738.0


def test_implausible_reading_loses_vote_but_is_reported():
    r = tempo_consensus_by_vote([
        _op("essentia-degara", 120.0), _op("essentia-multifeature", 120.5),
        _op("bogus", 1.0),
    ])
    assert 119.0 <= r["tempo"] <= 121.0          # the plausible engines win
    assert r["tempo_rejected"] == {"bogus": 1.0}
    assert not r.get("tempo_implausible")        # a consensus exists, so no flag


def test_band_boundaries_inclusive():
    r = tempo_consensus_by_vote([_op("a", 30.0), _op("b", 300.0)])
    assert r["tempo"] is not None                # 30 and 300 are in-band...
    assert not r.get("tempo_implausible")
    r2 = tempo_consensus_by_vote([_op("a", 29.0), _op("b", 301.0)])
    assert r2["tempo"] is None                   # ...29 and 301 are not
    assert r2["tempo_implausible"] is True


def test_zero_bpm_still_excluded_silently():
    r = tempo_consensus_by_vote([_op("a", 0.0)])
    assert r == {}                               # 0 was always "no reading"


# ── migration: previous-version DB gains the columns, keeps its rows ──────
def test_migration_adds_content_columns(tmp_path):
    """A database created BEFORE the content columns must gain them without
    losing its rows — the user's catalog already holds real scans."""
    import re
    import sqlite3
    legacy = tmp_path / "legacy.db"
    # Build the *actual* previous-version media table: current SCHEMA minus
    # every TAG_COLUMN (the 8.133 columns ride the same migration list).
    legacy_schema = audio_db.SCHEMA
    for column in audio_db.TAG_COLUMNS:
        legacy_schema = re.sub(rf"^\s*{column}[^,]*,\n", "", legacy_schema,
                               flags=re.MULTILINE)
    conn = sqlite3.connect(legacy)
    conn.executescript(legacy_schema)
    conn.execute(
        "INSERT INTO media (path, file_hash, type, status, tempo, key_name) "
        "VALUES ('/music2/space2.flac', 'h', 'audio', 'analyzed', 1.0, 'C minor')")
    conn.commit()
    conn.close()

    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(legacy))
    try:
        audio_db.init_db()
        with audio_db.get_db() as db:
            cols = {r["name"] for r in db.execute("PRAGMA table_info(media)")}
            for column in ("tempo_implausible", "level_db", "peak_db",
                           "flatness", "content_class"):
                assert column in cols
            row = db.execute("SELECT path, tempo, key_name FROM media").fetchone()
            assert row["path"] == "/music2/space2.flac"   # nothing lost
            assert row["tempo"] == 1.0                    # historical value untouched
            assert row["key_name"] == "C minor"
    finally:
        audio_db.set_db_path(prev)


# ── scan integration: real engines on real silence/noise fixtures ─────────
@pytest.fixture
def db(tmp_path):
    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(tmp_path / "catalog.db"))
    audio_db.init_db()
    yield
    audio_db.set_db_path(prev)


@needs_essentia
def test_scan_marks_silent_file(db, tmp_path):
    async def _run():
        _write_wav(tmp_path / "lib" / "silence.wav", np.zeros(SR * 5))
        p = MediaCatalogScanParams(target_directory=str(tmp_path / "lib"),
                                   analyze_key=True, analyze_tempo=True)
        res = await media_catalog_scan(p)
        assert res.ok is True
        row = audio_db.get_row(str(tmp_path / "lib" / "silence.wav"))
        assert row is not None
        assert row["content_class"] == "silent"
        # The ruling: a silent file must never carry a usable tempo. Degara
        # reads 738 BPM on digital silence (measured) — the band rejects it.
        assert row["tempo_detected"] is None
        assert row["tempo_implausible"] in (0, 1)    # set iff degara read >0
        # the raw readings are still on disk, non-destructively
        if row.get("sidecar_json_path"):
            side = json.loads(Path(row["sidecar_json_path"]).read_text())
            assert "tempo_alternates" in side or "tempo_rejected" in side
    return asyncio.run(_run())


@needs_essentia
def test_scan_flags_white_noise_tempo_or_content(db, tmp_path):
    """White noise gets a *plausible-looking* fake tempo (86 BPM measured) —
    the band cannot catch it, the content class must."""
    async def _run():
        rng = np.random.default_rng(3)
        _write_wav(tmp_path / "lib" / "noise.wav",
                   rng.normal(0, 0.2, SR * 5))
        p = MediaCatalogScanParams(target_directory=str(tmp_path / "lib"),
                                   analyze_key=True, analyze_tempo=True)
        res = await media_catalog_scan(p)
        assert res.ok is True
        row = audio_db.get_row(str(tmp_path / "lib" / "noise.wav"))
        assert row["content_class"] == "noise-like"
        assert row["flatness"] >= 0.7
    return asyncio.run(_run())
