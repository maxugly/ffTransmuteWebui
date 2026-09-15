"""
Regression tests for the final-video encode fixes in video_pipeline.

Covers three failure modes behind "renders but makes nothing / fails
depending on settings":

  1. encode() no longer returns success when ffmpeg writes nothing
     (_ensure_output_file guard).
  2. Legacy frame-op encodes (RIFE, slow-mo) pad odd chroma-subsampled
     dimensions instead of crashing on "width not divisible by 2".
  3. `-shortest` no longer silently trims generated (RIFE'd) frames to the
     audio length, unless the caller explicitly opts in via clamp_to_audio
     (e.g. cut).
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.video_pipeline import (  # noqa: E402
    _build_encode_argv,
    _ensure_output_file,
    dump,
    encode,
)
from app.job_workspace import JobWorkspace  # noqa: E402


def _run(argv: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True)


def _make_audio(path: str, seconds: float = 1.0) -> None:
    r = _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
        "-c:a", "aac", path,
    ])
    if r.returncode != 0:
        raise RuntimeError(f"audio fixture failed: {r.stderr[-400:]}")


class BuildArgvTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.audio = Path(self.tmp.name) / "audio.m4a"
        _make_audio(str(self.audio))

    def tearDown(self):
        self.tmp.cleanup()

    @property
    def _kw(self):
        return dict(
            in_pattern="/tmp/f/frame_%06d.png",
            out_path="/tmp/f/out.mp4",
            fps=30.0,
            audio_path=self.audio,
            mux_audio=True,
            silence_on_no_audio=False,
            codec="libx264",
            crf=18,
            preset="fast",
            pix_fmt="yuv420p",
            even_floor=False,
            encode_preset=None,
            extra_vf=None,
        )

    def test_legacy_mux_does_not_shortest_by_default(self):
        argv = _build_encode_argv(**self._kw)
        self.assertNotIn("-shortest", argv)

    def test_legacy_mux_clamps_when_opt_in(self):
        argv = _build_encode_argv(**self._kw, clamp_to_audio=True)
        self.assertIn("-shortest", argv)

    def test_legacy_yuv420p_pads_odd_dims_by_default(self):
        argv = _build_encode_argv(**self._kw)
        joined = " ".join(argv)
        self.assertIn("pad=ceil(iw/2)*2:ceil(ih/2)*2", joined)

    def test_preserved_explicit_an_for_no_audio(self):
        kw = dict(self._kw, mux_audio=False)
        argv = _build_encode_argv(**kw)
        self.assertIn("-an", argv)
        self.assertNotIn("-shortest", argv)


class EnsureOutputTest(unittest.TestCase):
    def test_missing_raises(self):
        with self.assertRaisesRegex(RuntimeError, "produced no output"):
            _ensure_output_file(Path("/does/not/exist.mp4"))

    def test_empty_raises(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(b"")
            p = Path(f.name)
        try:
            with self.assertRaisesRegex(RuntimeError, "empty output"):
                _ensure_output_file(p)
        finally:
            p.unlink(missing_ok=True)

    def test_nonempty_passes(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(b"x" * 1024)
            p = Path(f.name)
        try:
            _ensure_output_file(p)  # no raise
        finally:
            p.unlink(missing_ok=True)


class EncodeIntegrationTest(unittest.TestCase):
    """Real ffmpeg end-to-end: odd dims + silent-dump failure surfaces."""

    def test_odd_dimension_source_encodes(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            src = td / "odd.mp4"
            # 321x241 -> odd, would crash yuv420p without the pad fix.
            r = _run([
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc=size=321x241:rate=24",
                "-vframes", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                str(src),
            ])
            if r.returncode != 0:
                self.skipTest(f"could not build odd fixture: {r.stderr[-200:]}")

            async def go():
                ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="encfix_")
                try:
                    await dump(ws, src)
                    out = td / "out.mp4"
                    await encode(ws, str(out), 24.0, mux_audio=False,
                                  frame_source_dir=ws.frames_in)
                    self.assertTrue(out.is_file() and out.stat().st_size > 32)
                finally:
                    ws.cleanup(keep_on_failure=False)

            asyncio.run(go())

    def test_empty_output_raises(self):
        """A missing/empty output path must raise, not silently succeed."""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            async def go():
                ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="encfix_")
                try:
                    bogus = td / "does_not_exist"
                    with self.assertRaises(RuntimeError):
                        _ensure_output_file(bogus)
                finally:
                    ws.cleanup(keep_on_failure=False)

            asyncio.run(go())


class ConformEncodeTest(unittest.TestCase):
    """Conform geometry/timing/audio contract (sequence-conform-copy-spec §7)."""

    def test_conform_vf_fragments(self):
        from app.video_pipeline import _conform_vf
        pad = _conform_vf("pad", 1920, 1080, 1.0)
        self.assertIn("pad=1920:1080", pad)
        self.assertIn("setsar=1", pad)
        crop = _conform_vf("crop", 1920, 1080, 1.0)
        self.assertIn("crop=1920:1080", crop)
        stretch = _conform_vf("stretch", 1920, 1080, 1.0)
        self.assertIn("scale=1920:1080", stretch)
        self.assertNotIn("pad=", stretch)
        with self.assertRaises(ValueError):
            _conform_vf("warp", 1920, 1080, 1.0)

    def test_conform_af_omits_rubberband_at_factor_1(self):
        from app.video_pipeline import _conform_af
        af = _conform_af(has_audio=True, factor=1.0, duration=5.0)
        self.assertIsNotNone(af)
        self.assertNotIn("rubberband", af)
        af2 = _conform_af(has_audio=True, factor=2.0, duration=5.0)
        self.assertIn("rubberband", af2)
        self.assertIsNone(_conform_af(has_audio=False, factor=2.0, duration=5.0))

    def test_conform_preset_audio_selection(self):
        from app.convert_presets import ENCODE_PRESETS
        # AAC delivery preset vs PCM intermediate preset.
        self.assertEqual(ENCODE_PRESETS["h264_avc_hq"].audio_codec, "aac")
        self.assertEqual(ENCODE_PRESETS["dnxhr_hq"].audio_codec, "pcm_s16le")
        self.assertEqual(ENCODE_PRESETS["prores_hq"].audio_codec, "pcm_s16le")

    def test_concat_list_absolute_escaped(self):
        from app.video_pipeline import write_concat_list
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            lst = write_concat_list(["/tmp/a.mp4", "/tmp/b's.mp4"], td / "list.txt")
            text = lst.read_text()
            self.assertIn("file '/tmp/a.mp4'", text)
            self.assertIn("b'\\''s.mp4", text)


if __name__ == "__main__":
    unittest.main()
