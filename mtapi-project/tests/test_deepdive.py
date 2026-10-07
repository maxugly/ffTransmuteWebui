"""Deep Dive op orchestration tests (spec ruling 2026-10-07).

The contract under test is the ORCHESTRATION, not each model (Demucs/Essentia/
Basic Pitch each have their own suites): one job groups them, a failing model
never fails the dive, every result lands in meta with its own ok flag,
generated artifacts get catalog stamps, and the dive report is a sibling
`<track>.deepdive.json`. Demucs + analysis are faked here so the suite stays
fast and deterministic; the real models are proven live (Playwright).
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.contract import OperationResult, REGISTRY  # noqa: E402
from app.database import audio_db  # noqa: E402
from app.operations import deepdive_ops  # noqa: E402
from app.operations.deepdive_ops import DeepDiveParams, deep_dive  # noqa: E402


@pytest.fixture
def db(tmp_path):
    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(tmp_path / "catalog.db"))
    audio_db.init_db()
    yield
    audio_db.set_db_path(prev)


def _wav(path: Path, secs: float = 2.0) -> str:
    import wave
    import struct
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(44100)
        n = int(44100 * secs)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * (i % 1000) / 1000)) for i in range(n)))
    return str(path)


def _fake_analyze(monkeypatch, feats):
    async def fake(self, path, **kw):
        return True, {**feats}
    monkeypatch.setattr("app.audio_pipeline.scanner.AudioScanner.analyze_file", fake)


def _fake_demucs(monkeypatch, stems_dir: Path, ok: bool = True, error: str | None = None):
    async def fake(params):
        if not ok:
            return OperationResult(ok=False, operation="demucs_separate", error=error or "boom")
        written = {}
        for stem in (params.stems or ["drums", "bass"]):
            p = stems_dir / f"t_{stem}.wav"
            p.write_bytes(b"RIFF-fake-stem" + b"\0" * 64)
            written[stem] = str(p)
        return OperationResult(ok=True, operation="demucs_separate", meta={
            "model": params.model, "device_settled": "GPU", "stems": written, "infer_s": 0.5})
    monkeypatch.setattr("app.operations.demucs_ops.demucs_separate", fake)


def _run(coro):
    return asyncio.run(coro)


# ── registry + validation ─────────────────────────────────────────────────
def test_deep_dive_registered():
    assert "deep_dive" in REGISTRY
    spec = REGISTRY["deep_dive"]
    assert spec.params_model is DeepDiveParams


def test_deep_dive_missing_input(db):
    res = _run(deep_dive(DeepDiveParams(input_path="/nope/missing.flac")))
    assert res.ok is False
    assert "not found" in res.error


# ── orchestration ─────────────────────────────────────────────────────────
def test_deep_dive_groups_all_models(db, tmp_path, monkeypatch):
    src = Path(_wav(tmp_path / "track.wav"))
    _fake_demucs(monkeypatch, tmp_path, ok=True)
    _fake_analyze(monkeypatch, {
        "key": "C major", "key_confidence": 0.9, "tempo": 120.0,
        "beats_count": 32, "downbeats": [0.0, 2.0], "onset_rate": 4.0,
        "meter_assumed": True, "time_signature": "4/4",
        "tempo_engine": "essentia-degara", "key_engine": "essentia-key",
        "tempo_spread_bpm": 1.2, "content_class": "ok",
        "opinions": {"tempo": [{"engine": "essentia-degara", "bpm": 120.0}]},
        "midi_path": str(tmp_path / "track.mid"),
        "notes_midi_path": str(tmp_path / "track.notes.mid"),
        "notes_midi_count": 44,
        "sidecar_json_path": str(tmp_path / "track.json"),
    })
    for p in (tmp_path / "track.mid", tmp_path / "track.notes.mid"):
        p.write_bytes(b"MThd-fake-midi")

    res = _run(deep_dive(DeepDiveParams(input_path=str(src))))
    assert res.ok is True
    meta = res.meta
    assert meta["results"]["demucs"]["ok"] is True
    assert list(meta["results"]["demucs"]["stems"]) == ["drums", "bass"]
    assert meta["results"]["essentia"]["ok"] is True
    assert meta["results"]["essentia"]["tempo"] == 120.0
    assert meta["results"]["essentia"]["engine_opinions"]["tempo"][0]["engine"] == "essentia-degara"  # panel payload
    assert meta["results"]["basic_pitch"]["ok"] is True
    assert meta["results"]["basic_pitch"]["note_count"] == 44
    assert meta["results"]["cdp"]["ok"] is False          # no pipeline requested
    assert meta["failures"] == {}

    # dive report is a sibling of the track
    report = tmp_path / "track.wav.deepdive.json"
    assert report.is_file()
    data = json.loads(report.read_text())
    assert data["deep_dive"] is True
    assert data["results"]["demucs"]["ok"] is True


def test_deep_dive_demucs_failure_never_fails_the_dive(db, tmp_path, monkeypatch):
    src = Path(_wav(tmp_path / "track.wav"))
    _fake_demucs(monkeypatch, tmp_path, ok=False, error="GPU busy")
    _fake_analyze(monkeypatch, {"key": "D minor", "tempo": 100.0, "content_class": "ok"})

    res = _run(deep_dive(DeepDiveParams(input_path=str(src))))
    assert res.ok is True                                   # the dive itself succeeds
    assert res.meta["results"]["demucs"]["ok"] is False
    assert res.meta["failures"]["demucs"] == "GPU busy"
    assert res.meta["results"]["essentia"]["ok"] is True    # the rest still ran


def test_deep_dive_stamps_generated_artifacts(db, tmp_path, monkeypatch):
    src = Path(_wav(tmp_path / "track.wav"))
    _fake_demucs(monkeypatch, tmp_path, ok=True)
    _fake_analyze(monkeypatch, {
        "key": "C major", "tempo": 120.0,
        "midi_path": str(tmp_path / "track.mid"),
        "notes_midi_path": str(tmp_path / "track.notes.mid"),
        "notes_midi_count": 3,
    })
    for p in (tmp_path / "track.mid", tmp_path / "track.notes.mid"):
        p.write_bytes(b"MThd-fake")

    _run(deep_dive(DeepDiveParams(input_path=str(src))))

    row = audio_db.get_row(str(tmp_path / "t_drums.wav"))
    assert row is not None
    assert row["origin"] == "generated"
    # 8.135: derived artifacts point at the track — they stay off the main list
    assert row["derived_from"] == str(src)
    midi_row = audio_db.get_row(str(tmp_path / "track.mid"))
    assert midi_row is not None and midi_row["origin"] == "generated"
    assert midi_row["derived_from"] == str(src)
    notes_row = audio_db.get_row(str(tmp_path / "track.notes.mid"))
    assert notes_row is not None and notes_row["derived_from"] == str(src)


def test_deep_dive_cdp_echo_and_bad_json(db, tmp_path, monkeypatch):
    src = Path(_wav(tmp_path / "track.wav"))
    _fake_demucs(monkeypatch, tmp_path, ok=False, error="skip")
    _fake_analyze(monkeypatch, {"key": "C major"})

    # valid pipeline echoes for browser execution
    pipe = json.dumps({"schema": "mtapi-cdp-pipeline/1", "name": "p", "steps": []})
    res = _run(deep_dive(DeepDiveParams(input_path=str(src), cdp_pipeline_json=pipe)))
    assert res.meta["results"]["cdp"]["ok"] is True
    assert res.meta["results"]["cdp"]["pipeline"]["name"] == "p"

    # bad JSON is a recorded cdp failure, never a job failure
    res2 = _run(deep_dive(DeepDiveParams(input_path=str(src), cdp_pipeline_json="{nope")))
    assert res2.ok is True
    assert res2.meta["results"]["cdp"]["ok"] is False
    assert "bad pipeline JSON" in res2.meta["failures"]["cdp"]


# ── cross-device MIDI move regression (found by the live dive) ───────────
def test_midi_canonical_move_survives_cross_device(tmp_path, monkeypatch):
    """The worker writes its MIDI to a temp dir; the canonical move to the
    media's sibling path crosses filesystems on this box (/tmp is tmpfs, the
    tree is btrfs). A bare Path.replace raises EXDEV and silently nulled the
    path — measured live: Basic Pitch transcribed 33 notes, then lost them.
    shutil.move copies across devices, so this must produce real .mid files.
    """
    from app.audio_pipeline import scanner as sc

    if not any(v.get("available") for v in sc.worker_availability().values()):
        pytest.skip("audio worker venvs unavailable")
    if not sc.essentia_available():
        pytest.skip("essentia unavailable")

    src = Path(_wav(tmp_path / "track.wav", secs=5.0))

    # Force the scanner's temp dir onto the repo device (btrfs) while the
    # media fixture stays on tmp_path (tmpfs) — the exact cross-device pairing.
    # Capture the real class BEFORE patching: the patch replaces the shared
    # tempfile module attribute, which would otherwise recurse into itself.
    real_td = sc.tempfile.TemporaryDirectory

    class CrossDeviceTD:
        def __init__(self, *a, **kw):
            base = ROOT / "junk" / "xdev_tmp"
            base.mkdir(parents=True, exist_ok=True)
            kw.pop("dir", None)
            self._inner = real_td(dir=str(base), *a, **kw)

        def __enter__(self):
            self._inner.__enter__()
            return str(self._inner.name)

        def __exit__(self, *a):
            return self._inner.__exit__(*a)

    monkeypatch.setattr(sc.tempfile, "TemporaryDirectory", CrossDeviceTD)

    async def _run():
        scanner = sc.AudioScanner(target_dir=str(tmp_path))
        ok, feats = await scanner.analyze_file(
            path=src, want_key=False, want_tempo=False, want_beats=False,
            want_midi=True, guard_sec=None, include_legacy=False)
        assert ok is True, feats
        return feats

    feats = asyncio.run(_run())
    assert feats.get("midi_path") == f"{src}.mid"
    assert Path(f"{src}.mid").is_file(), "tempo-map MIDI must land beside the track"
    # Basic Pitch may find notes on a synthetic fixture or not — either way
    # the transcription path must never be silently nulled by a cross-device
    # rename; when notes exist the file must be there.
    if feats.get("notes_midi_path"):
        assert Path(feats["notes_midi_path"]).is_file()
