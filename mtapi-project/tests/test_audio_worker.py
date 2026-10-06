"""Slice 7: isolated audio workers + multi-engine opinions.

Covers the worker subprocess contract, the opinion merge/consensus rules, the
missing-worker fallback, and the deliberately *engine-agnostic* downbeat
derivation. Tests that would need the real audio venvs are skipped when they are
absent so the suite stays green on a bare checkout.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.audio_pipeline.scanner import (  # noqa: E402
    MODERN_WORKER,
    LEGACY_WORKER,
    WORKER_SCRIPT,
    consensus,
    derive_downbeats,
    merge_opinions,
    octave_group,
    run_worker,
    worker_availability,
)

MODERN_PY = Path(MODERN_WORKER) / "bin" / "python"
LEGACY_PY = Path(LEGACY_WORKER) / "bin" / "python"
HAVE_MODERN = MODERN_PY.is_file() and WORKER_SCRIPT.is_file()
HAVE_LEGACY = LEGACY_PY.is_file() and WORKER_SCRIPT.is_file()


def make_wav(path: Path, seconds: float = 2.0, sr: int = 44100, freq: float = 220.0) -> str:
    import soundfile as sf
    t = np.arange(int(sr * seconds)) / sr
    wave = np.sin(2 * np.pi * freq * t).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), wave, sr)
    return str(path)


# ── availability + contract ────────────────────────────────────────────────
def test_worker_availability_shape():
    avail = worker_availability()
    assert set(avail) == {"modern", "legacy"}
    for entry in avail.values():
        assert set(entry) == {"venv", "python", "available"}
        assert isinstance(entry["available"], bool)


def test_worker_script_exists_and_is_app_free():
    """The worker must import nothing from `app` — that is what lets it run under
    an interpreter that predates the app's own syntax."""
    assert WORKER_SCRIPT.is_file(), "tools/audio_worker.py missing"
    text = WORKER_SCRIPT.read_text(encoding="utf-8")
    assert "from app" not in text and "import app" not in text


@pytest.mark.skipif(not HAVE_MODERN, reason="modern audio venv not installed")
def test_modern_worker_returns_json_contract(tmp_path):
    wav = make_wav(tmp_path / "a.wav")
    proc = subprocess.run(
        [str(MODERN_PY), str(WORKER_SCRIPT), "--wav", wav,
         "--want", "key,tempo,beats,onsets", "--engines", "essentia"],
        capture_output=True, text=True, timeout=600, cwd=str(ROOT),
    )
    assert proc.returncode == 0, proc.stderr[-500:]
    line = next(l for l in proc.stdout.splitlines() if l.startswith("@@MTAPI_AUDIO_JSON@@"))
    payload = json.loads(line[len("@@MTAPI_AUDIO_JSON@@"):])
    assert payload["ok"] is True
    assert payload["engines"]["essentia"] is True
    assert set(payload["opinions"]) >= {"key", "tempo", "beats", "onsets"}
    tempo_engines = {o["engine"] for o in payload["opinions"]["tempo"]}
    # Duplicates are the whole point: two Essentia tempo estimators.
    assert {"essentia-degara", "essentia-multifeature"} <= tempo_engines


@pytest.mark.skipif(not HAVE_MODERN, reason="modern audio venv not installed")
def test_worker_reports_engine_failure_without_crashing(tmp_path):
    """A missing engine must be reported, never crash the worker."""
    wav = make_wav(tmp_path / "a.wav")
    proc = subprocess.run(
        [str(MODERN_PY), str(WORKER_SCRIPT), "--wav", wav,
         "--want", "key", "--engines", "definitely_not_an_engine"],
        capture_output=True, text=True, timeout=600, cwd=str(ROOT),
    )
    assert proc.returncode == 0
    line = next(l for l in proc.stdout.splitlines() if l.startswith("@@MTAPI_AUDIO_JSON@@"))
    payload = json.loads(line[len("@@MTAPI_AUDIO_JSON@@"):])
    assert "definitely_not_an_engine" in payload["errors"]


