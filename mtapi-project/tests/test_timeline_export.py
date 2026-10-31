"""
Tests for Timeline Export (EDL & FCPXML) and DaVinci Resolve intermediate generation.
Spec: docs/sequence-timeline-export-spec.md
"""
from __future__ import annotations

import asyncio
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.timeline_export import (  # noqa: E402
    duration_to_frames,
    frames_to_tc,
    generate_edl,
    generate_fcpxml,
)
from app.operations.timeline_export_ops import (  # noqa: E402
    TimelineClipInput,
    TimelineExportParams,
    sequence_timeline_export,
    is_davinci_compatible,
)
from app.video_pipeline import probe, probe_copy_info  # noqa: E402


def _make_synth_clip(path: Path, duration: float = 1.0, freq: int = 440) -> None:
    """Create a minimal synthetic video clip with ffmpeg."""
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=size=160x120:rate=30",
        "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={duration}",
        "-t", str(duration),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        str(path),
    ]
    subprocess.run(cmd, check=True)


class TestPureGenerators(unittest.TestCase):
    def test_timecode_math(self):
        # 0s -> 0 frames -> 00:00:00:00
        self.assertEqual(duration_to_frames(0.0, 30.0), 0)
        self.assertEqual(frames_to_tc(0, 30.0), "00:00:00:00")

        # 1.0s @ 30fps -> 30 frames -> 00:00:01:00
        self.assertEqual(duration_to_frames(1.0, 30.0), 30)
        self.assertEqual(frames_to_tc(30, 30.0), "00:00:01:00")

        # 1.5s @ 30fps -> 45 frames -> 00:00:01:15
        self.assertEqual(duration_to_frames(1.5, 30.0), 45)
        self.assertEqual(frames_to_tc(45, 30.0), "00:00:01:15")

        # 1h 1m 1s @ 30fps -> 3661s -> 109830 frames
        self.assertEqual(frames_to_tc(109830, 30.0), "01:01:01:00")

        # 24 fps
        self.assertEqual(duration_to_frames(1.0, 24.0), 24)
        self.assertEqual(frames_to_tc(24, 24.0), "00:00:01:00")

    def test_generate_edl_3_clips(self):
        clips = [
            ("clip1.mp4", 2.0),
            ("clip2.mp4", 3.0),
            ("clip3.mp4", 1.5),
        ]
        edl_text = generate_edl(clips, fps=30.0, title="MySequence")

        lines = edl_text.strip().split("\n")
        self.assertEqual(lines[0], "TITLE: MySequence")
        self.assertEqual(lines[1], "FCM: NON DROP FRAME")

        # Line 3 is empty
        # Event 1
        self.assertIn("001  clip1    V     C        00:00:00:00 00:00:02:00 01:00:00:00 01:00:02:00", edl_text)
        self.assertIn("* FROM CLIP NAME: clip1.mp4", edl_text)

        # Event 2
        self.assertIn("002  clip2    V     C        00:00:00:00 00:00:03:00 01:00:02:00 01:00:05:00", edl_text)
        self.assertIn("* FROM CLIP NAME: clip2.mp4", edl_text)

        # Event 3
        self.assertIn("003  clip3    V     C        00:00:00:00 00:00:01:15 01:00:05:00 01:00:06:15", edl_text)
        self.assertIn("* FROM CLIP NAME: clip3.mp4", edl_text)

    def test_generate_fcpxml_3_clips(self):
        clips = [
            ("clip1.mp4", 2.0),
            ("clip2.mp4", 3.0),
            ("clip3.mp4", 1.5),
        ]
        xml_text = generate_fcpxml(clips, fps=30.0, title="MySequence")

        # Parse XML
        root = ET.fromstring(xml_text)
        self.assertEqual(root.tag, "fcpxml")
        self.assertEqual(root.get("version"), "1.10.0")

        # Check assets
        assets_el = root.find("assets")
        self.assertIsNotNone(assets_el)
        assets = assets_el.findall("asset")
        self.assertEqual(len(assets), 3)
        self.assertEqual(assets[0].get("name"), "clip1.mp4")
        self.assertEqual(assets[1].get("name"), "clip2.mp4")
        self.assertEqual(assets[2].get("name"), "clip3.mp4")

        # Check sequence and spine
        sequence = root.find("sequence")
        self.assertIsNotNone(sequence)
        self.assertEqual(sequence.get("duration"), "00:00:06:15")

        spine = sequence.find("spine")
        xml_clips = spine.findall("clip")
        self.assertEqual(len(xml_clips), 3)
        self.assertEqual(xml_clips[0].get("ref"), "asset-1")
        self.assertEqual(xml_clips[0].get("duration"), "00:00:02:00")
        self.assertEqual(xml_clips[1].get("ref"), "asset-2")
        self.assertEqual(xml_clips[1].get("duration"), "00:00:03:00")
        self.assertEqual(xml_clips[2].get("ref"), "asset-3")
        self.assertEqual(xml_clips[2].get("duration"), "00:00:01:15")


