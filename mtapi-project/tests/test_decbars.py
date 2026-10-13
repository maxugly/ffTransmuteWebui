"""Unit tests for DECbars audio synthesis, beat analysis, and router."""
import asyncio
from pathlib import Path
import pytest
from app.audio import decbars


def test_tokenize_lyrics():
    tokens = decbars.tokenize_lyrics("Stephen Hawking on the mic! 1, 2, 3 drop it.")
    assert tokens == ["Stephen", "Hawking", "on", "the", "mic", "1", "2", "3", "drop", "it"]


def test_synthesize_word_espeak():
    res = asyncio.run(decbars.synthesize_word("robot", voice="en", speed=160, pitch=50))
    assert res["word"] == "robot"
    assert Path(res["path"]).is_file()
    assert res["duration"] > 0
    assert res["url"].startswith("/api/decbars/sample/")


def test_synthesize_all_words():
    words = asyncio.run(decbars.synthesize_all_words("robot bars", voice="en"))
    assert len(words) == 2
    assert words[0]["word"] == "robot"
    assert words[1]["word"] == "bars"


def test_render_mix_creates_output(tmp_path):
    # Create dummy 1-second sine wave beat
    import numpy as np
    import soundfile as sf
    sr = 44100
    t = np.linspace(0, 1.0, sr, endpoint=False)
    sine = 0.5 * np.sin(2 * np.pi * 440 * t)
    beat_wav = tmp_path / "beat.wav"
    sf.write(str(beat_wav), sine, sr)

    # Synthesize word
    w = asyncio.run(decbars.synthesize_word("test", voice="en"))

    out_file = tmp_path / "mix_out.flac"
    res = asyncio.run(decbars.render_decbars_mix(
        beat_path=str(beat_wav),
        word_placements=[{"id": w["id"], "path": w["path"], "time_sec": 0.25, "gain_db": 0.0}],
        out_path=str(out_file),
        fmt="flac",
    ))
    assert res["ok"] is True
    assert out_file.is_file()
    assert out_file.stat().st_size > 0
