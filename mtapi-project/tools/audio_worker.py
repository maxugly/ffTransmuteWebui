#!/usr/bin/env python
"""Isolated audio-analysis worker (Media Catalog Slice 7).

Runs inside a *separate* venv from the app so analysis libraries can pin old
numpy / old TensorFlow without touching the OpenVINO + torch + TF 2.21 stack the
app depends on. Two venvs exist (see docs/media-catalog-spec.md \u00a717):

  .venv-audio           py3.11, numpy 1.26 \u2014 essentia, librosa, basic-pitch (TF 2.15), mido
  .venv-audio-legacy    py3.9,  numpy 1.20 \u2014 madmom

The script imports **nothing from the app** (no ``app.*`` at all) so it can run
under any interpreter, including a Python that predates the app's own syntax
features. Contract: write one JSON object to stdout, tagged with a sentinel line
so engine chatter cannot corrupt it; exit non-zero only for usage errors.

The whole point of this worker is *disagreement*: every engine reports its own
opinion and nothing is averaged away. The caller decides what to believe.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

SENTINEL = "@@MTAPI_AUDIO_JSON@@"
SAMPLE_RATE = 44100


def _load_mono(path):
    import numpy as np
    import soundfile as sf

    y, sr = sf.read(path, dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != SAMPLE_RATE:
        n = int(round(len(y) * SAMPLE_RATE / sr))
        y = np.interp(np.linspace(0, len(y) - 1, n), np.arange(len(y)), y)
    return np.ascontiguousarray(y, dtype="float32")


def _clean_times(values) -> list[float]:
    """numpy arrays are truthy-ambiguous — never use `or []` on them."""
    if values is None:
        return []
    try:
        if len(values) == 0:
            return []
    except TypeError:
        return []
    return [round(float(v), 4) for v in values]


def _essentia(want: set[str], out: dict) -> None:
    """Key, two tempo opinions, beat grid, onsets."""
    import essentia.standard as ess  # noqa: PLC0415

    y = _essentia_signal["y"]
    if "key" in want:
        key, scale, strength = ess.KeyExtractor()(y)
        mode = "minor" if str(scale).lower().startswith("min") else "major"
        out["opinions"].setdefault("key", []).append({
            "engine": "essentia-key",
            "value": f"{key} {mode}",
            "confidence": round(float(strength), 4),
        })
    if "tempo" in want:
        for method in ("degara", "multifeature"):
            result = ess.RhythmExtractor2013(method=method)(y)
            out["opinions"].setdefault("tempo", []).append({
                "engine": f"essentia-{method}",
                "bpm": round(float(result[0]), 2),
                "confidence": round(float(result[2]), 4),
                "ticks": _clean_times(result[1]),
            })
    if "beats" in want:
        beats, conf = ess.BeatTrackerMultiFeature()(y)
        beat_list = [round(float(b), 4) for b in (beats if beats is not None else [])]
        intervals = [round(beat_list[i + 1] - beat_list[i], 4)
                     for i in range(len(beat_list) - 1)]
        out["opinions"].setdefault("beats", []).append({
            "engine": "essentia-beats",
            "count": len(beat_list),
            "median_interval": (sorted(intervals)[len(intervals) // 2]
                                if intervals else None),
            "confidence": round(min(1.0, max(0.0, float(conf) / 5.32)), 4),
            "beats": beat_list,
        })
        onsets, rate = ess.OnsetRate()(y)
        onset_list = [round(float(o), 4) for o in (onsets if onsets is not None else [])]
        out["opinions"].setdefault("onsets", []).append({
            "engine": "essentia-onsets",
            "count": len(onset_list),
            "rate": round(float(rate), 3),
            "onsets": onset_list,
        })


def _librosa(want: set[str], out: dict) -> None:
    """An independent tempo + beat + onset opinion (very different algorithm)."""
    import librosa  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    y = _essentia_signal["y"]
    if "tempo" in want or "beats" in want:
        tempo, beats = librosa.beat.beat_track(y=y, sr=SAMPLE_RATE)
        tempo = float(np.atleast_1d(tempo)[0]) if np.size(tempo) else 0.0
        if "tempo" in want:
            out["opinions"].setdefault("tempo", []).append({
                "engine": "librosa-beat_track", "bpm": round(tempo, 2),
            })
        if "beats" in want:
            beat_list = [round(float(b), 4) for b in np.atleast_1d(beats)]
            out["opinions"].setdefault("beats", []).append({
                "engine": "librosa-beats", "count": len(beat_list), "beats": beat_list,
            })
    if "onsets" in want:
        frames = librosa.onset.onset_detect(y=y, sr=SAMPLE_RATE)
        times = librosa.frames_to_time(frames, sr=SAMPLE_RATE)
        out["opinions"].setdefault("onsets", []).append({
            "engine": "librosa-onsets",
            "count": int(len(times)),
            "onsets": [round(float(t), 4) for t in times],
        })


def _madmom(want: set[str], out: dict) -> None:
    """Legacy-venv beat tracker + tempo histogram (a third tempo opinion)."""
    import numpy as np  # noqa: PLC0415
    import madmom.audio.signal as signal  # noqa: PLC0415
    from madmom.features.beats import DBNBeatTrackingProcessor, RNNBeatProcessor  # noqa: PLC0415

    wav = _essentia_signal["path"]
    if "beats" in want:
        act = RNNBeatProcessor()(signal.Signal(wav))
        beats = DBNBeatTrackingProcessor(fps=100)(act)
        beat_list = [round(float(b), 4) for b in np.atleast_1d(beats)]
        out["opinions"].setdefault("beats", []).append({
            "engine": "madmom-dbn", "count": len(beat_list), "beats": beat_list,
        })
    if "tempo" in want:
        from madmom.features.tempo import DBNTempoHistogramProcessor  # noqa: PLC0415
        act = RNNBeatProcessor()(signal.Signal(wav))
        try:
            tempi = DBNTempoHistogramProcessor(min_tempo=30, max_tempo=300, fps=100)(act)
            if hasattr(tempi, "item"):
                tempi = tempi.item()
            tempi = np.asarray(tempi, dtype=float)
            bpm = float(np.atleast_2d(tempi)[0][0]) if tempi.size else 0.0
        except Exception as exc:  # histogram shape varies by version
            raise RuntimeError(f"madmom tempo histogram failed: {exc}") from exc
        out["opinions"].setdefault("tempo", []).append({
            "engine": "madmom-dbn-histogram", "bpm": round(bpm, 2),
        })


def _midi(want: set[str], out: dict, opts) -> None:
    """Two MIDI kinds: mido tempo map + Basic Pitch note transcription."""
    import mido  # noqa: PLC0415

    tempo = None
    for opinion in out["opinions"].get("tempo", []):
        bpm = opinion.get("bpm") or 0
        if bpm > 0:
            tempo = bpm
            break
    beats: list[float] = []
    for opinion in out["opinions"].get("beats", []):
        if opinion.get("beats"):
            beats = opinion["beats"]
            break

    if opts.midi_out:
        dest = f"{opts.midi_out}.tempo.mid"
        mid = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        mid.tracks.append(track)
        bpm = float(tempo or 120.0)
        track.append(mido.MetaMessage("set_tempo", tempo=int(round(60_000_000 / bpm)), time=0))
        track.append(mido.MetaMessage("track_name", name="mtapi tempo map", time=0))
        prev = 0.0
        for i, beat in enumerate(beats):
            delta = max(0.0, float(beat) - prev)
            prev = float(beat)
            note = 60 if i % 4 == 0 else 72
            track.append(mido.Message("note_on", note=note,
                                      velocity=100 if i % 4 == 0 else 64,
                                      time=int(round((delta / 60.0) * bpm * 480))))
            track.append(mido.Message("note_off", note=note, velocity=0, time=120))
        track.append(mido.MetaMessage("end_of_track", time=0))
        mid.save(dest)
        out["opinions"].setdefault("midi", []).append({
            "engine": "mido-tempo-map", "path": dest, "kind": "tempo_map",
            "tempo_bpm": round(bpm, 2), "beat_blips": len(beats),
        })

    if "notes" in want:
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
        import tempfile  # noqa: PLC0415
        from basic_pitch.inference import ICASSP_2022_MODEL_PATH, predict_and_save  # noqa: PLC0415

        tmp = tempfile.mkdtemp(prefix="mtapi_bp_")
        predict_and_save(
            audio_path_list=[_essentia_signal["path"]],
            output_directory=tmp, save_midi=True, sonify_midi=False,
            save_model_outputs=False, save_notes=False,
            model_or_model_path=ICASSP_2022_MODEL_PATH,
        )
        produced = [f for f in os.listdir(tmp) if f.endswith(".mid")]
        if produced:
            dest = f"{opts.midi_out}.notes.mid" if opts.midi_out else os.path.join(tmp, produced[0])
            os.replace(os.path.join(tmp, produced[0]), dest)
            note_count = 0
            try:
                parsed = mido.MidiFile(dest)
                note_count = sum(1 for track in parsed.tracks for msg in track
                                 if msg.type == "note_on" and msg.velocity > 0)
            except Exception:
                pass
            out["opinions"].setdefault("midi", []).append({
                "engine": "basic-pitch", "path": dest, "kind": "notes",
                "note_count": note_count,
            })


ENGINES = {
    "essentia": _essentia,
    "librosa": _librosa,
    "madmom": _madmom,
}

_essentia_signal: dict = {}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Isolated audio analysis worker")
    parser.add_argument("--wav", required=True, help="44.1 kHz wav to analyse")
    parser.add_argument("--want", default="key,tempo,beats,onsets",
                        help="comma list: key,tempo,beats,onsets,notes")
    parser.add_argument("--engines", default="essentia,librosa,madmom",
                        help="comma list of engines to attempt")
    parser.add_argument("--midi-out", default=None,
                        help="path prefix for MIDI sidecars (<prefix>.tempo.mid)")
    opts = parser.parse_args(argv)

    want = {w.strip() for w in opts.want.split(",") if w.strip()}
    requested = [e.strip() for e in opts.engines.split(",") if e.strip()]

    out: dict = {
        "ok": True,
        "wav": opts.wav,
        "python": ".".join(str(v) for v in sys.version_info[:3]),
        "executable": sys.executable,
        "engines": {},
        "opinions": {},
        "errors": {},
    }

    global _essentia_signal
    _essentia_signal = {"y": None, "path": opts.wav}

    for engine in requested:
        try:
            if engine == "midi":
                _midi(want, out, opts)
                out["engines"]["midi"] = True
                continue
            handler = ENGINES.get(engine)
            if handler is None:
                out["errors"][engine] = "unknown engine"
                continue
            # Essentia needs the signal array; load it once, lazily.
            if engine == "essentia":
                _essentia_signal["y"] = _load_mono(opts.wav)
                _essentia_signal["path"] = opts.wav
            elif engine == "librosa" and _essentia_signal.get("y") is None:
                _essentia_signal["y"] = _load_mono(opts.wav)
            handler(want, out)
            out["engines"][engine] = True
        except Exception as exc:
            out["engines"][engine] = False
            out["errors"][engine] = f"{type(exc).__name__}: {exc}"

    if _essentia_signal.get("y") is not None:
        try:
            out["duration"] = round(len(_essentia_signal["y"]) / float(SAMPLE_RATE), 3)
        except Exception:
            pass

    sys.stdout.write(SENTINEL + json.dumps(out) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())