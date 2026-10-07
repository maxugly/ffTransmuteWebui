"""Offline media scanner: walk → upsert → analyse (spec §5.1, §7).

One code path for every media type: ffmpeg decodes to a temporary 44.1 kHz mono
wav (audio file *or* the audio track of a video — invariant 2: argv list, never
``shell=True``; invariant 3: absolute paths), then Essentia extracts key and
tempo. Images are indexed but never analysed.

Engines are imported lazily so server boot and every non-scan request never pay
Essentia's load cost. Every per-file failure marks the row ``status='error'``,
logs, and continues — a corrupt file never aborts the library scan.

Tempo accuracy note (measured on a known-120 BPM fixture, see
tests/test_media_catalog_scan.py): ``RhythmExtractor2013`` with
``tempoEstimateMethod='degara'`` landed within 0.02%, while ``'multifeature'``
was ~2% off but was the only one reporting a usable confidence. So ``tempo``
comes from degara, ``tempo_conf`` from multifeature (clamped to 0-1), and both
estimates are preserved in ``raw_metadata.tempo_alternates`` so disagreement
stays visible instead of being silently averaged away.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
from pathlib import Path
from typing import Any, Iterator

from app.audio_pipeline.metadata import (
    build_tags,
    compare_with_tags,
    parse_tracker_header,
    read_ffprobe_tags,
)
from app.database import audio_db

DEFAULT_LONG_FILE_GUARD_SEC = 300
ESSENTIA_SAMPLE_RATE = 44100

# Plausibility band for tempo readings (user ruling: nothing below ~40 BPM is
# a real song tempo, and sub-40 detections are what corrupt/silent/noise files
# produce). Readings outside [30, 300] are excluded from the consensus and the
# effective value goes NULL with tempo_implausible=1 — the raw reading stays in
# the sidecar. 30 (not 40) is the hard floor so half-time notations at 32 can
# still be flagged-but-visible; the *effective* value is what never lies.
TEMPO_MIN_BPM = 30.0
TEMPO_MAX_BPM = 300.0

_ess_module: Any = None


def essentia_available() -> bool:
    global _ess_module
    if _ess_module is not None:
        return True
    try:
        import essentia.standard as ess  # noqa: PLC0415
        _ess_module = ess
        return True
    except Exception:
        return False


def engine_status() -> dict[str, bool]:
    """Live engine availability across BOTH the app venv and the worker venvs.

    Slice 4 note: Essentia and mido run in-process here. Slice 7 moved the
    pinned-numpy / pinned-TensorFlow engines (madmom, librosa, basic-pitch) into
    isolated venvs, so their availability is a *worker venv* question, not an
    in-process import — asking this module for them would always say False.
    aubio remains absent everywhere: its 0.4.9 C bindings do not compile against
    any modern numpy and no wheel exists.
    """
    workers = worker_availability()
    modern = workers["modern"]["available"]
    legacy = workers["legacy"]["available"]
    return {
        "essentia": essentia_available(),
        "mido": _importable("mido"),
        "librosa": modern,
        "basic_pitch": modern,
        "madmom": legacy,
        "aubio": _importable("aubio"),
    }


def _importable(name: str) -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


# ── Isolated audio workers (Slice 7) ────────────────────────────────────────
# The analysis libraries need mutually incompatible pins: madmom requires
# Python<=3.9 + numpy<1.22, while basic-pitch needs TF 2.15 and librosa needs a
# modern numpy. So they live in separate venvs and are called as subprocesses
# (`tools/audio_worker.py`, which imports nothing from this app). Env overrides
# mirror the MUSIC_PYTHON precedent in music_ov_engine.
APP_ROOT = Path(__file__).resolve().parents[2]
WORKER_SCRIPT = APP_ROOT / "tools" / "audio_worker.py"

MODERN_WORKER = os.environ.get("MTAPI_AUDIO_VENV", str(APP_ROOT / ".venv-audio"))
LEGACY_WORKER = os.environ.get("MTAPI_AUDIO_LEGACY_VENV", str(APP_ROOT / ".venv-audio-legacy"))

# Primary = Essentia only (one subprocess, fastest). "Extra" opinions add
# librosa (modern venv) and madmom (legacy venv) — two more subprocesses, which
# is what buys the duplicate answers the user wants to compare.
MODERN_ENGINES = "essentia,midi"
MODERN_ENGINES_EXTRA = "essentia,librosa,midi"
LEGACY_ENGINES = "madmom"


def worker_availability() -> dict[str, dict[str, Any]]:
    """Which worker venvs exist on disk (no imports, no subprocess)."""
    out: dict[str, dict[str, Any]] = {}
    for label, venv in (("modern", MODERN_WORKER), ("legacy", LEGACY_WORKER)):
        py = Path(venv) / "bin" / "python"
        out[label] = {
            "venv": venv,
            "python": str(py),
            "available": py.is_file() and WORKER_SCRIPT.is_file(),
        }
    return out


def _clean_times(values) -> list[float]:
    """numpy arrays are truthy-ambiguous — never `or []` them."""
    if values is None:
        return []
    try:
        if len(values) == 0:
            return []
    except TypeError:
        return []
    return [round(float(v), 4) for v in values]


async def run_worker(venv: str, wav: Path, *, want: set[str], engines: str,
                     midi_prefix: str | None = None) -> dict[str, Any]:
    """Run `tools/audio_worker.py` under `venv`'s interpreter. Never raises."""
    from app.shell import run_command

    py = Path(venv) / "bin" / "python"
    if not py.is_file() or not WORKER_SCRIPT.is_file():
        return {"ok": False, "error": "worker unavailable", "opinions": {},
                "engines": {}, "errors": {"worker": "missing interpreter or script"}}
    argv = [str(py), str(WORKER_SCRIPT), "--wav", str(wav),
            "--want", ",".join(sorted(want)), "--engines", engines]
    if midi_prefix:
        argv += ["--midi-out", midi_prefix]
    try:
        code, stdout, stderr = await run_command(argv)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "opinions": {}, "engines": {},
                "errors": {"worker": f"spawn failed: {exc}"}}
    payload: dict[str, Any] = {}
    for line in (stdout or "").splitlines():
        if line.startswith("@@MTAPI_AUDIO_JSON@@"):
            try:
                payload = json.loads(line[len("@@MTAPI_AUDIO_JSON@@"):])
            except Exception as exc:
                return {"ok": False, "error": f"bad worker JSON: {exc}",
                        "opinions": {}, "engines": {}, "errors": {"worker": "bad json"}}
    if not payload:
        return {"ok": False, "error": (stderr or "no worker output")[-300:],
                "opinions": {}, "engines": {}, "errors": {"worker": "no payload"}}
    return payload


