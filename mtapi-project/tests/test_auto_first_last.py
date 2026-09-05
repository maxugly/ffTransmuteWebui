"""Auto first/last: skip-if-exists + crash-safe tmp/rename + settings defaults."""
from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.media.performance import _normalize_settings, DEFAULT_SETTINGS  # noqa: E402
from app.media.thumbnails import export_frame_png  # noqa: E402


def _run(argv: list[str]) -> None:
    r = subprocess.run(argv, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"fixture failed: {r.stderr[-400:]}")


def _make_clip(path: Path) -> None:
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=160x120:rate=24:duration=0.5",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path),
    ])


class SettingsDefaultsTest(unittest.TestCase):
    def test_defaults_off(self):
        self.assertFalse(DEFAULT_SETTINGS["auto_first_last"])
        self.assertEqual(DEFAULT_SETTINGS["auto_first_last_mode"], "import")

    def test_normalize_missing(self):
        d = _normalize_settings({})
        self.assertFalse(d["auto_first_last"])
        self.assertEqual(d["auto_first_last_mode"], "import")

    def test_normalize_sequence(self):
        d = _normalize_settings({"auto_first_last": True, "auto_first_last_mode": "sequence"})
        self.assertTrue(d["auto_first_last"])
        self.assertEqual(d["auto_first_last_mode"], "sequence")

    def test_normalize_bad_mode_falls_back(self):
        d = _normalize_settings({"auto_first_last_mode": "bogus"})
        self.assertEqual(d["auto_first_last_mode"], "import")


class ExportSkipTest(unittest.TestCase):
    def test_skip_if_exists_no_overwrite_no_numbered_sibling(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            src = td / "clip.mp4"
            try:
                _make_clip(src)
            except RuntimeError as e:
                self.skipTest(str(e))
            first = asyncio.run(export_frame_png(src, which="first", skip_if_exists=True))
            self.assertTrue(first.get("ok") and not first.get("skipped"))
            out = Path(first["output_path"])
            self.assertEqual(out.name, "clip_first.png")
            self.assertTrue(out.is_file() and out.stat().st_size > 0)
            mtime = out.stat().st_mtime
            time.sleep(0.05)
            second = asyncio.run(export_frame_png(src, which="first", skip_if_exists=True))
            self.assertTrue(second.get("ok") and second.get("skipped"))
            self.assertEqual(Path(second["output_path"]), out)
            self.assertEqual(out.stat().st_mtime, mtime)
            self.assertFalse((td / "clip_first_0001.png").exists())
            self.assertFalse((td / "clip_first.tmp.png").exists())

    def test_stale_tmp_does_not_block_and_leaves_no_tmp(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            src = td / "clip.mp4"
            try:
                _make_clip(src)
            except RuntimeError as e:
                self.skipTest(str(e))
            # Simulate crash: truncated tmp at final name's sidecar, no final file.
            (td / "clip_first.tmp.png").write_bytes(b"partial")
            r = asyncio.run(export_frame_png(src, which="first", skip_if_exists=True))
            self.assertTrue(r.get("ok") and not r.get("skipped"))
            self.assertTrue(Path(r["output_path"]).is_file())
            self.assertFalse((td / "clip_first.png.tmp").exists())

    def test_last_frame_skip_path(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            src = td / "clip.mp4"
            try:
                _make_clip(src)
            except RuntimeError as e:
                self.skipTest(str(e))
            first = asyncio.run(export_frame_png(src, which="last", skip_if_exists=True))
            self.assertTrue(first.get("ok"))
            out = Path(first["output_path"])
            self.assertEqual(out.name, "clip_last.png")
            second = asyncio.run(export_frame_png(src, which="last", skip_if_exists=True))
            self.assertTrue(second.get("skipped"))


if __name__ == "__main__":
    unittest.main()