def test_run_worker_reports_missing_venv(tmp_path):
    """A venv that does not exist must degrade to a clean error, never raise."""
    wav = make_wav(tmp_path / "a.wav")
    res = asyncio.run(run_worker(str(tmp_path / "nope-venv"), Path(wav),
                                 want={"key"}, engines="essentia"))
    assert res["ok"] is False
    assert res["opinions"] == {}
    assert "worker" in res["errors"]


# ── merge + consensus ──────────────────────────────────────────────────────
def _payload(**opinions_by_kind):
    return {"ok": True, "opinions": opinions_by_kind, "engines": {}, "errors": {}}


def test_merge_opinions_flattens_and_dedupes():
    a = _payload(tempo=[{"engine": "essentia-degara", "bpm": 120.0}])
    b = _payload(tempo=[{"engine": "essentia-degara", "bpm": 120.0},
                        {"engine": "madmom-dbn-histogram", "bpm": 118.0}])
    merged = merge_opinions([a, b])
    engines = [o["engine"] for o in merged["tempo"]]
    assert engines.count("essentia-degara") == 1, "duplicate engine must collapse"
    assert "madmom-dbn-histogram" in engines


def test_consensus_majority_vote_beats_fixed_preference():
    merged = {
        "tempo": [
            {"engine": "librosa-beat_track", "bpm": 90.0},
            {"engine": "essentia-multifeature", "bpm": 117.6},
            {"engine": "essentia-degara", "bpm": 120.0},
        ]
    }
    out = consensus(merged)
    # One engine says 90, two say ~118-120: the majority side wins outright.
    assert out["tempo"] == 120.0
    assert out["tempo_engine"] == "vote(1)"
    assert out["tempo_spread_bpm"] == 30.0
    assert out["tempo_agreeing_engines"] == 3
    # The documented sidecar shape must survive the worker refactor.
    alt = out["tempo_alternates"]
    assert alt["bpm_degara"] == 120.0
    assert alt["bpm_multifeature"] == 117.6
    assert alt["all_engines"]["librosa-beat_track"] == 90.0


def test_consensus_ignores_zero_bpm_engines():
    """A tracker that reports 0.0 (no pulse found) must not win the headline."""
    merged = {"tempo": [{"engine": "librosa-beat_track", "bpm": 0.0},
                        {"engine": "essentia-degara", "bpm": 120.0}]}
    out = consensus(merged)
    assert out["tempo"] == 120.0
    assert out["tempo_agreeing_engines"] == 1


def test_consensus_picks_densest_beat_grid_and_records_the_split():
    merged = {"beats": [
        {"engine": "essentia-beats", "count": 31, "beats": [0.1, 0.6, 1.1]},
        {"engine": "madmom-dbn", "count": 33, "beats": [0.0, 0.49, 0.99]},
    ]}
    out = consensus(merged)
    assert out["beats_count"] == 33
    assert out["beats_engine"] == "madmom-dbn"
    # The disagreement is recorded, not hidden.
    assert out["beat_counts_by_engine"] == {"essentia-beats": 31, "madmom-dbn": 33}


def test_consensus_splits_midi_kinds():
    merged = {"midi": [
        {"engine": "mido-tempo-map", "path": "/x/a.mid", "kind": "tempo_map"},
        {"engine": "basic-pitch", "path": "/x/a.notes.mid", "kind": "notes", "note_count": 42},
    ]}
    out = consensus(merged)
    assert out["midi_path"] == "/x/a.mid"
    assert out["notes_midi_path"] == "/x/a.notes.mid"
    assert out["notes_midi_count"] == 42


def test_consensus_with_nothing_is_empty_not_an_error():
    out = consensus({})
    assert out["tempo"] is None
    assert out["tempo_spread_bpm"] is None


# ── downbeats (engine-agnostic) ────────────────────────────────────────────
def test_derive_downbeats_picks_the_densest_phase():
    beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5]
    # Beats 1.0 and 3.0 are indices 2 and 6 → phase 2 is the densest.
    onsets = [1.0, 3.0]
    phase, downbeats = derive_downbeats(beats, onsets)
    assert phase == 2
    assert downbeats == [1.0, 3.0]


