"""
Automated regression tests for the Unified Speed & Time operation
(``speedchange_ops.py``).

The deterministic plan (mirrored 1:1 in the WebUI readout) is validated on
exact maths for Target Multiplier / Target Length, Snap vs. Free RIFE
modes, and the extra-frames accounting. The fast path is then exercised
end-to-end against a real ffmpeg ``testsrc`` clip to prove that the file
on disk matches what the plan promises (duration @ source FPS).
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.operations.speedchange_ops import (  # noqa: E402
    SpeedChangeParams,
    finalize_output_path,
    resolve_speed_plan,
    speedchange,
)


def _run(argv: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True)


def _make_testsrc(path: str, n_frames: int = 120, fps: str = "30") -> None:
    r = _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=size=320x240:rate={fps}",
        "-vframes", str(n_frames),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        path,
    ])
    if r.returncode != 0:
        raise RuntimeError(f"testsrc fixture failed: {r.stderr[-400:]}")


def _probe(path: str) -> dict:
    r = _run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate",
        "-show_entries", "format=duration",
        "-of", "json", path,
    ])
    import json
    data = json.loads(r.stdout or "{}")
    s0 = (data.get("streams") or [{}])[0]
    a, b = (s0.get("r_frame_rate") or "30/1").split("/")
    return {
        "fps": float(a) / float(b),
        "duration": float((data.get("format") or {}).get("duration") or 0),
    }


class ResolvePlanMathTest(unittest.TestCase):
    """Deterministic plan maths — the UI readout mirrors these exactly."""

    def test_fast_multiplier_half_speed(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.5, use_rife=False,
        )
        self.assertAlmostEqual(plan["exact_speed"], 0.5, places=6)
        self.assertAlmostEqual(plan["final_duration"], 8.0, places=4)
        self.assertEqual(plan["final_fps"], 30.0)
        self.assertAlmostEqual(plan["target_frames"], 240.0, places=2)
        self.assertIsNone(plan["rife_multiplier"])

    def _rife_free(self):
        return resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.3, use_rife=True, rife_snap=False,
        )

    def test_rife_free_extra_frames(self):
        plan = self._rife_free()
        self.assertAlmostEqual(plan["exact_speed"], 0.3, places=6)
        self.assertAlmostEqual(plan["final_duration"], 13.3333, places=3)
        self.assertAlmostEqual(plan["target_frames"], 400.0, places=2)
        self.assertEqual(plan["rife_multiplier"], 4)
        self.assertEqual(plan["generated_frames"], 480)
        self.assertAlmostEqual(plan["extra_frames"], 80.0, places=2)
        self.assertFalse(plan["snapped"])

    def test_rife_snap_locks_to_1_over_m(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.3, use_rife=True, rife_snap=True,
        )
        self.assertTrue(plan["snapped"])
        self.assertEqual(plan["rife_multiplier"], 4)
        self.assertAlmostEqual(plan["exact_speed"], 0.25, places=6)
        self.assertAlmostEqual(plan["final_duration"], 16.0, places=4)
        self.assertAlmostEqual(plan["target_frames"], 480.0, places=2)
        self.assertEqual(plan["generated_frames"], 480)
        self.assertAlmostEqual(plan["extra_frames"], 0.0, places=2)

    def test_rife_snap_exact_pow2_stays_exact(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.5, use_rife=True, rife_snap=True,
        )
        self.assertEqual(plan["rife_multiplier"], 2)
        self.assertAlmostEqual(plan["exact_speed"], 0.5, places=6)
        self.assertAlmostEqual(plan["extra_frames"], 0.0, places=2)

    def test_target_length_derives_speed(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="length", target_length=8.0, use_rife=False,
        )
        self.assertAlmostEqual(plan["exact_speed"], 0.5, places=6)
        self.assertAlmostEqual(plan["final_duration"], 8.0, places=4)
        self.assertAlmostEqual(plan["target_frames"], 240.0, places=2)

    def test_speed_clamped_to_valid_range(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=50.0, use_rife=False,
        )
        self.assertAlmostEqual(plan["exact_speed"], 10.0, places=6)
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.001, use_rife=False,
        )
        self.assertAlmostEqual(plan["exact_speed"], 0.1, places=6)

    def test_target_length_clamped_to_min(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="length", target_length=0.01, use_rife=False,
        )
        self.assertAlmostEqual(plan["final_duration"], 0.1, places=4)

    def test_target_fps_override(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=2.0, target_fps=60.0,
            use_rife=False,
        )
        self.assertEqual(plan["final_fps"], 60.0)
        self.assertAlmostEqual(plan["final_duration"], 2.0, places=4)
        self.assertAlmostEqual(plan["target_frames"], 120.0, places=2)

    def test_rife_snap_with_custom_fps_stays_exact(self):
        # 30→60fps at 0.5×: K = (60/30)/0.5 = 4 → M=4, S stays 0.5.
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.5, use_rife=True, rife_snap=True,
            target_fps=60.0,
        )
        self.assertTrue(plan["snapped"])
        self.assertEqual(plan["rife_multiplier"], 4)
        self.assertAlmostEqual(plan["exact_speed"], 0.5, places=6)
        self.assertAlmostEqual(plan["final_duration"], 8.0, places=4)
        self.assertEqual(plan["final_fps"], 60.0)
        self.assertAlmostEqual(plan["target_frames"], 480.0, places=2)
        self.assertEqual(plan["generated_frames"], 480)
        self.assertAlmostEqual(plan["extra_frames"], 0.0, places=2)

    def test_rife_snap_with_custom_fps_locks_speed(self):
        # 30→60fps at 0.3×: K = 6.667 → nearest step M=8, so S is locked to
        # (60/30)/8 = 0.25 and G == R exactly.
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.3, use_rife=True, rife_snap=True,
            target_fps=60.0,
        )
        self.assertTrue(plan["snapped"])
        self.assertEqual(plan["rife_multiplier"], 8)
        self.assertAlmostEqual(plan["exact_speed"], 0.25, places=6)
        self.assertAlmostEqual(plan["final_duration"], 16.0, places=4)
        self.assertAlmostEqual(plan["target_frames"], 960.0, places=2)
        self.assertEqual(plan["generated_frames"], 960)
        self.assertAlmostEqual(plan["extra_frames"], 0.0, places=2)

    def test_rife_free_with_custom_fps_extra(self):
        # 30→60fps at 0.3× free: K=6.667 → M=8, R=800, G=960, extra 160.
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.3, use_rife=True, rife_snap=False,
            target_fps=60.0,
        )
        self.assertFalse(plan["snapped"])
        self.assertEqual(plan["rife_multiplier"], 8)
        self.assertAlmostEqual(plan["exact_speed"], 0.3, places=6)
        self.assertAlmostEqual(plan["target_frames"], 800.0, places=2)
        self.assertEqual(plan["generated_frames"], 960)
        self.assertAlmostEqual(plan["extra_frames"], 160.0, places=2)

    def test_keep_extra_trim_drops_extras(self):
        plan = self._rife_free()  # G=480, R=400, extra 80
        self.assertIsNone(plan["kept_mode"])
        self.assertEqual(plan["generated_frames"], 480)
        self.assertAlmostEqual(plan["extra_frames"], 80.0, places=2)

    def test_keep_extra_fps_encodes_all_and_raises_rate(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.3, use_rife=True, rife_snap=False,
            keep_extra="fps",
        )
        self.assertEqual(plan["rife_multiplier"], 4)
        self.assertEqual(plan["generated_frames"], 480)
        self.assertEqual(plan["target_frames"], 480.0)  # every frame kept
        self.assertEqual(plan["kept_mode"], "fps")
        self.assertAlmostEqual(plan["final_fps"], 36.0, places=4)  # 480/13.333
        self.assertAlmostEqual(plan["final_duration"], 13.3333, places=3)
        self.assertAlmostEqual(plan["extra_frames"], 0.0, places=2)

    def test_keep_extra_length_encodes_all_and_stretches(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.3, use_rife=True, rife_snap=False,
            keep_extra="length",
        )
        self.assertEqual(plan["generated_frames"], 480)
        self.assertEqual(plan["kept_mode"], "length")
        self.assertAlmostEqual(plan["final_duration"], 16.0, places=4)  # 480/30
        self.assertAlmostEqual(plan["final_fps"], 30.0, places=4)
        self.assertEqual(plan["target_frames"], 480.0)
        self.assertAlmostEqual(plan["extra_frames"], 0.0, places=2)

    def test_keep_extra_fps_with_pinned_fps_rejected(self):
        with self.assertRaises(ValueError):
            SpeedChangeParams(
                input_path="/v.mp4", target_mode="multiplier", speed=0.3,
                use_rife=True, rife_snap=False, keep_extra="fps", target_fps=60.0,
            )

    def test_keep_extra_ignored_when_rife_off(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="multiplier", speed=0.5, use_rife=False, keep_extra="fps",
        )
        self.assertIsNone(plan["kept_mode"])

    def test_target_length_with_custom_fps(self):
        plan = resolve_speed_plan(
            src_duration=4.0, src_fps=30.0, src_frames=120,
            target_mode="length", target_length=8.0, use_rife=False,
            target_fps=60.0,
        )
        self.assertAlmostEqual(plan["exact_speed"], 0.5, places=6)
        self.assertEqual(plan["final_fps"], 60.0)
        self.assertAlmostEqual(plan["target_frames"], 480.0, places=2)


class SpeedChangeExecuteTest(unittest.TestCase):
    """Fast path end-to-end: file on disk matches the plan."""

    def _run_op(self, tmpdir: str, **kwargs) -> dict:
        p = SpeedChangeParams(
            input_path=kwargs.pop("input_path"),
            output_path=kwargs.pop("output_path", None),
            **kwargs,
        )
        res = asyncio.run(speedchange(p))
        return res.model_dump()

    def test_fast_multiplier_duration_matches_plan(self):
        with tempfile.TemporaryDirectory() as td:
            src = str(Path(td) / "src.mp4")
            _make_testsrc(src, n_frames=120, fps="30")  # 4s @ 30fps

            out = str(Path(td) / "slow.mp4")
            res = self._run_op(
                td, input_path=src, output_path=out,
                target_mode="multiplier", speed=0.5, use_rife=False,
            )
            self.assertTrue(res["ok"], res.get("error"))
            self.assertTrue(Path(out).is_file())

            info = _probe(out)
            self.assertAlmostEqual(info["duration"], 8.0, delta=0.35)
            self.assertAlmostEqual(info["fps"], 30.0, delta=0.5)
            self.assertEqual(res["meta"]["exact_speed"], 0.5)

    def test_fast_length_target_duration(self):
        with tempfile.TemporaryDirectory() as td:
            src = str(Path(td) / "src.mp4")
            _make_testsrc(src, n_frames=120, fps="30")

            out = str(Path(td) / "len.mp4")
            res = self._run_op(
                td, input_path=src, output_path=out,
                target_mode="length", target_length=2.0, use_rife=False,
            )
            self.assertTrue(res["ok"], res.get("error"))
            info = _probe(out)
            self.assertAlmostEqual(info["duration"], 2.0, delta=0.25)
            self.assertAlmostEqual(info["fps"], 30.0, delta=0.5)

    def test_fast_custom_fps_retimes_output(self):
        # 4s @ 30fps, 0.5× → 8.0s @ 60fps (frame doubling, no RIFE).
        with tempfile.TemporaryDirectory() as td:
            src = str(Path(td) / "src.mp4")
            _make_testsrc(src, n_frames=120, fps="30")

            out = str(Path(td) / "fps60.mp4")
            res = self._run_op(
                td, input_path=src, output_path=out,
                target_mode="multiplier", speed=0.5, use_rife=False,
                target_fps=60.0,
            )
            self.assertTrue(res["ok"], res.get("error"))
            self.assertEqual(res["meta"]["final_fps"], 60.0)
            info = _probe(out)
            self.assertAlmostEqual(info["duration"], 8.0, delta=0.35)
            self.assertAlmostEqual(info["fps"], 60.0, delta=0.5)

    def test_dry_run_returns_plan_meta(self):
        with tempfile.TemporaryDirectory() as td:
            src = str(Path(td) / "src.mp4")
            _make_testsrc(src, n_frames=120, fps="30")
            res = self._run_op(
                td, input_path=src, output_path=None,
                target_mode="multiplier", speed=0.3,
                use_rife=True, rife_snap=False, dry_run=True,
            )
            self.assertTrue(res["ok"])
            self.assertTrue(res["dry_run"])
            self.assertEqual(res["meta"]["rife_multiplier"], 4)
            self.assertAlmostEqual(res["meta"]["extra_frames"], 80.0, places=2)

    def test_missing_input_rejected(self):
        res = asyncio.run(speedchange(SpeedChangeParams(input_path="/nope.mp4")))
        self.assertFalse(res.ok)


class FinalizeOutputTest(unittest.TestCase):
    def test_suffix_and_allowed_ext(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "clip.mp4"
            p = finalize_output_path(
                None, source=src, default_suffix="_speed0p5x",
                default_ext=".mp4", allowed_exts={".mp4", ".mkv"},
            )
            self.assertEqual(p.suffix, ".mp4")
            self.assertIn("_speed0p5x", p.name)
            self.assertTrue(p.parent.exists())


if __name__ == "__main__":
    unittest.main()