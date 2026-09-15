"""
Unit tests for can_concat_copy() strict gate (sequence-conform-copy-spec §9).

Uses synthetic probe dicts for every gate field + every policy rejection.
False negatives acceptable; false positives are not.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.video_pipeline import can_concat_copy  # noqa: E402


def _base_info() -> dict:
    return {
        "codec_name": "h264",
        "codec_tag_string": "avc1",
        "profile": "High",
        "level": 40,
        "width": 1920,
        "height": 1080,
        "pix_fmt": "yuv420p",
        "sample_aspect_ratio": "1:1",
        "field_order": "progressive",
        "r_frame_rate": "24/1",
        "avg_frame_rate": "24/1",
        "time_base": "1/12288",
        "color_range": "tv",
        "color_space": "bt709",
        "color_transfer": "bt709",
        "color_primaries": "bt709",
        "chroma_location": "left",
        "extradata": "abc123",
        "rotation": None,
        "disposition_video": "default",
        "timecode": None,
        "audio_present": True,
        "audio_codec_name": "aac",
        "audio_codec_tag": "mp4a",
        "sample_rate": 48000,
        "channels": 2,
        "channel_layout": "stereo",
        "sample_fmt": "fltp",
        "audio_time_base": "1/48000",
        "audio_extradata": "def456",
        "audio_disposition": "default",
    }


def _sigs(n: int, preset: str = "h264_avc_hq") -> list[dict]:
    return [
        {"variant_path": f"/tmp/c{i}.mp4", "preset": preset}
        for i in range(n)
    ]


class GateTest(unittest.TestCase):
    def test_identical_selects_copy(self):
        ok, reason = can_concat_copy([_base_info(), _base_info()],
                                     preset_id="h264_avc_hq",
                                     conform_signatures=_sigs(2),
                                     audio_policy="encoded")
        self.assertTrue(ok, reason)
        self.assertIn("match", reason)

    def test_video_field_mismatches_fall_back(self):
        for key, other in [
            ("codec_name", "hevc"),
            ("codec_tag_string", "hvc1"),
            ("profile", "Main"),
            ("level", 41),
            ("width", 1280),
            ("height", 720),
            ("pix_fmt", "yuv422p"),
            ("sample_aspect_ratio", "4:3"),
            ("field_order", "tt"),
            ("r_frame_rate", "30/1"),
            ("avg_frame_rate", "30/1"),
            ("time_base", "1/90000"),
            ("color_space", "bt2020nc"),
            ("color_range", "pc"),
            ("color_transfer", "smpte2084"),
            ("color_primaries", "bt2020"),
            ("chroma_location", "topleft"),
            ("extradata", "other"),
        ]:
            with self.subTest(field=key):
                a, b = _base_info(), _base_info()
                b[key] = other
                ok, reason = can_concat_copy([a, b], preset_id="h264_avc_hq",
                                             conform_signatures=_sigs(2),
                                             audio_policy="encoded")
                self.assertFalse(ok)
                self.assertIn(key.replace("_", " "), reason)
                self.assertIn("clip 2", reason)

    def test_audio_mismatches_fall_back(self):
        for key, other in [
            ("audio_codec_name", "ac3"),
            ("audio_codec_tag", "ac-3"),
            ("sample_rate", 44100),
            ("channels", 6),
            ("sample_fmt", "s16"),
            ("audio_time_base", "1/44100"),
            ("audio_extradata", "zzz"),
        ]:
            with self.subTest(field=key):
                a, b = _base_info(), _base_info()
                b[key] = other
                ok, reason = can_concat_copy([a, b], preset_id="h264_avc_hq",
                                             conform_signatures=_sigs(2),
                                             audio_policy="encoded")
                self.assertFalse(ok, key)

    def test_channel_layout_precise_reason(self):
        a, b = _base_info(), _base_info()
        b["channel_layout"] = "5.1"
        ok, reason = can_concat_copy([a, b], preset_id="h264_avc_hq",
                                     conform_signatures=_sigs(2),
                                     audio_policy="encoded")
        self.assertFalse(ok)
        self.assertIn("audio channel layout mismatch at clip 2", reason)

    def test_missing_audio_falls_back(self):
        a, b = _base_info(), _base_info()
        b["audio_present"] = False
        ok, reason = can_concat_copy([a, b], preset_id="h264_avc_hq",
                                     conform_signatures=_sigs(2),
                                     audio_policy="encoded")
        self.assertFalse(ok)
        self.assertIn("audio presence", reason)

    def test_policy_rejections(self):
        # missing conform
        ok, r = can_concat_copy([_base_info(), _base_info()],
                                preset_id="h264_avc_hq",
                                conform_signatures=[{"variant_path": "/tmp/a.mp4", "preset": "h264_avc_hq"}, None],
                                audio_policy="encoded")
        self.assertFalse(ok)
        self.assertIn("missing conformed", r)
        # stale
        ok, r = can_concat_copy([_base_info()], preset_id="h264_avc_hq",
                                conform_signatures=[{"variant_path": "/tmp/a.mp4", "preset": "h264_avc_hq", "stale": True}],
                                audio_policy="encoded")
        self.assertFalse(ok)
        self.assertIn("stale", r)
        # unequal preset
        ok, r = can_concat_copy([_base_info()], preset_id="h264_avc_hq",
                                conform_signatures=[{"variant_path": "/tmp/a.mp4", "preset": "dnxhr_hq"}],
                                audio_policy="encoded")
        self.assertFalse(ok)
        self.assertIn("preset identity", r)
        # unbaked duration / audio / vfr / cut
        for flag in ("unbaked_duration", "unbaked_audio", "vfr_uncertain", "unsupported_cut"):
            with self.subTest(flag=flag):
                info = _base_info()
                info[flag] = True
                ok, r = can_concat_copy([info], preset_id="h264_avc_hq",
                                        conform_signatures=_sigs(1),
                                        audio_policy="encoded")
                self.assertFalse(ok)
        # unbaked audio policy
        ok, r = can_concat_copy([_base_info()], preset_id="h264_avc_hq",
                                conform_signatures=_sigs(1),
                                audio_policy="needs_processing")
        self.assertFalse(ok)
        self.assertIn("unbaked audio", r)
        # unsupported preset
        ok, r = can_concat_copy([_base_info()], preset_id="webm_vp9",
                                conform_signatures=_sigs(1),
                                audio_policy="encoded")
        self.assertFalse(ok)
        self.assertIn("allow-list", r)


if __name__ == "__main__":
    unittest.main()