class TestTimelineExportOperations(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.dir = Path(self.td.name)
        self.clip1 = self.dir / "clip1.mp4"
        self.clip2 = self.dir / "clip2.mp4"
        self.clip3 = self.dir / "clip3.mp4"
        _make_synth_clip(self.clip1, duration=1.0, freq=220)
        _make_synth_clip(self.clip2, duration=1.0, freq=440)
        _make_synth_clip(self.clip3, duration=1.0, freq=880)

    def tearDown(self):
        self.td.cleanup()

    def test_export_edl_operation(self):
        params = TimelineExportParams(
            clips=[
                TimelineClipInput(path=str(self.clip1), duration=1.0),
                TimelineClipInput(path=str(self.clip2), duration=1.0),
                TimelineClipInput(path=str(self.clip3), duration=1.0),
            ],
            format="edl",
            fps=30.0,
            title="TestEDL",
        )
        res = asyncio.run(sequence_timeline_export(params))
        self.assertTrue(res.ok)
        out_p = Path(res.output_path)
        self.assertTrue(out_p.is_file())
        self.assertEqual(out_p.suffix, ".edl")
        content = out_p.read_text(encoding="utf-8")
        self.assertIn("TITLE: TestEDL", content)
        self.assertIn("001  clip1", content)
        self.assertIn("002  clip2", content)
        self.assertIn("003  clip3", content)
        self.assertEqual(res.meta["clip_count"], 3)

    def test_export_fcpxml_operation(self):
        params = TimelineExportParams(
            clips=[
                TimelineClipInput(path=str(self.clip1), duration=1.0),
                TimelineClipInput(path=str(self.clip2), duration=1.0),
                TimelineClipInput(path=str(self.clip3), duration=1.0),
            ],
            format="fcpxml",
            fps=30.0,
            title="TestFCPXML",
        )
        res = asyncio.run(sequence_timeline_export(params))
        self.assertTrue(res.ok)
        out_p = Path(res.output_path)
        self.assertTrue(out_p.is_file())
        self.assertEqual(out_p.suffix, ".xml")
        root = ET.parse(out_p).getroot()
        self.assertEqual(root.tag, "fcpxml")

    def test_davinci_resolve_only_generation_and_reuse(self):
        # Initial export with resolve_only=True
        params = TimelineExportParams(
            clips=[
                TimelineClipInput(path=str(self.clip1), duration=1.0),
                TimelineClipInput(path=str(self.clip2), duration=1.0),
                TimelineClipInput(path=str(self.clip3), duration=1.0),
            ],
            format="edl",
            fps=30.0,
            title="TestResolve",
            resolve_only=True,
            resolve_preset="prores_proxy",
        )
        res = asyncio.run(sequence_timeline_export(params))
        self.assertTrue(res.ok)
        self.assertEqual(res.meta["generated_count"], 3)
        self.assertEqual(res.meta["reused_count"], 0)

        # Verify generated intermediates
        for resolved_path_str in res.meta["resolved_paths"]:
            p = Path(resolved_path_str)
            self.assertTrue(p.is_file())
            self.assertEqual(p.suffix, ".mov")
            info = asyncio.run(probe_copy_info(p))
            self.assertTrue(is_davinci_compatible(p, info))

        # Re-run same export: should REUSE without re-encoding
        res2 = asyncio.run(sequence_timeline_export(params))
        self.assertTrue(res2.ok)
        self.assertEqual(res2.meta["generated_count"], 0)
        self.assertEqual(res2.meta["reused_count"], 3)

    def test_invariant_10_missing_file_returns_ok_false(self):
        params = TimelineExportParams(
            clips=[
                TimelineClipInput(path=str(self.dir / "does_not_exist.mp4")),
            ],
            format="edl",
        )
        res = asyncio.run(sequence_timeline_export(params))
        self.assertFalse(res.ok)
        self.assertIn("Source clip not found", res.error)

    def test_invariant_10_invalid_preset_returns_ok_false(self):
        params = TimelineExportParams(
            clips=[
                TimelineClipInput(path=str(self.clip1), duration=1.0),
            ],
            format="edl",
            resolve_only=True,
            resolve_preset="invalid_preset_xyz",
        )
        res = asyncio.run(sequence_timeline_export(params))
        self.assertFalse(res.ok)
        self.assertIn("Invalid DaVinci preset", res.error)


if __name__ == "__main__":
    unittest.main()
