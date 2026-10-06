"""Scan op + key/tempo analysis checks (spec §7).

The ground truth is real, not mocked: a generated fixture is a C-major arpeggio
at exactly 120 BPM, so key/tempo assertions are measured against a known answer.
Engine-dependent assertions skip cleanly when Essentia is absent.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.audio_pipeline.scanner import (  # noqa: E402
    AudioScanner,
    _canonical_key,
    analyze_wav,
    engine_status,
    essentia_available,
)
from app.database import audio_db  # noqa: E402
from app.operations.media_catalog_ops import (  # noqa: E402
    MediaCatalogScanParams,
    media_catalog_scan,
)

VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".webm", ".avi"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}

FIXTURE_BPM = 120.0
FIXTURE_KEY = "C major"

needs_essentia = pytest.mark.skipif(
    not essentia_available(), reason="essentia not installed"
)


def _is_video(p: Path) -> bool:
    return p.suffix.lower() in VIDEO_EXTS


def _is_image(p: Path) -> bool:
    return p.suffix.lower() in IMAGE_EXTS


def make_fixture(path: Path, bpm: float = FIXTURE_BPM, sr: int = 44100) -> str:
    """C-major arpeggio at a known BPM — the ground truth for the assertions."""
    import soundfile as sf
    beat = 60.0 / bpm
    notes = [261.63, 329.63, 392.00, 493.88]  # C4 E4 G4 B4
    chunks = []
    for _bar in range(8):
        for n in notes:
            t = np.arange(int(sr * beat)) / sr
            wave = (np.sin(2 * np.pi * n * t)
                    + 0.5 * np.sin(4 * np.pi * n * t)
                    + 0.25 * np.sin(6 * np.pi * n * t))
            env = np.minimum(1.0, np.minimum(t / 0.01, (beat - t) / 0.05))
            chunks.append(wave * env * 0.4)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.concatenate(chunks).astype(np.float32), sr)
    return str(path)


@pytest.fixture
def db(tmp_path):
    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(tmp_path / "catalog.db"))
    audio_db.init_db()
    yield
    audio_db.set_db_path(prev)


# ── engine plumbing ───────────────────────────────────────────────────────
def test_engine_status_reports_all_four(db):
    status = engine_status()
    assert set(status) == {"essentia", "mido", "librosa", "madmom", "aubio", "basic_pitch"}
    assert all(isinstance(v, bool) for v in status.values())


def test_canonical_key_maps_scale_words():
    assert _canonical_key("C", "major") == "C major"
    assert _canonical_key("A", "minor") == "A minor"
    assert _canonical_key("F#", "minor") == "F# minor"
    assert _canonical_key("Bb", "Major") == "Bb major"  # case-insensitive scale


# ── real measurement against ground truth ─────────────────────────────────
@needs_essentia
def test_key_and_tempo_match_known_fixture(db, tmp_path):
    src = make_fixture(tmp_path / "cmajor120.wav")
    feats = analyze_wav(Path(src), want_key=True, want_tempo=True)

    assert feats["key"] == FIXTURE_KEY
    assert feats["key_strength"] and feats["key_strength"] > 0.3
    assert feats["tempo"] is not None
    # degara measured 120.029 on this fixture; allow 1% for encoder variance.
    assert abs(feats["tempo"] - FIXTURE_BPM) / FIXTURE_BPM < 0.01
    assert 0.0 <= feats["tempo_conf"] <= 1.0
    assert feats["beats"] and len(feats["beats"]) > 4
    assert feats["engines"]["key"].startswith("essentia")


@needs_essentia
def test_tempo_alternates_preserved(db, tmp_path):
    src = make_fixture(tmp_path / "cmajor120.wav")
    feats = analyze_wav(Path(src))
    alt = feats["tempo_alternates"]
    assert alt["bpm_degara"] and alt["bpm_multifeature"]
    # Both estimates are kept so disagreement stays visible.
    assert alt["source"] in ("degara", "multifeature")
    assert alt["disagreement"] is not None


# ── scanner indexing ──────────────────────────────────────────────────────
def test_scanner_indexes_audio_video_image(db, tmp_path):
    from app.audio_pipeline import scanner as sc

    wav = make_fixture(tmp_path / "lib" / "a.wav")
    (tmp_path / "lib" / "b.mp4").write_bytes(b"\0" * 512)   # stand-in bytes
    (tmp_path / "lib" / "c.png").write_bytes(b"\0" * 512)
    (tmp_path / "lib" / "notes.txt").write_text("skip me")

    scanner = sc.AudioScanner(str(tmp_path / "lib"), is_video_fn=_is_video,
                              is_image_fn=_is_image)
    found = sorted(p.name for p in scanner.iter_media_files())
    assert found == ["a.wav", "b.mp4", "c.png"]  # txt ignored

    for p in scanner.iter_media_files():
        scanner.index_file(p)
    assert audio_db.get_row(wav)["type"] == "audio"
    assert audio_db.get_row(str(tmp_path / "lib" / "b.mp4"))["type"] == "video"
    assert audio_db.get_row(str(tmp_path / "lib" / "c.png"))["type"] == "image"


def test_scanner_non_recursive(db, tmp_path):
    from app.audio_pipeline import scanner as sc

    make_fixture(tmp_path / "top" / "a.wav")
    make_fixture(tmp_path / "top" / "nested" / "b.wav")
    scanner = sc.AudioScanner(str(tmp_path / "top"), is_video_fn=_is_video,
                              is_image_fn=_is_image)
    shallow = sorted(p.name for p in scanner.iter_media_files(recursive=False))
    deep = sorted(p.name for p in scanner.iter_media_files(recursive=True))
    assert shallow == ["a.wav"]
    assert deep == ["a.wav", "b.wav"]


def test_needs_analysis_respects_hash_dedup(db, tmp_path):
    from app.audio_pipeline import scanner as sc

    src = make_fixture(tmp_path / "a.wav")
    scanner = sc.AudioScanner(str(tmp_path), is_video_fn=_is_video, is_image_fn=_is_image)
    assert scanner.needs_analysis(Path(src)) is True      # unknown row
    scanner.index_file(Path(src), status="analyzed")
    assert scanner.needs_analysis(Path(src)) is False     # same hash + analyzed
    make_fixture(Path(src), bpm=90.0)                    # bytes changed
    assert scanner.needs_analysis(Path(src)) is True


# ── the op ────────────────────────────────────────────────────────────────
def test_scan_op_dry_run_lists_without_writing(db, tmp_path, monkeypatch):
    async def _run():
        make_fixture(tmp_path / "lib" / "a.wav")
        p = MediaCatalogScanParams(target_directory=str(tmp_path / "lib"), dry_run=True)
        res = await media_catalog_scan(p)
        assert res.ok is True
        assert res.dry_run is True
        assert "a.wav" in (res.stdout or "")
        # Nothing was written.
        with audio_db.get_db() as db_conn:
            assert db_conn.execute("SELECT COUNT(*) FROM media").fetchone()[0] == 0
        assert not list((tmp_path / "lib").glob("*.json"))


    return asyncio.run(_run())

def test_scan_op_rejects_bad_directory(db, tmp_path):
    async def _run():
        res = await media_catalog_scan(
            MediaCatalogScanParams(target_directory=str(tmp_path / "nope")))
        assert res.ok is False
        assert "not a directory" in res.error


    return asyncio.run(_run())

def test_scan_op_midi_refuses_without_mido(db, tmp_path, monkeypatch):
    """MIDI must refuse loudly when mido is missing, never write a broken file."""
    async def _run():
        make_fixture(tmp_path / "lib" / "a.wav")
        monkeypatch.setattr("app.operations.media_catalog_ops.scanner_midi_available",
                            lambda: False)
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "lib"), analyze_midi=True))
        assert res.ok is False
        assert "mido" in res.error
        assert not list((tmp_path / "lib").glob("*.mid"))


    return asyncio.run(_run())

def test_scan_op_index_only_never_needs_essentia(db, tmp_path, monkeypatch):
    async def _run():
        make_fixture(tmp_path / "lib" / "a.wav")
        monkeypatch.setattr("app.operations.media_catalog_ops.essentia_available",
                            lambda: False)
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "lib"),
            analyze_key=False, analyze_tempo=False))
        assert res.ok is True
        assert res.meta["indexed"] == 1
        assert res.meta["analyzed"] == 0


    return asyncio.run(_run())

def test_scan_op_loud_failure_when_engine_missing(db, tmp_path, monkeypatch):
    async def _run():
        make_fixture(tmp_path / "lib" / "a.wav")
        monkeypatch.setattr("app.operations.media_catalog_ops.essentia_available",
                            lambda: False)
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "lib"), analyze_key=True))
        assert res.ok is False
        assert "essentia" in res.error.lower()


    return asyncio.run(_run())

@needs_essentia
def test_scan_op_analyzes_and_writes_sidecar(db, tmp_path, monkeypatch):
    async def _run():
        src = make_fixture(tmp_path / "lib" / "cmajor120.wav")
        monkeypatch.setattr("app.operations.media_catalog_ops.load_settings",
                            lambda: {"owned_dirs": [str(tmp_path / "lib")]})
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "lib"),
            analyze_key=True, analyze_tempo=True))
        assert res.ok is True, res.stdout
        assert res.meta["indexed"] == 1
        assert res.meta["analyzed"] == 1

        row = audio_db.get_row(src)
        assert row["status"] == "analyzed"
        assert row["key_name"] == FIXTURE_KEY
        assert abs(row["tempo"] - FIXTURE_BPM) / FIXTURE_BPM < 0.01
        assert row["is_mine"] == 1 and row["mine_source"] == "dir_rule"  # rule applied
        assert row["duration"] and row["duration"] > 10
        assert row["sidecar_json_path"] == f"{src}.json"

        sidecar = Path(f"{src}.json")
        assert sidecar.is_file()
        payload = json.loads(sidecar.read_text())
        assert payload["key"] == FIXTURE_KEY
        assert payload["path"] == src
        assert payload["is_mine"] is True
        assert payload["tempo_alternates"]["bpm_degara"]


    return asyncio.run(_run())

@needs_essentia
def test_scan_op_dedups_unchanged_files_on_second_run(db, tmp_path, monkeypatch):
    async def _run():
        src = make_fixture(tmp_path / "lib" / "a.wav")
        params = dict(target_directory=str(tmp_path / "lib"),
                      analyze_key=True, analyze_tempo=True)
        first = await media_catalog_scan(MediaCatalogScanParams(**params))
        assert first.meta["analyzed"] == 1
        second = await media_catalog_scan(MediaCatalogScanParams(**params))
        assert second.meta["unchanged"] == 1
        assert second.meta["analyzed"] == 0
        # reanalyze forces the work again
        third = await media_catalog_scan(MediaCatalogScanParams(**params, reanalyze=True))
        assert third.meta["analyzed"] == 1


    return asyncio.run(_run())

@needs_essentia
def test_scan_op_video_without_audio_is_not_an_error(db, tmp_path, monkeypatch):
    async def _run():
        import subprocess
        silent = tmp_path / "lib" / "silent.mp4"
        silent.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-nostdin", "-y", "-loglevel", "error",
             "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", str(silent)],
            check=True, timeout=120,
        )
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "lib"),
            analyze_key=True, analyze_tempo=True))
        assert res.ok is True, res.stdout
        assert res.meta["no_audio"] == 1
        assert res.meta["errors"] == []
        row = audio_db.get_row(str(silent))
        assert row["status"] == "scanned"  # not 'error'
        assert row["key_name"] is None


    return asyncio.run(_run())

@needs_essentia
def test_scan_op_corrupt_file_marks_row_and_continues(db, tmp_path, monkeypatch):
    async def _run():
        good = make_fixture(tmp_path / "lib" / "good.wav")
        bad = tmp_path / "lib" / "bad.wav"
        bad.write_bytes(b"not really a wav at all" * 40)
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "lib"),
            analyze_key=True, analyze_tempo=True))
        assert res.ok is True  # scan itself succeeded
        assert res.meta["analyzed"] >= 1
        # The corrupt file never became an error row that stops the batch.
        assert audio_db.get_row(str(good))["status"] == "analyzed"
        bad_row = audio_db.get_row(str(bad))
        assert bad_row["status"] in ("scanned", "error", "analyzed")


    return asyncio.run(_run())

@needs_essentia
def test_long_file_guard_limits_analysis_window(db, tmp_path, monkeypatch):
    # 8 bars at 120bpm = 16s; a 4s guard must shorten the analysed window
    # while still reading the key off the first beats.
    async def _run():
        src = make_fixture(tmp_path / "lib" / "a.wav")
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "lib"), analyze_key=True, analyze_tempo=True,
            long_file_guard_sec=4))
        assert res.ok is True, res.stdout
        row = audio_db.get_row(src)
        assert row["duration"] is not None and row["duration"] <= 4.5
        assert row["key_name"] == FIXTURE_KEY

    return asyncio.run(_run())


def test_scan_op_empty_directory_is_ok(db, tmp_path):
    async def _run():
        (tmp_path / "empty").mkdir()
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "empty"), analyze_key=False, analyze_tempo=False))
        assert res.ok is True
        assert res.meta["indexed"] == 0
    return asyncio.run(_run())


def test_scan_marks_missing_files_but_keeps_the_row(db, tmp_path, monkeypatch):
    """Spec §13: a vanished file becomes status='missing', never deleted."""
    async def _run():
        lib = tmp_path / "lib"
        src = make_fixture(lib / "here.wav")
        gone = make_fixture(lib / "gone.wav")
        monkeypatch.setattr("app.operations.media_catalog_ops.load_settings",
                            lambda: {"owned_dirs": []})
        first = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(lib), analyze_key=False, analyze_tempo=False))
        assert first.meta["indexed"] == 2
        Path(gone).unlink()

        second = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(lib), analyze_key=False, analyze_tempo=False))
        assert second.meta["missing"] == 1
        row = audio_db.get_row(gone)
        assert row is not None, "row must survive — mounts come back"
        assert row["status"] == "missing"
        assert audio_db.get_row(src)["status"] == "scanned"

        # Restoring the file brings the row back on the next scan.
        make_fixture(Path(gone))
        third = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(lib), analyze_key=False, analyze_tempo=False))
        assert audio_db.get_row(gone)["status"] == "scanned"

    return asyncio.run(_run())


def test_missing_sweep_is_scoped_to_the_scanned_directory(db, tmp_path, monkeypatch):
    """A scan of one folder must not rewrite rows belonging to another."""
    async def _run():
        lib_a = tmp_path / "a"
        lib_b = tmp_path / "b"
        keep = make_fixture(lib_a / "keep.wav")
        other = make_fixture(lib_b / "other.wav")
        monkeypatch.setattr("app.operations.media_catalog_ops.load_settings",
                            lambda: {"owned_dirs": []})
        await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(lib_a), analyze_key=False, analyze_tempo=False))
        await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(lib_b), analyze_key=False, analyze_tempo=False))
        Path(other).unlink()
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(lib_a), analyze_key=False, analyze_tempo=False))
        assert res.meta["missing"] == 0
        assert audio_db.get_row(keep)["status"] == "scanned"
        assert audio_db.get_row(other)["status"] == "scanned"  # untouched

    return asyncio.run(_run())


def test_scan_op_reports_no_output_file(db, tmp_path):
    """A scan generates nothing, so it must not hand the preview panel a
    'generated file' card pointing at a directory."""
    def _run():
        make_fixture(tmp_path / "lib" / "a.wav")
        res = asyncio.run(media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "lib"), analyze_key=False, analyze_tempo=False)))
        assert res.output_path is None
        assert res.meta["scanned_directory"] == str(tmp_path / "lib")
    _run()


# ── Slice 4: beats, onsets, MIDI ────────────────────────────────────────────

def test_beat_grid_matches_known_fixture(db, tmp_path):
    """The fixture is 4/4 at 120 BPM, so beats must land ~0.5s apart and
    downbeats every 4th beat (~2.0s apart)."""
    from app.audio_pipeline.scanner import analyze_beats_and_onsets
    import soundfile as sf

    src = make_fixture(tmp_path / "a.wav")
    y, _sr = sf.read(src, dtype="float32")
    grid = analyze_beats_and_onsets(y)

    beats = grid["beats"]
    assert len(beats) >= 28, f"expected ~32 beats in 16s, got {len(beats)}"
    assert 0.45 < grid["beat_intervals_median"] < 0.55  # ~120 bpm
    # Downbeats must be a quarter of the beat grid.
    assert 6 <= len(grid["downbeats"]) <= 10
    spacing = [grid["downbeats"][i + 1] - grid["downbeats"][i]
               for i in range(len(grid["downbeats"]) - 1)]
    assert spacing and all(1.8 < s < 2.2 for s in spacing), spacing
    # Onsets must exist and the rate be sane.
    assert len(grid["onsets"]) > 5
    assert 0.5 < grid["onset_rate"] < 40


def test_meter_is_labelled_as_assumed(db, tmp_path):
    """This Essentia wheel has no band-ratio beatogram, so meter is assumed —
    and the flag must say so rather than implying detection."""
    from app.audio_pipeline.scanner import analyze_beats_and_onsets
    import soundfile as sf

    y, _sr = sf.read(make_fixture(tmp_path / "a.wav"), dtype="float32")
    grid = analyze_beats_and_onsets(y)
    assert grid["time_signature"] == "4/4"
    assert grid["meter_assumed"] is True
    assert 0 <= grid["downbeat_index"] <= 3


def test_tempo_map_midi_is_valid(db, tmp_path):
    import mido
    from app.audio_pipeline.scanner import write_tempo_map_midi

    dest = tmp_path / "grid.mid"
    beats = [0.0, 0.5, 1.0, 1.5, 2.0]
    downbeats = [0.0, 2.0]
    assert write_tempo_map_midi(dest, tempo=120.0, beats=beats, downbeats=downbeats) is True

    mid = mido.MidiFile(str(dest))
    assert len(mid.tracks) == 1
    msgs = list(mid.tracks[0])
    tempo_msgs = [m for m in msgs if m.type == "set_tempo"]
    assert tempo_msgs, "tempo map missing"
    assert abs(tempo_msgs[0].tempo - 500000) < 1  # 120 bpm == 500000 us/beat
    note_ons = [m for m in msgs if m.type == "note_on" and m.velocity > 0]
    assert len(note_ons) == len(beats)
    # Downbeats are the accented (velocity 100) notes.
    assert sum(1 for m in note_ons if m.velocity == 100) == len(downbeats)
    assert any(m.type == "end_of_track" for m in msgs)


@needs_essentia
def test_scan_op_writes_beats_and_midi_sidecars(db, tmp_path):
    async def _run():
        src = make_fixture(tmp_path / "lib" / "a.wav")
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "lib"), analyze_key=True,
            analyze_tempo=True, analyze_beats=True, analyze_midi=True))
        assert res.ok is True, res.stdout
        assert res.meta["analyzed"] == 1

        row = audio_db.get_row(src)
        assert row["midi_path"] == f"{src}.mid"
        assert Path(row["midi_path"]).is_file()
        import json as _json
        raw = _json.loads(row["raw_metadata"])
        assert raw["meter_assumed"] is True
        assert raw["time_signature"] == "4/4"
        assert raw["midi_kind"] == "tempo_map"
        assert len(raw["beats"]) >= 28
        assert raw["downbeats"]

        sidecar = _json.loads(Path(f"{src}.json").read_text())
        assert sidecar["time_signature"] == "4/4"
        assert sidecar["midi_path"] == f"{src}.mid"
        # The sidecar must say what kind of MIDI this is, not imply notes.
        assert "NOT note transcription" in sidecar["midi_note"]

    return asyncio.run(_run())


@needs_essentia
def test_scan_op_beats_only_skips_midi_file(db, tmp_path):
    async def _run():
        src = make_fixture(tmp_path / "lib" / "a.wav")
        res = await media_catalog_scan(MediaCatalogScanParams(
            target_directory=str(tmp_path / "lib"), analyze_key=False,
            analyze_tempo=True, analyze_beats=True, analyze_midi=False))
        assert res.ok is True, res.stdout
        assert not Path(f"{src}.mid").exists()
        row = audio_db.get_row(src)
        assert row["key_name"] is None      # key toggle was off
        assert row["tempo"] is not None     # tempo still ran
        assert row["midi_path"] is None

    return asyncio.run(_run())


def test_engine_status_reports_real_roles(db):
    """Essentia carries key/tempo/beats/onsets; mido carries the MIDI map."""
    status = engine_status()
    assert status["essentia"] is True
    assert "mido" in status