def test_derive_downbeats_without_onsets_falls_back_to_phase_zero():
    beats = [0.0, 0.5, 1.0, 1.5, 2.0]
    phase, downbeats = derive_downbeats(beats, None)
    assert phase == 0
    assert downbeats == [0.0, 2.0]


def test_derive_downbeats_handles_empty():
    assert derive_downbeats([], []) == (0, [])


# ── both venvs together ────────────────────────────────────────────────────
@pytest.mark.skipif(not (HAVE_MODERN and HAVE_LEGACY), reason="both audio venvs needed")
def test_two_venvs_produce_competing_opinions(tmp_path):
    """The user's actual ask: two engines, two answers, both preserved."""
    import soundfile as sf

    # 4/4 at 120 BPM so madmom (≈33) and essentia (≈31) visibly differ.
    sr, beat = 44100, 0.5
    chunks = []
    for _bar in range(4):
        for freq in (261.63, 329.63, 392.0, 493.88):
            t = np.arange(int(sr * beat)) / sr
            chunks.append((np.sin(2 * np.pi * freq * t) * 0.4).astype(np.float32))
    src = tmp_path / "grid.wav"
    sf.write(str(src), np.concatenate(chunks), sr)

    modern = asyncio.run(run_worker(MODERN_WORKER, Path(str(src)),
                                    want={"tempo", "beats"}, engines="essentia"))
    legacy = asyncio.run(run_worker(LEGACY_WORKER, Path(str(src)),
                                    want={"tempo", "beats"}, engines="madmom"))
    merged = merge_opinions([modern, legacy])
    tempo_engines = {o["engine"] for o in merged["tempo"]}
    assert "essentia-degara" in tempo_engines
    assert "madmom-dbn-histogram" in tempo_engines
    beat_engines = {o["engine"] for o in merged["beats"]}
    assert "essentia-beats" in beat_engines and "madmom-dbn" in beat_engines

    out = consensus(merged)
    assert out["tempo"] and out["tempo_engine"].startswith("vote(")
    assert out["tempo_octave_split"] is False
    assert out["beat_counts_by_engine"], "both beat counts must survive"

def test_octave_split_is_detected_and_majority_wins():
    """The real failure on the user's library: one engine reporting exactly
    double time (librosa 166.71 vs essentia 82.99). The split must be surfaced,
    and the two-against-one side must win."""
    merged = {"tempo": [
        {"engine": "essentia-degara", "bpm": 82.99},
        {"engine": "essentia-multifeature", "bpm": 83.11},
        {"engine": "librosa-beat_track", "bpm": 166.71},
    ]}
    out = consensus(merged)
    assert out["tempo_octave_split"] is True
    assert 82.0 <= out["tempo"] <= 84.0, "majority side must win"
    # All three fold to the same octave group, so the median of that group wins
    # (83.11) — and the octave split is still reported from the raw values.
    assert out["tempo_engine"] == "vote(3)"
    assert out["tempo_spread_bpm"] == round(166.71 - 82.99, 2)
    # The dissenting octave is named, not discarded.
    assert out["tempo_octave_minorities"]
    assert 166.71 in out["tempo_octave_minorities"].values()
    # Every raw opinion is still recorded, including the dissenting octave.
    assert out["tempo_votes"]["essentia-degara"] == 82.99
    assert out["tempo_votes"]["librosa-beat_track"] == 166.71


def test_octave_folding_groups_related_tempos():
    assert octave_group(82.99) == octave_group(166.71)
    assert octave_group(120.0) == octave_group(60.0)
    assert octave_group(90.0) != octave_group(140.0)


def test_tie_prefers_the_measured_engine_group():
    """With every engine alone in its own octave group, degara still wins — the
    Slice 3 measurement must not be thrown away by the new vote."""
    merged = {"tempo": [
        {"engine": "essentia-degara", "bpm": 120.0},
        {"engine": "essentia-multifeature", "bpm": 117.6},
    ]}
    out = consensus(merged)
    assert out["tempo"] == 120.0
