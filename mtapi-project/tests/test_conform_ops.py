"""
Conform op tests (sequence-conform-copy-spec §13): allow-list, validation,
absolute paths, HTTP-200-style ok:false, registration, stale rejection,
original vs RIFE source-variant distinction.
"""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.convert_presets import CONFORM_PRESETS, is_conform_preset  # noqa: E402
from app.operations.conform_ops import ConformParams, conform  # noqa: E402
from app.video_pipeline import (  # noqa: E402
    conform_signature,
    is_conform_signature_valid,
)


class AllowListTest(unittest.TestCase):
    def test_initial_allow_list(self):
        self.assertEqual(tuple(CONFORM_PRESETS),
                         ("h264_avc_hq", "h265_hevc", "dnxhr_hq", "prores_hq"))
        for excluded in ("webm_vp9", "av1_mp4", "ffv1_mkv",
                         "prores_proxy", "dnxhr_lb"):
            self.assertFalse(is_conform_preset(excluded), excluded)
        for allowed in CONFORM_PRESETS:
            self.assertTrue(is_conform_preset(allowed), allowed)

    def test_default(self):
        from app.convert_presets import CONFORM_PRESET_DEFAULT
        self.assertEqual(CONFORM_PRESET_DEFAULT, "h264_avc_hq")


class ValidationTest(unittest.TestCase):
    def _params(self, **kw) -> ConformParams:
        base = dict(input_path="/tmp/a.mp4", width=1920, height=1080)
        base.update(kw)
        return ConformParams(**base)

    def test_bad_preset_rejected_ok_false(self):
        p = self._params(preset="webm_vp9")
        res = asyncio.run(conform(p))
        self.assertFalse(res.ok)
        self.assertIn("allow-list", res.error)

    def test_relative_path_rejected(self):
        p = self._params(input_path="relative/a.mp4")
        res = asyncio.run(conform(p))
        self.assertFalse(res.ok)
        self.assertIn("absolute", res.error)

    def test_missing_path_rejected(self):
        p = self._params(input_path="/does/not/exist_aac123.mp4")
        res = asyncio.run(conform(p))
        self.assertFalse(res.ok)
        self.assertIn("not found", res.error)

    def test_invalid_mode_rejected_by_model(self):
        with self.assertRaises(Exception):
            self._params(mode="warp")

    def test_invalid_fps_rejected_by_model(self):
        with self.assertRaises(Exception):
            self._params(target_fps=-5)

    def test_invalid_duration_rejected_by_model(self):
        with self.assertRaises(Exception):
            self._params(target_duration=0)

    def test_rife_multiplier_bounds(self):
        with self.assertRaises(Exception):
            self._params(rife_multiplier=256)
        ok = self._params(rife_multiplier=4)
        self.assertEqual(ok.rife_multiplier, 4)


class SignatureTest(unittest.TestCase):
    def _sig(self, **kw) -> dict:
        base = dict(parent_path="/tmp/a.mp4", variant_path="/tmp/a_conformed.mp4",
                    source_size=100, source_mtime=10.0, source_variant="original",
                    mode="pad", aspect="16:9", width=1920, height=1080,
                    target_fps=24.0, time_factor=1.0, preset="h264_avc_hq",
                    audio_policy="encoded", rife_multiplier=None)
        base.update(kw)
        return conform_signature(**base)

    def test_valid(self):
        sig = self._sig()
        cur = dict(sig)
        ok, reason = is_conform_signature_valid(sig, current=cur,
                                                output_exists=True, output_size=100)
        self.assertTrue(ok, reason)

    def test_mode_change_invalidates(self):
        sig = self._sig()
        cur = dict(sig, mode="crop")
        ok, _ = is_conform_signature_valid(sig, current=cur,
                                           output_exists=True, output_size=100)
        self.assertFalse(ok)

    def test_missing_output_invalid(self):
        sig = self._sig()
        ok, reason = is_conform_signature_valid(sig, current=dict(sig),
                                                output_exists=False, output_size=0)
        self.assertFalse(ok)
        self.assertIn("missing", reason)

    def test_source_variant_distinction(self):
        orig = self._sig(source_variant="original")
        rife = self._sig(source_variant="rifed")
        ok, _ = is_conform_signature_valid(orig, current=dict(rife),
                                           output_exists=True, output_size=100)
        self.assertFalse(ok)

    def test_complete_signature_fields(self):
        sig = self._sig()
        for key in ("kind", "parent_path", "variant_path", "source_size",
                    "source_mtime", "source_variant", "mode", "aspect",
                    "width", "height", "target_fps", "time_factor",
                    "preset", "audio_policy", "rife_multiplier"):
            self.assertIn(key, sig, key)
        self.assertEqual(sig["kind"], "conformed")


if __name__ == "__main__":
    unittest.main()
