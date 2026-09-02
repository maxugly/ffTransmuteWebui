"""
Fix for filename-with-comma handling in join/sequence & grid.

Root bug: /ops/join and /ops/grid built multi-input as a single
comma-joined string, and bash `transmute` split it with IFS=','. A clip
whose own filename contains a comma (e.g. "…yellow spots, camera slowly
pulls b.mp4") was silently truncated → "No such file or directory".

Fixes under test:
  * /ops/join target-less path now uses pure-Python concat_clips + remux
    (inputs as a real list, never comma-joined).
  * /ops/grid now uses the new grid_clips pure-Python xstack helper.
  * bash collect_inputs in transmute + bin/transmute detects a path that
    got truncated at an internal comma and errors loudly.
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

from app.operations.transmute_ops import (  # noqa: E402
    GridParams,
    JoinParams,
    grid,
    join,
)

BIN_TRANSMUTE = ROOT / "bin" / "transmute"


def _run(argv: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, **kw)


def _make_clip(path: str, n_frames: int = 30, fps: str = "24", size: str = "160x120") -> None:
    r = _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=size={size}:rate={fps}",
        "-vframes", str(n_frames),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        path,
    ])
    if r.returncode != 0:
        raise RuntimeError(f"clip fixture failed: {r.stderr[-400:]}")


class JoinCommaTest(unittest.TestCase):
    """/ops/join target-less path must tolerate a clip whose name has a comma."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._dir = Path(tempfile.mkdtemp(prefix="joincomma_"))
        # A clip whose filename contains a comma + space (the old truncation case).
        cls.comma_clip = cls._dir / "yellow spots, camera pulls b.mp4"
        cls.plain_clip = cls._dir / "plain.mp4"
        _make_clip(str(cls.comma_clip))
        _make_clip(str(cls.plain_clip))

    def test_join_legacy_with_comma_filename(self) -> None:
        p = JoinParams(
            input_paths=[str(self.comma_clip), str(self.plain_clip)],
            mode="pad",
            aspect="auto",
        )

        async def run():
            return await join(p)

        result = asyncio.run(run())
        self.assertTrue(result.ok, result.stderr or result.error)
        out = Path(result.output_path)
        self.assertTrue(out.is_file() and out.stat().st_size > 32, result.stdout)
        # The comma clip must have been consumed whole — output exists and is real.
        self.assertGreater(out.stat().st_size, 0)

    def test_join_dry_run_with_comma(self) -> None:
        p = JoinParams(
            input_paths=[str(self.comma_clip), str(self.plain_clip)],
            mode="pad",
            dry_run=True,
        )
        result = asyncio.run(join(p))
        self.assertTrue(result.ok, result.stderr)
        self.assertTrue(result.dry_run)
        self.assertTrue(result.output_path.endswith(".mp4"))

    def test_join_rife_no_target_routes_to_legacy(self) -> None:
        # use_rife=True with no target preset previously hard-errored
        # ("use_rife requires a target preset"). It must now RIFE-preprocess and
        # fall through to the concat+remux legacy path — tested by mocking the
        # two async boundaries so we don't need the RIFE binary.
        import app.operations.transmute_ops as t_ops

        captured: dict = {}

        async def fake_preprocess(inputs, durations, target_fps):
            captured["inputs"] = list(inputs)
            captured["target_fps"] = target_fps
            return [f"{i}_rifed.mov" for i in inputs], 60.0

        async def fake_legacy(p, processed_paths=None):
            captured["processed_paths"] = (
                None if processed_paths is None else list(processed_paths)
            )
            return t_ops.OperationResult(
                ok=True, operation="join",
                output_path="/tmp/fake_out.mp4",
                command="fake",
            )

        orig_rife = t_ops._rife_preprocess
        orig_legacy = t_ops._join_legacy
        t_ops._rife_preprocess = fake_preprocess
        t_ops._join_legacy = fake_legacy
        try:
            p = JoinParams(
                input_paths=[str(self.comma_clip), str(self.plain_clip)],
                use_rife=True,
                target_fps=60,
            )
            result = asyncio.run(join(p))
        finally:
            t_ops._rife_preprocess = orig_rife
            t_ops._join_legacy = orig_legacy

        self.assertTrue(result.ok, result.error)
        self.assertEqual(captured["target_fps"], 60)
        # _join_legacy received the RIFE'd paths (not the originals).
        self.assertEqual(len(captured["processed_paths"]), 2)
        self.assertTrue(all(x.endswith("_rifed.mov") for x in captured["processed_paths"]))


class GridCommaTest(unittest.TestCase):
    """/ops/grid must tolerate comma-filenames via the pure-Python helper."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._dir = Path(tempfile.mkdtemp(prefix="gridcomma_"))
        cls.clips = [
            cls._dir / "one, tag.mp4",
            cls._dir / "two.mp4",
            cls._dir / "three, tag.mp4",
            cls._dir / "four.mp4",
        ]
        for c in cls.clips:
            _make_clip(str(c))

    def test_grid_with_comma_filenames(self) -> None:
        p = GridParams(input_paths=[str(c) for c in self.clips], mode="pad")
        result = asyncio.run(grid(p))
        self.assertTrue(result.ok, result.stderr or result.error)
        out = Path(result.output_path)
        self.assertTrue(out.is_file() and out.stat().st_size > 32, result.stdout)

    def test_grid_dry_run(self) -> None:
        p = GridParams(input_paths=[str(c) for c in self.clips], dry_run=True)
        result = asyncio.run(grid(p))
        self.assertTrue(result.ok, result.stderr)
        self.assertTrue(result.dry_run)


class BashCollectInputsTest(unittest.TestCase):
    """bash collect_inputs + `transmute -j` must reject a comma-in-pathname
    loudly instead of silently truncating the path to a bogus one."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._dir = Path(tempfile.mkdtemp(prefix="collectinputs_"))
        cls.comma = cls._dir / "real file, with comma.mp4"
        cls.other = cls._dir / "other.mp4"
        _make_clip(str(cls.comma))
        _make_clip(str(cls.other))

    def test_join_rejects_comma_inside_path(self) -> None:
        # Direct CLI join with a path that itself contains a comma. The comma
        # delimiter would split it; the hardened script must fail with a clear
        # message rather than emit "No such file or directory" downstream.
        r = _run([
            "bash", str(BIN_TRANSMUTE),
            f"{self.comma},{self.other}", "-j", "pad", "-A", "auto", "-d",
        ])
        self.assertNotEqual(r.returncode, 0)
        merged = (r.stderr + r.stdout).lower()
        self.assertIn("comma", merged)
        self.assertIn("pathname", merged)

    def test_genuine_multi_input_still_works(self) -> None:
        # Two real paths WITH NO comma in their own names still join fine —
        # the hardening must not break legitimate comma-delimited multi-input.
        a = self._dir / "a.mp4"
        b = self._dir / "b.mp4"
        if not (a.exists() and b.exists()):
            _make_clip(str(a))
            _make_clip(str(b))
        r = _run([
            "bash", str(BIN_TRANSMUTE),
            f"{a},{b}", "-j", "pad", "-A", "auto", "-d",
        ])
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn("Output:", r.stdout)


if __name__ == "__main__":
    unittest.main()