def merge_opinions(payloads: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Flatten several worker payloads into one opinion index (later payloads
    never overwrite earlier engines — duplicates are the point)."""
    merged: dict[str, list[dict[str, Any]]] = {}
    for payload in payloads:
        for kind, opinions in (payload.get("opinions") or {}).items():
            for opinion in opinions or []:
                engine = opinion.get("engine")
                if engine in [o.get("engine") for o in merged.setdefault(kind, [])]:
                    continue  # exact duplicate engine+kind → keep one
                merged[kind].append(opinion)
    return merged


def octave_group(bpm: float) -> int:
    """Fold a tempo into 0-11 by octaves — 82 and 165 are the same pulse."""
    if bpm <= 0:
        return 0
    value = float(bpm)
    while value >= 160.0:
        value /= 2.0
    while value < 80.0:
        value *= 2.0
    return int(round(value))


def tempo_consensus_by_vote(tempos: list[dict[str, Any]]) -> dict[str, Any]:
    """Choose a tempo by *majority of engines*, octave-aware.

    The measured failure on the user's own library was a single engine reporting
    exactly double time (166.71 vs 82.99; 162.7 vs 82.03). A fixed preference
    order hides that; a vote across octave-folded groups surfaces the split and
    lets the side with more engines win.
    """
    usable = [o for o in tempos if (o.get("bpm") or 0) > 0
              and TEMPO_MIN_BPM <= float(o["bpm"]) <= TEMPO_MAX_BPM]
    if not usable:
        # Every reading is outside the plausibility band (silent / corrupt /
        # noise-only source): no consensus exists. Surface what was rejected
        # so the row can be flagged instead of storing a junk number.
        rejected = {o.get("engine"): round(float(o["bpm"]), 2)
                    for o in tempos if (o.get("bpm") or 0) > 0}
        return {
            "tempo": None,
            "tempo_implausible": bool(rejected),
            "tempo_rejected": rejected,
        } if rejected else {}
    groups: dict[int, list[dict[str, Any]]] = {}
    for opinion in usable:
        groups.setdefault(octave_group(float(opinion["bpm"])), []).append(opinion)

    def _rank(item):
        key, members = item
        votes = len(members)
        # Majority wins. On a tie, fall back to the group holding the
        # measured-best engine (essentia-degara) rather than an arbitrary tempo
        # preference; then the group whose members agree most tightly.
        has_degara = any(o.get("engine") == "essentia-degara" for o in members)
        spread = max(float(o["bpm"]) for o in members) - min(float(o["bpm"]) for o in members)
        return (votes, has_degara, -spread)

    group_key, members = max(groups.items(), key=_rank)
    members.sort(key=lambda o: o["bpm"])
    # Median of the winning group is more robust than any single member.
    bpms = sorted(float(o["bpm"]) for o in members)
    median = bpms[len(bpms) // 2] if len(bpms) % 2 else (
        (bpms[len(bpms) // 2 - 1] + bpms[len(bpms) // 2]) / 2)

    out: dict[str, Any] = {
        "tempo": round(float(median), 2),
        "tempo_engine": f"vote({len(members)})",
        "tempo_votes": {o["engine"]: round(float(o["bpm"]), 2) for o in members},
    }
    all_bpms = [round(float(o["bpm"]), 2) for o in usable]
    out["tempo_spread_bpm"] = round(max(all_bpms) - min(all_bpms), 2)
    out["tempo_agreeing_engines"] = len(usable)
    out["tempo_octave_group"] = group_key

    # Out-of-band readings that lost their vote slot are still reported — the
    # sidecar keeps them, the DB just never stores them as the tempo.
    rejected = {o.get("engine"): round(float(o["bpm"]), 2) for o in tempos
                if (o.get("bpm") or 0) > 0
                and not (TEMPO_MIN_BPM <= float(o["bpm"]) <= TEMPO_MAX_BPM)}
    if rejected:
        out["tempo_rejected"] = rejected

    # Octave disagreement must be judged on the RAW values, not the folded
    # group — folding is what makes the vote work, and it would hide exactly
    # the 2x disagreement the user needs to see.
    outliers = [
        (o["engine"], round(float(o["bpm"]), 2)) for o in usable
        if median > 0 and (float(o["bpm"]) / median > 1.6 or float(o["bpm"]) / median < 0.62)
    ]
    out["tempo_octave_split"] = bool(outliers)
    if outliers:
        out["tempo_octave_minorities"] = dict(outliers)
        out["tempo_octave_note"] = (
            "one or more engines counted at a different octave (double/half time)")
    return out


def consensus(merged: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Choose the headline values from the opinions — explicitly, and without
    hiding disagreement. Tempo is decided by octave-aware majority vote (see
    `tempo_consensus_by_vote`); `tempo_spread_bpm` surfaces how far apart the
    engines actually are, which is the number the user wants when judging them."""
    out: dict[str, Any] = {}

    keys = merged.get("key") or []
    if keys:
        best = max(keys, key=lambda o: (o.get("confidence") or 0))
        out["key"] = best.get("value")
        out["key_confidence"] = best.get("confidence")
        out["key_engine"] = best.get("engine")

    tempos = merged.get("tempo") or []
    if tempos:
        out.update(tempo_consensus_by_vote(tempos))
        tempos_usable = [o for o in tempos if (o.get("bpm") or 0) > 0]
        by_engine = {o.get("engine"): o for o in tempos_usable}
        degara = by_engine.get("essentia-degara", {}).get("bpm")
        multi = by_engine.get("essentia-multifeature", {}).get("bpm")
        if degara or multi:
            disagreement = (abs(degara - multi) / max(degara, multi)
                            if degara and multi else None)
            out["tempo_alternates"] = {
                "source": out.get("tempo_engine"),
                "bpm_degara": degara,
                "bpm_multifeature": multi,
                "conf_degara": by_engine.get("essentia-degara", {}).get("confidence"),
                "conf_multifeature": by_engine.get("essentia-multifeature", {}).get("confidence"),
                "disagreement": round(disagreement, 4) if disagreement is not None else None,
                "all_engines": {o.get("engine"): o.get("bpm") for o in tempos_usable},
            }
    else:
        out["tempo"] = None
        out["tempo_spread_bpm"] = None

    beat_sets = [o for o in (merged.get("beats") or []) if o.get("count")]
    if beat_sets:
        chosen_beats = max(beat_sets, key=lambda o: o["count"])
        out["beats"] = _clean_times(chosen_beats.get("beats"))
        out["beats_count"] = chosen_beats.get("count")
        out["beats_engine"] = chosen_beats.get("engine")
        out["beat_counts_by_engine"] = {o["engine"]: o["count"] for o in beat_sets}

    onset_sets = [o for o in (merged.get("onsets") or []) if o.get("count")]
    if onset_sets:
        biggest = max(onset_sets, key=lambda o: o["count"])
        out["onsets"] = _clean_times(biggest.get("onsets"))
        out["onset_rate"] = biggest.get("rate")
        out["onset_counts_by_engine"] = {o["engine"]: o["count"] for o in onset_sets}

    midi_ops = merged.get("midi") or []
    for opinion in midi_ops:
        if opinion.get("kind") == "tempo_map" and opinion.get("path"):
            out["midi_path"] = opinion["path"]
        elif opinion.get("kind") == "notes" and opinion.get("path"):
            out["notes_midi_path"] = opinion["path"]
            out["notes_midi_count"] = opinion.get("note_count")
    return out


async def extract_audio_wav(src: Path, dest: Path, guard_sec: int | None = None) -> tuple[bool, str]:
    """Decode any media file's audio track to 44.1 kHz mono wav.

    Returns ``(ok, detail)``. ``detail`` is empty on success, else a short
    reason ("no audio track", ffmpeg stderr tail). When ``guard_sec`` is set,
    only the first N seconds are decoded — the DJ-mix guard from the spec.
    """
    from app.shell import run_command

    argv = [
        "ffmpeg", "-nostdin", "-y", "-loglevel", "error",
        "-i", str(src),
    ]
    if guard_sec:
        argv += ["-t", str(int(guard_sec))]
    argv += ["-vn", "-ac", "1", "-ar", str(ESSENTIA_SAMPLE_RATE), str(dest)]

    code, _out, err = await run_command(argv)
    if code != 0 or not dest.exists() or dest.stat().st_size == 0:
        tail = (err or "").strip().splitlines()
        return False, (tail[-1][:200] if tail else "no audio track")
    return True, ""


def _load_mono44k(wav_path: Path):
    import numpy as np
    import soundfile as sf

    y, sr = sf.read(str(wav_path), dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != ESSENTIA_SAMPLE_RATE:  # defensive: extract already resampled
        n = int(round(len(y) * ESSENTIA_SAMPLE_RATE / sr))
        y = np.interp(np.linspace(0, len(y) - 1, n), np.arange(len(y)), y)
    return np.ascontiguousarray(y, dtype=np.float32)


# Content-class thresholds, measured on fixtures before pinning (see
# tests/test_media_catalog_content.py): digital silence sits far below -60 dBFS
# peak; broadband white noise drives frame spectral flatness (geometric/arithmetic
# power mean ratio) towards ~1 while tonal material stays well under 0.5.
CONTENT_SILENCE_PEAK_DB = -60.0
CONTENT_NOISE_FLATNESS = 0.7
CONTENT_DC_RATIO = 0.5       # |mean| vs |peak|: a DC wall is its own signal


def content_stats(y) -> dict[str, Any]:
    """Cheap numpy-only 'is this even music?' measurements (user ruling:
    silence/noise/corrupt signatures are provable; 'music' as a positive claim
    is not — the classifier says what a file is NOT, never what it is).

    Returns level_db (RMS dBFS), peak_db, flatness (frame spectral
    flatness, median across frames), content_class in
    {'ok', 'silent', 'noise-like', 'dc-offset'}.
    """
    import numpy as np

    out: dict[str, Any] = {}
    if y is None or len(y) == 0:
        return {"level_db": None, "peak_db": None, "flatness": None,
                "content_class": "silent"}
    peak = float(np.max(np.abs(y)))
    rms = float(np.sqrt(np.mean(np.square(y), dtype=np.float64)))
    peak_db = 20.0 * math.log10(peak) if peak > 0 else -200.0
    level_db = 20.0 * math.log10(rms) if rms > 0 else -200.0
    out["peak_db"] = round(peak_db, 2)
    out["level_db"] = round(level_db, 2)

    # Band spectral flatness: the classic SFM (geometric/arithmetic mean) over
    # 32 log-spaced band energies, median across frames. Measured on fixtures:
    # broadband white noise lands near 1, tonal material near 0. (A per-bin
    # ratio is wrong here — Rayleigh amplitudes floor it at e^-γ ≈ 0.56 for
    # ANY signal, measured 0.559 on pure white noise.)
    nfft = 4096
    if len(y) >= nfft:
        frames = len(y) // (nfft // 2) - 1
        idx = np.arange(nfft)[None, :] + (np.arange(frames) * (nfft // 2))[:, None]
        windowed = y[idx] * np.hanning(nfft)[None, :]
        spec = np.abs(np.fft.rfft(windowed, axis=1)) ** 2  # frames × bins
        freqs = np.fft.rfftfreq(nfft, 1.0 / ESSENTIA_SAMPLE_RATE)
        edges = np.geomspace(max(freqs[1], 20.0), freqs[-1], 33)
        bands = np.digitize(freqs, edges)  # bin -> band id 1..32
        # Aggregate across frames BEFORE the band ratio: per-frame ratios are
        # destroyed by the sparse low bands (2–3 bins each — measured white
        # noise at 0.33). A whole-file mean power spectrogram gives every band
        # hundreds of effective samples, so white noise lands near 1.
        energy = np.bincount(bands, weights=spec.mean(axis=0), minlength=33)[1:33]
        counts = np.bincount(bands, minlength=33)[1:33].astype(np.float64)
        keep = counts > 0  # empty log bands (log(ε)) would poison the mean
        energy = (energy[keep] / counts[keep]) + 1e-12
        flatness = float(np.exp(np.mean(np.log(energy))) / np.mean(energy))
    else:
        flatness = 1.0 if peak > 0 else None
    out["flatness"] = round(flatness, 4) if flatness is not None else None

    dc = abs(float(np.mean(y, dtype=np.float64)))
    if peak <= 0 or peak_db < CONTENT_SILENCE_PEAK_DB:
        out["content_class"] = "silent"
    elif dc > CONTENT_DC_RATIO * peak:
        out["content_class"] = "dc-offset"
    elif flatness is not None and flatness >= CONTENT_NOISE_FLATNESS:
        out["content_class"] = "noise-like"
    else:
        out["content_class"] = "ok"
    return out


def _canonical_key(tonic: str, scale: str) -> str:
    """Essentia gives ('C', 'major'); the catalog stores '<Tonic> <mode>'."""
    mode = "minor" if str(scale).lower().startswith("min") else "major"
    tonic = str(tonic).strip()
    return f"{tonic} {mode}"


def analyze_signal(y: Any) -> dict[str, Any]:
    """Key + tempo from a 44.1 kHz mono float array. Raises on engine failure."""
    if not essentia_available():
        raise RuntimeError("essentia is not installed")
    ess = _ess_module

    # ── Key (needs no sample rate; essentia assumes 44100) ──
    key, scale, strength = ess.KeyExtractor()(y)
    key_name = _canonical_key(key, scale)
    try:
        key_strength = float(strength)
    except (TypeError, ValueError):
        key_strength = None

    # ── Tempo: degara for the value, multifeature for confidence ──
    degara = ess.RhythmExtractor2013(method="degara")(y)
    multi = ess.RhythmExtractor2013(method="multifeature")(y)
    bpm_degara, ticks_degara = float(degara[0]), degara[1]
    bpm_multi, ticks_multi, conf_multi = float(multi[0]), multi[1], multi[2]
    try:
        conf_multi = float(str(conf_multi))
    except (TypeError, ValueError):
        conf_multi = 0.0

    # Prefer degara unless the two methods disagree badly (>10%), in which case
    # fall back to multifeature (more robust on rubato/non-dance material).
    disagreement = None
    if bpm_degara > 0 and bpm_multi > 0:
        disagreement = abs(bpm_degara - bpm_multi) / max(bpm_degara, bpm_multi)
    if disagreement is not None and disagreement > 0.10:
        tempo = bpm_multi
        tempo_source = "multifeature"
    else:
        tempo = bpm_degara or bpm_multi
        tempo_source = "degara" if bpm_degara else "multifeature"

    ticks = ticks_degara if (ticks_degara is not None and len(ticks_degara)) else ticks_multi
    tick_list = list(ticks) if (ticks is not None and len(ticks)) else []
    # Plausibility band (§ user ruling 2026-10-07): a reading outside
    # TEMPO_MIN_BPM..TEMPO_MAX_BPM is not a musical tempo — it is what the
    # detectors return for corrupt, silent or noise-only files (measured:
    # degara reported 1.0 BPM on a near-empty test file and that value was
    # stored, then filterable as "1 BPM"). Rejected readings keep the row's
    # tempo at NULL and set the implausible flag; the raw numbers survive in
    # tempo_alternates / the sidecar (nothing is deleted).
    implausible = tempo is not None and not (TEMPO_MIN_BPM <= float(tempo) <= TEMPO_MAX_BPM)
    return {
        "key_name": key_name,
        "key_strength": key_strength,
        "tempo": None if implausible else (round(float(tempo), 2) if tempo else None),
        "tempo_implausible": bool(implausible),
        "tempo_conf": round(min(1.0, max(0.0, conf_multi)), 4),
        "ticks": [round(float(t), 4) for t in tick_list],
        "tempo_alternates": {
            "source": tempo_source,
            "bpm_degara": round(bpm_degara, 2) if bpm_degara else None,
            "bpm_multifeature": round(bpm_multi, 2) if bpm_multi else None,
            "conf_multifeature": round(conf_multi, 4),
            "conf_degara": round(float(degara[2]), 4),
            "disagreement": round(disagreement, 4) if disagreement is not None else None,
        },
        "engines": {"key": "essentia-KeyExtractor", "tempo": f"essentia-RhythmExtractor2013/{tempo_source}"},
    }


def analyze_beats_and_onsets(y: Any) -> dict[str, Any]:
    """Beat grid + onsets from a 44.1 kHz mono float array.

    Engine note (measured on this box, Slice 4): Essentia already ships
    ``BeatTrackerMultiFeature`` and ``OnsetRate``, so no extra dependency is
    needed. The spec's madmom/aubio pair was dropped because madmom cannot even
    build here (undeclared Cython build dep) and its numpy<2 pin would fight the
    installed numpy 2.4.6, while aubio would duplicate what Essentia provides.

    Time signature: this Essentia wheel has no ``LoudnessBandRatio``, so its
    ``Meter`` (which needs a band-ratio beatogram) is unavailable — meter is
    therefore **assumed 4/4** and flagged ``meter_assumed`` rather than guessed
    silently. Downbeat phase is picked from the onset-density profile, which is
    honest heuristic work, not detection.
    """
    if not essentia_available():
        raise RuntimeError("essentia is not installed")
    ess = _ess_module

    beats, beat_conf = ess.BeatTrackerMultiFeature()(y)
    beats = [round(float(b), 4) for b in (beats if beats is not None else [])]
    try:
        beat_conf = float(beat_conf)
    except (TypeError, ValueError):
        beat_conf = 0.0

    onsets, onset_rate = ess.OnsetRate()(y)
    onsets = [round(float(o), 4) for o in (onsets if onsets is not None else [])]
    try:
        onset_rate = float(onset_rate)
    except (TypeError, ValueError):
        onset_rate = 0.0

    # Downbeat phase: the 4-offset whose beats collect the most onsets.
    beats_per_bar = 4
    downbeat_index = 0
    if beats and onsets:
        best, best_score = 0, -1.0
        for phase in range(beats_per_bar):
            score = 0.0
            for idx in range(phase, len(beats), beats_per_bar):
                window = 0.12  # generous: a downbeat usually has an onset on it
                score += sum(1 for o in onsets if abs(o - beats[idx]) <= window)
            if score > best_score:
                best, best_score = phase, score
        downbeat_index = best

    downbeats = beats[downbeat_index::beats_per_bar] if beats else []
    intervals = [round(beats[i + 1] - beats[i], 4) for i in range(len(beats) - 1)]
    return {
        "beats": beats,
        "beats_count": len(beats),
        "beat_confidence": round(min(1.0, max(0.0, beat_conf / 5.32)), 4),
        "beat_intervals_median": (
            round(sorted(intervals)[len(intervals) // 2], 4) if intervals else None
        ),
        "downbeats": downbeats,
        "downbeat_index": downbeat_index,
        "time_signature": "4/4",
        "meter_assumed": True,
        "onsets": onsets,
        "onset_rate": round(onset_rate, 3),
        "engines": {"beats": "essentia-BeatTrackerMultiFeature", "onsets": "essentia-OnsetRate"},
    }


def write_tempo_map_midi(dest: Path, *, tempo: float | None, beats: list[float] | None = None,
                         downbeats: list[float] | None = None) -> bool:
    """Write a tempo-map + marker MIDI (finishes the scaffold's `_write_midi_sidecar`).

    One note per beat, a downbeat marker via the tempo/meta track, and an end
    marker. This is deliberately *not* note transcription — a real audio→notes
    MIDI needs a neural transcriber (Basic Pitch), which cannot be installed here
    (see Slice 4 notes); a wrong note grid is worse than an honest tempo map.
    Returns False when mido is unavailable so callers can say so.
    """
    try:
        import mido
    except Exception:
        return False

    ticks_per_beat = 480
    bpm = float(tempo) if tempo and float(tempo) > 0 else 120.0
    microseconds_per_beat = int(round(60_000_000 / bpm))
    mid = mido.MidiFile(ticks_per_beat=ticks_per_beat)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=microseconds_per_beat, time=0))
    track.append(mido.MetaMessage("track_name", name="mtapi tempo map", time=0))

    beat_list = list(beats or [])
    downbeat_set = set(round(float(d), 4) for d in (downbeats or []))

    def ticks(seconds: float, prev: float) -> int:
        delta = max(0.0, float(seconds) - prev)
        return int(round((delta / 60.0) * bpm * ticks_per_beat))

    prev = 0.0
    for beat in beat_list:
        delta_ticks = ticks(beat, prev)
        prev = beat
        # Note on/off for a short blip so DAWs show a visible pulse.
        track.append(mido.Message("note_on", note=60 if round(beat, 4) in downbeat_set else 72,
                                  velocity=100 if round(beat, 4) in downbeat_set else 64,
                                  time=delta_ticks))
        track.append(mido.Message("note_off", note=60 if round(beat, 4) in downbeat_set else 72,
                                  velocity=0, time=int(ticks_per_beat * 0.25)))
    track.append(mido.MetaMessage("end_of_track", time=0))
    dest.parent.mkdir(parents=True, exist_ok=True)
    mid.save(str(dest))
    return True


def analyze_wav(wav_path: Path, *, want_key: bool = True, want_tempo: bool = True,
                want_beats: bool = False, want_midi: bool = False,
                midi_dest: Path | None = None) -> dict[str, Any]:
    """Run the selected analyses over a 44.1 kHz wav. Always returns a dict."""
    y = _load_mono44k(wav_path)
    out: dict[str, Any] = {"duration": round(len(y) / float(ESSENTIA_SAMPLE_RATE), 3)}
    # Content class runs on every analysis pass, regardless of which engines
    # are wanted — it is numpy-cheap and is the "is this even music" surface.
    out.update(content_stats(y))
    engines: dict[str, Any] = {}
    if want_key or want_tempo:
        feats = analyze_signal(y)
        if want_key:
            out["key"] = feats["key_name"]
            out["key_strength"] = feats["key_strength"]
        if want_tempo:
            out["tempo"] = feats["tempo"]
            out["tempo_conf"] = feats["tempo_conf"]
            out["beats"] = feats["ticks"]
            out["tempo_alternates"] = feats["tempo_alternates"]
        engines.update(feats["engines"])
    if want_beats:
        grid = analyze_beats_and_onsets(y)
        # The tempo-extracted ticks and the beat tracker's grid are different
        # measurements; keep the beat tracker's as authoritative when asked for.
        out["beats"] = grid["beats"]
        out["beats_count"] = grid["beats_count"]
        out["beat_confidence"] = grid["beat_confidence"]
        out["beat_intervals_median"] = grid["beat_intervals_median"]
        out["downbeats"] = grid["downbeats"]
        out["downbeat_index"] = grid["downbeat_index"]
        out["time_signature"] = grid["time_signature"]
        out["meter_assumed"] = grid["meter_assumed"]
        out["onsets"] = grid["onsets"]
        out["onset_rate"] = grid["onset_rate"]
        engines.update(grid["engines"])
    if want_midi and midi_dest is not None:
        ok = write_tempo_map_midi(
            midi_dest,
            tempo=out.get("tempo"),
            beats=out.get("beats") or [],
            downbeats=out.get("downbeats") or [],
        )
        out["midi_written"] = bool(ok)
        if ok:
            out["midi_path"] = str(midi_dest)
            engines["midi"] = "mido-tempo-map"
        else:
            out["midi_error"] = "mido is not installed"
    if engines:
        out["engines"] = {**(out.get("engines") or {}), **engines}
    return out


class AudioScanner:
    """Directory walker + analysis driver used by the ``media_catalog_scan`` op."""

    def __init__(self, target_dir: str, *, owned_dirs: list[str] | None = None,
                 audio_types: set[str] | None = None, is_video_fn=None, is_image_fn=None):
        self.target_dir = str(target_dir)
        self.owned_dirs = list(owned_dirs or [])
        self.audio_types = audio_types or set(audio_db.AUDIO_EXTENSIONS)
        self.is_video_fn = is_video_fn
        self.is_image_fn = is_image_fn
        self.audio_db = audio_db

    # ── discovery ───────────────────────────────────────────────────────
    def iter_media_files(self, recursive: bool = True) -> Iterator[Path]:
        root = Path(self.target_dir)
        if not root.is_dir():
            return
        for dirpath, dirnames, filenames in os.walk(root):
            if not recursive:
                dirnames[:] = []
            for name in sorted(filenames):
                ext = Path(name).suffix.lower()
                if ext in self.audio_types:
                    yield Path(dirpath) / name
                    continue
                p = Path(dirpath) / name
                if self.is_video_fn is not None and self.is_video_fn(p):
                    yield p
                elif self.is_image_fn is not None and self.is_image_fn(p):
                    yield p

    # ── per-file work ───────────────────────────────────────────────────
    def index_file(self, path: Path, status: str = "scanned") -> dict[str, Any]:
        return self.audio_db.catalog_upsert(
            str(path),
            origin="import",
            owned_dirs=self.owned_dirs,
            status=status,
            is_video_fn=self.is_video_fn,
            is_image_fn=self.is_image_fn,
        )

    async def extract_tags(self, path: Path) -> dict[str, Any]:
        """Read embedded tags/headers for one file and store them.

        Always worth doing — ffprobe is ~50 ms and DJ libraries carry the key,
        BPM and Camelot the owner typed in. Tracker headers are parsed here
        because ffprobe cannot read those formats at all.
        """
        tracker = parse_tracker_header(path)
        ff_norm, ff_raw = await read_ffprobe_tags(path)
        tags = build_tags(ff_norm, ff_raw, tracker)
        if tags:
            self.audio_db.save_tags(str(path), tags)
        return tags

    def needs_analysis(self, path: Path) -> bool:
        """Hash-dedup: skip analysis when an already-analysed row matches."""
        row = self.audio_db.get_row(str(path))
        if row is None:
            return True
        file_hash = self.audio_db.quick_hash(str(path))
        if not file_hash or not row.get("file_hash"):
            return True
        if row.get("file_hash") != file_hash:
            return True  # file changed since last scan
        return row.get("status") not in ("scanned", "analyzed")

    async def analyze_file(self, path: Path, *, want_key: bool, want_tempo: bool,
                           want_beats: bool, want_midi: bool,
                           guard_sec: int | None,
                           include_legacy: bool = True) -> tuple[bool, dict[str, Any]]:
        """Extract → analyse → persist analysis columns + sidecars."""
        with tempfile.TemporaryDirectory(prefix="mtapi_catalog_") as tmpdir:
            wav = Path(tmpdir) / "probe.wav"
            ok, reason = await extract_audio_wav(path, wav, guard_sec)
            if not ok:
                # A video with no audio track is NOT an error row (spec §13).
                return False, {"skipped": reason}
            midi_prefix = str(Path(tmpdir) / "sidecar") if want_midi else None
            worker_payloads: list[dict[str, Any]] = []
            worker_errors: dict[str, Any] = {}
            availability = worker_availability()
            want_set = {"key" if want_key else "",
                        "tempo" if want_tempo else "",
                        "beats" if want_beats else "",
                        "onsets" if want_beats else "",
                        "notes" if want_midi else ""}
            want_set.discard("")
            plan = [("modern", MODERN_ENGINES_EXTRA if include_legacy else MODERN_ENGINES)]
            if include_legacy:
                plan.append(("legacy", LEGACY_ENGINES))
            for label, engines in plan:
                if not availability[label]["available"]:
                    continue
                result = await run_worker(
                    availability[label]["venv"], wav,
                    want=want_set, engines=engines,
                    midi_prefix=(f"{midi_prefix}.tempo" if midi_prefix else None),
                )
                if result.get("opinions"):
                    worker_payloads.append(result)
                else:
                    worker_errors[label] = result.get("error") or result.get("errors")

            if worker_payloads:
                merged = merge_opinions(worker_payloads)
                feats = consensus(merged)
                feats["opinions"] = merged
                feats["worker_errors"] = worker_errors
                # Content class runs on the app side for BOTH paths — numpy on
                # the same decoded wav, so the classification never depends on
                # which engine venvs happen to be installed.
                feats.update(content_stats(_load_mono44k(wav)))
                feats["worker_pythons"] = {
                    label: availability[label]["python"] for label in availability
                    if availability[label]["available"]
                }
                feats["duration"] = worker_payloads[0].get("duration")
                # Downbeat phase + assumed meter, derived from whichever grid won.
                if feats.get("beats"):
                    phase, downbeats = derive_downbeats(feats["beats"], feats.get("onsets"))
                    feats["downbeat_index"] = phase
                    feats["downbeats"] = downbeats
                    feats["time_signature"] = "4/4"
                    feats["meter_assumed"] = True
                intervals = [feats["beats"][i + 1] - feats["beats"][i]
                             for i in range(len(feats.get("beats") or []) - 1)]
                feats["beat_intervals_median"] = (
                    sorted(intervals)[len(intervals) // 2] if intervals else None)
                feats["engines"] = {
                    engine: ok
                    for payload in worker_payloads
                    for engine, ok in (payload.get("engines") or {}).items()
                }
                # Move the worker's temp MIDI files to canonical siblings:
                # <media>.mid (tempo map) and <media>.notes.mid (transcription).
                if feats.get("midi_path"):
                    canonical = f"{path}.mid"
                    try:
                        if feats["midi_path"] != canonical:
                            Path(feats["midi_path"]).replace(canonical)
                        feats["midi_path"] = canonical
                    except OSError:
                        feats["midi_path"] = None
                if feats.get("notes_midi_path"):
                    canonical_notes = f"{path}.notes.mid"
                    try:
                        if feats["notes_midi_path"] != canonical_notes:
                            Path(feats["notes_midi_path"]).replace(canonical_notes)
                        feats["notes_midi_path"] = canonical_notes
                    except OSError:
                        feats["notes_midi_path"] = None
            else:
                # No worker available — keep the single-venv path working rather
                # than refusing outright (Slice 3 behaviour).
                feats = analyze_wav(wav, want_key=want_key, want_tempo=want_tempo,
                                    want_beats=want_beats, want_midi=want_midi,
                                    midi_dest=midi_dest)
                feats["worker_errors"] = worker_errors or {"all": "no worker venv available"}
                feats["opinions"] = {}

        sidecar = Path(f"{path}.json")
        payload = {
            "path": str(path),
            "file_hash": self.audio_db.quick_hash(str(path)),
            **{k: v for k, v in feats.items() if k != "tempo_alternates"},
        }
        existing_meta: dict[str, Any] = {}
        if sidecar.exists():
            try:
                loaded = json.loads(sidecar.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    existing_meta = loaded.get("raw_metadata") or {}
            except Exception:
                existing_meta = {}
        payload["tempo_alternates"] = feats.get("tempo_alternates")
        for key in ("downbeats", "downbeat_index", "time_signature", "meter_assumed",
                    "beat_confidence", "onsets", "onset_rate", "midi_path", "midi_kind",
                    "notes_midi_path", "notes_midi_count", "tempo_spread_bpm",
                    "tempo_agreeing_engines", "tempo_engine", "key_engine", "beats_engine",
                    "beat_counts_by_engine", "onset_counts_by_engine", "worker_pythons",
                    "tempo_implausible", "tempo_rejected", "content_class",
                    "level_db", "peak_db", "flatness"):
            if feats.get(key) is not None:
                payload[key] = feats[key]
        if feats.get("midi_path"):
            payload["midi_note"] = "tempo map + beat blips (NOT note transcription)"
        if feats.get("notes_midi_path"):
            payload["notes_midi_note"] = (
                f"Basic Pitch note transcription — {feats.get('notes_midi_count')} notes")
        if feats.get("opinions"):
            payload["engine_opinions"] = _trim_opinions(feats["opinions"], limit=128)
        if existing_meta:
            payload["raw_metadata"] = existing_meta

        row = self.audio_db.get_row(str(path))
        provenance: dict[str, Any] = {}
        if row:
            for key in ("is_mine", "made_by_me", "ai_involved"):
                if row.get(key) is not None:
                    provenance[key] = bool(row[key])  # sidecar JSON wants booleans, not 0/1
            for key in ("origin", "mine_source"):
                if row.get(key):
                    provenance[key] = row[key]
        payload.update(provenance)
        sidecar.write_text(json.dumps(payload, indent=2), encoding="utf-8")

        with self.audio_db.get_db() as db:
            db.execute(
                """
                UPDATE media SET
                    status = ?, tempo = ?, tempo_conf = ?, key_name = ?,
                    key_strength = ?, duration = ?, sidecar_json_path = ?,
                    midi_path = ?, raw_metadata = ?,
                    tempo_detected = ?, key_detected = ?, updated_at = ?,
                    tempo_implausible = ?, level_db = ?, peak_db = ?,
                    flatness = ?, content_class = ?
                WHERE path = ?
                """,
                (
                    "analyzed",
                    feats.get("tempo"),
                    feats.get("tempo_conf"),
                    feats.get("key"),
                    feats.get("key_strength"),
                    _duration_from_wav_payload(feats),
                    str(sidecar),
                    feats.get("midi_path"),
                    json.dumps({
                        "tempo_alternates": feats.get("tempo_alternates"),
                        "tempo_rejected": feats.get("tempo_rejected"),
                        "beats": feats.get("beats"),
                        "downbeats": feats.get("downbeats"),
                        "downbeat_index": feats.get("downbeat_index"),
                        "time_signature": feats.get("time_signature"),
                        "meter_assumed": feats.get("meter_assumed"),
                        "beat_confidence": feats.get("beat_confidence"),
                        "onsets": feats.get("onsets"),
                        "onset_rate": feats.get("onset_rate"),
                        "midi_kind": ("tempo_map" if feats.get("midi_path") else None),
                        "opinions": _trim_opinions(feats.get("opinions")),
                        "tempo_spread_bpm": feats.get("tempo_spread_bpm"),
                        "tempo_agreeing_engines": feats.get("tempo_agreeing_engines"),
                        "tempo_engine": feats.get("tempo_engine"),
                        "key_engine": feats.get("key_engine"),
                        "beats_engine": feats.get("beats_engine"),
                        "beat_counts_by_engine": feats.get("beat_counts_by_engine"),
                        "onset_counts_by_engine": feats.get("onset_counts_by_engine"),
                        "notes_midi_path": feats.get("notes_midi_path"),
                        "notes_midi_count": feats.get("notes_midi_count"),
                        "beat_intervals_median": feats.get("beat_intervals_median"),
                        "worker_pythons": feats.get("worker_pythons"),
                        "worker_errors": feats.get("worker_errors"),
                    }),
                    # The detection is kept forever; the effective tempo/key_name
                    # may later be overridden by the owner's tag (§19).
                    feats.get("tempo"),
                    feats.get("key"),
                    _now(),
                    1 if feats.get("tempo_implausible") else 0,
                    feats.get("level_db"),
                    feats.get("peak_db"),
                    feats.get("flatness"),
                    feats.get("content_class"),
                    str(path),
                ),
            )
        return True, feats

    def record_tag_comparison(self, path: Path, comparison: dict[str, Any]) -> None:
        """Merge the detected-vs-tagged comparison into raw_metadata so the
        disagreement is queryable and visible, not buried in a sidecar."""
        import json as _json
        abs_path = str(path)
        with self.audio_db.get_db() as db:
            row = db.execute("SELECT raw_metadata FROM media WHERE path = ?",
                             (abs_path,)).fetchone()
            raw: dict = {}
            if row and row["raw_metadata"]:
                try:
                    loaded = _json.loads(row["raw_metadata"])
                    if isinstance(loaded, dict):
                        raw = loaded
                except Exception:
                    raw = {}
            raw.update(comparison)
            db.execute("UPDATE media SET raw_metadata = ?, updated_at = ? WHERE path = ?",
                       (_json.dumps(raw, default=str), _now(), abs_path))

    def mark_error(self, path: Path, reason: str) -> None:
        with self.audio_db.get_db() as db:
            db.execute(
                "UPDATE media SET status = 'error', updated_at = ? WHERE path = ?",
                (_now(), str(path)),
            )
        import logging
        logging.getLogger("mtapi.catalog_scan").warning("scan failed %s: %s", path, reason)


def derive_downbeats(beats: list[float], onsets: list[float] | None,
                     beats_per_bar: int = 4) -> tuple[int, list[float]]:
    """Pick the downbeat phase from onset density (engine-independent).

    Which beat is beat 1 depends on the recording, not the tracker, so this is
    applied to whichever engine's grid won. Meter is *assumed* 4/4 (see §7) and
    flagged as such by the caller.
    """
    beats = beats or []
    onsets = onsets or []
    if not beats:
        return 0, []
    if not onsets:
        return 0, beats[::beats_per_bar]
    best, best_score = 0, -1.0
    for phase in range(beats_per_bar):
        score = 0.0
        for idx in range(phase, len(beats), beats_per_bar):
            score += sum(1 for o in onsets if abs(o - beats[idx]) <= 0.12)
        if score > best_score:
            best, best_score = phase, score
    return best, beats[best::beats_per_bar]


def _trim_opinions(opinions: dict | None, limit: int = 64) -> dict:
    """Store the opinions themselves but cap each tick/onset array — the DB is
    for querying, and the sidecar can keep the full arrays."""
    if not isinstance(opinions, dict):
        return {}
    out: dict = {}
    for kind, items in opinions.items():
        if not isinstance(items, list):
            continue
        trimmed = []
        for item in items:
            if not isinstance(item, dict):
                continue
            copy = dict(item)
            for key in ("ticks", "beats", "onsets"):
                if isinstance(copy.get(key), list):
                    copy[key] = copy[key][:limit]
                    copy[f"{key}_count"] = len(copy[key])
            trimmed.append(copy)
        out[kind] = trimmed
    return out


def _now() -> str:
    from datetime import datetime
    return datetime.now().isoformat()


def _duration_from_wav_payload(feats: dict[str, Any]) -> float | None:
    dur = feats.get("duration")
    return round(float(dur), 3) if isinstance(dur, (int, float)) else None