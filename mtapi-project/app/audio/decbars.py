"""DECbars audio engine: word synthesis with espeak-ng, silence trimming, and audio mixdown."""
from __future__ import annotations

import asyncio
import math
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from .. import shell
from .export import FORMATS, convert_audio

ROOT = Path(__file__).resolve().parents[2]
DECBARS_JUNK = ROOT / "junk" / "decbars"
SAMPLES_DIR = DECBARS_JUNK / "samples"


def ensure_dirs():
    DECBARS_JUNK.mkdir(parents=True, exist_ok=True)
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)


def tokenize_lyrics(text: str) -> list[str]:
    """Split lyrics into word tokens while filtering out pure whitespace/punctuation."""
    raw_tokens = re.findall(r"[A-Za-z0-9\']+", text)
    return [t for t in raw_tokens if t.strip()]


async def synthesize_word(
    word: str,
    voice: str = "en",
    speed: int = 160,
    pitch: int = 50,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Synthesize a single word with espeak-ng, trim leading/trailing silence, and measure duration."""
    ensure_dirs()
    sid = session_id or uuid.uuid4().hex[:12]
    out_dir = SAMPLES_DIR / sid
    out_dir.mkdir(parents=True, exist_ok=True)

    uid = uuid.uuid4().hex[:8]
    safe_word = re.sub(r"[^A-Za-z0-9]", "_", word)[:20] or "word"
    raw_path = out_dir / f"raw_{uid}_{safe_word}.wav"
    clean_path = out_dir / f"clean_{uid}_{safe_word}.wav"

    # Invariant 2: shell.run_command + argv lists. NEVER shell=True.
    if voice.lower().startswith("dectalk"):
        say_bin = shutil.which("dectalk-say") or "/home/m/.local/share/dectalk/say"
        cmd = [
            str(say_bin),
            "-fo", str(raw_path.resolve()),
            "-a", f"[:np] {word}",
        ]
        code, _stdout, stderr = await shell.run_command(cmd)
        if code != 0 or not raw_path.exists():
            raise RuntimeError(f"DECtalk synthesis failed: {stderr or 'unknown error'}")
    else:
        cmd = [
            "espeak-ng",
            "-v", voice,
            "-s", str(int(speed)),
            "-p", str(int(pitch)),
            "-w", str(raw_path.resolve()),
            word,
        ]
        code, _stdout, stderr = await shell.run_command(cmd)
        if code != 0 or not raw_path.exists():
            # Fallback to plain espeak if espeak-ng failed or was absent
            cmd[0] = "espeak"
            code, _stdout, stderr = await shell.run_command(cmd)
            if code != 0 or not raw_path.exists():
                raise RuntimeError(f"espeak synthesis failed: {stderr or 'unknown error'}")

    # Trim silence and apply 10ms micro fade in/out using soundfile + numpy
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(str(raw_path))
    if data.ndim > 1:
        data = data.mean(axis=1)

    # Threshold for silence: peak-relative or absolute threshold
    peak = np.max(np.abs(data)) if len(data) > 0 else 0
    if peak > 0:
        thresh = max(0.01 * peak, 0.005)
        non_silent = np.where(np.abs(data) > thresh)[0]
        if len(non_silent) > 0:
            start_idx = max(0, non_silent[0] - int(0.01 * sr))
            end_idx = min(len(data), non_silent[-1] + int(0.01 * sr))
            data = data[start_idx:end_idx]

    # Apply 10ms raised-cosine fade in and fade out to avoid clicks
    fade_len = int(0.01 * sr)
    if len(data) > fade_len * 2:
        fade_in = 0.5 * (1 - np.cos(np.linspace(0, np.pi, fade_len)))
        fade_out = 0.5 * (1 + np.cos(np.linspace(0, np.pi, fade_len)))
        data[:fade_len] *= fade_in
        data[-fade_len:] *= fade_out

    sf.write(str(clean_path), data, sr, subtype="PCM_16")
    duration = float(len(data)) / float(sr) if sr > 0 else 0.0

    # Clean up raw un-trimmed intermediate
    try:
        raw_path.unlink(missing_ok=True)
    except Exception:
        pass

    return {
        "id": f"{uid}_{safe_word}",
        "word": word,
        "path": str(clean_path.resolve()),
        "url": f"/api/decbars/sample/{sid}/{clean_path.name}",
        "duration": round(duration, 4),
        "session_id": sid,
    }


async def synthesize_all_words(
    text: str,
    voice: str = "en",
    speed: int = 160,
    pitch: int = 50,
) -> list[dict[str, Any]]:
    """Tokenize and synthesize all words in lyrics sequentially."""
    tokens = tokenize_lyrics(text)
    if not tokens:
        return []
    sid = uuid.uuid4().hex[:12]
    results = []
    for tok in tokens:
        item = await synthesize_word(tok, voice=voice, speed=speed, pitch=pitch, session_id=sid)
        results.append(item)
    return results


async def analyze_beat_file(audio_path: str) -> dict[str, Any]:
    """Detect BPM, duration, beats, and onsets for a backing track."""
    p = Path(audio_path).resolve()
    if not p.is_file():
        raise FileNotFoundError(f"File not found: {audio_path}")

    from ..audio_pipeline import scanner

    # Decode audio to temporary mono 44.1kHz wav for analysis
    ensure_dirs()
    tmp_wav = DECBARS_JUNK / f"probe_{uuid.uuid4().hex[:8]}.wav"
    try:
        ok, detail = await scanner.extract_audio_wav(p, tmp_wav, guard_sec=300)
        if not ok or not tmp_wav.exists():
            raise RuntimeError(f"Failed to decode audio track: {detail}")

        # Check Essentia availability
        if scanner.essentia_available():
            y = scanner._load_mono44k(tmp_wav)
            stats = scanner.content_stats(y)
            rhythm = scanner.analyze_signal(y)
            beats_info = scanner.analyze_beats_and_onsets(y)
            bpm = rhythm.get("tempo") or 120.0
            return {
                "ok": True,
                "bpm": round(float(bpm), 2),
                "duration": round(float(len(y)) / 44100.0, 3),
                "key": rhythm.get("key_name"),
                "beats": beats_info.get("beats", []),
                "onsets": beats_info.get("onsets", []),
                "downbeat_index": beats_info.get("downbeat_index", 0),
            }
        else:
            # Fallback with ffprobe duration and default 120 BPM
            return {
                "ok": True,
                "bpm": 120.0,
                "duration": 0.0,
                "beats": [],
                "onsets": [],
                "downbeat_index": 0,
            }
    finally:
        try:
            tmp_wav.unlink(missing_ok=True)
        except Exception:
            pass


async def render_decbars_mix(
    beat_path: str,
    word_placements: list[dict[str, Any]],
    out_path: str,
    fmt: str = "flac",
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Mix backing beat track with placed words using FFmpeg amix/adelay."""
    ensure_dirs()
    beat = Path(beat_path).resolve()
    if not beat.is_file():
        raise FileNotFoundError(f"Backing track not found: {beat_path}")

    dest = Path(out_path).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Validate words and extract start timestamps in ms
    valid_words = []
    for w in word_placements:
        w_path = Path(w.get("path", "")).resolve()
        if w_path.is_file():
            t_sec = max(0.0, float(w.get("time_sec", 0.0)))
            gain = float(w.get("gain_db", 0.0))
            valid_words.append({
                "path": str(w_path),
                "delay_ms": int(round(t_sec * 1000.0)),
                "gain_db": gain,
            })

    if not valid_words:
        # Just convert backing track directly to destination
        await convert_audio(str(beat), str(dest), fmt, settings or {})
        return {"ok": True, "output": str(dest)}

    # Build multi-input FFmpeg filtergraph:
    # Input 0: beat
    # Input 1..N: words with adelay + volume
    argv = ["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(beat)]
    for w in valid_words:
        argv += ["-i", w["path"]]

    filter_chains = []
    # Normalize beat: [0:a]volume=0dB[b0]
    filter_chains.append("[0:a]volume=0dB[a0]")
    mix_labels = ["[a0]"]

    for i, w in enumerate(valid_words, start=1):
        del_ms = w["delay_ms"]
        gain_db = w["gain_db"]
        label = f"v{i}"
        vol_filter = f"volume={gain_db}dB" if gain_db != 0 else "volume=1.0"
        # Delay left & right channels
        filter_chains.append(f"[{i}:a]adelay={del_ms}|{del_ms},{vol_filter}[{label}]")
        mix_labels.append(f"[{label}]")

    num_inputs = len(mix_labels)
    # amix filter with dropout_transition=0 and duration=first (so song length follows backing beat)
    filter_chains.append(
        f"{''.join(mix_labels)}amix=inputs={num_inputs}:duration=first:dropout_transition=0[outa]"
    )
    filter_str = ";".join(filter_chains)

    # Temporary intermediate mix wav
    tmp_mix = DECBARS_JUNK / f"mix_{uuid.uuid4().hex[:8]}.wav"
    argv += ["-filter_complex", filter_str, "-map", "[outa]", "-c:a", "pcm_s16le", str(tmp_mix.resolve())]

    code, _out, err = await shell.run_command(argv)
    if code != 0 or not tmp_mix.exists():
        raise RuntimeError(f"FFmpeg mixing failed: {err or 'unknown error'}")

    try:
        # Export from intermediate to requested format and settings
        await convert_audio(str(tmp_mix), str(dest), fmt, settings or {})
    finally:
        try:
            tmp_mix.unlink(missing_ok=True)
        except Exception:
            pass

    return {"ok": True, "output": str(dest)}
