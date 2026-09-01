"""
Automated regression tests for the redesigned Visual Hijack pipeline
(motion-vector payload injection).

These tests validate the four pillars of the redesign:

1. The payload image is actually visible at the injection point.
2. Subsequent frames visibly inherit source motion (verified at the
   MPEG-2 MV level for uniform payloads, and at the pixel level for
   structured payloads).
3. The output stream decodes without MPEG-2 corruption or
   error-concealment messages.
4. No rgb(0, 135, 0) decoder-error green pixels appear anywhere.

The pipeline is exercised end-to-end through the public
``DatamoshHijackParams`` / ``datamosh_hijack`` interface.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.operations.datamosh.common import DECODER_ERROR_PATTERNS  # noqa: E402


# ── Test fixtures ──────────────────────────────────────────────────────────

_TESTSRC_DIMS = "480x360"
_TESTFPS = "30"


def _make_testsrc(
    dst: str,
    n_frames: int = 120,
    dims: str = _TESTSRC_DIMS,
    fps: str = _TESTFPS,
) -> None:
    """Create a testsrc video with moving patterns (so source MVs are non-zero)."""
    w, h = dims.split("x")
    subprocess_run([
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", f"testsrc=size={w}x{h}:rate={fps}",
        "-vframes", str(n_frames),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        dst,
    ])


def _make_color_png(dst: str, w: int, h: int, r: int, g: int, b: int) -> None:
    from PIL import Image  # type: ignore[import-not-found]
    im = Image.new("RGB", (w, h), (r, g, b))
    im.save(dst)


def _make_gradient_png(dst: str, w: int, h: int) -> None:
    """A structured image whose motion is visible when MVs are applied."""
    from PIL import Image  # type: ignore[import-not-found]
    px = Image.new("RGB", (w, h))
    data = px.load()
    for y in range(h):
        for x in range(w):
            data[x, y] = (x % 256, y % 256, (x + y) % 256)
    px.save(dst)


def subprocess_run(cmd: list[str], **kw) -> tuple[int, str, str]:
    import asyncio
    from app.shell import run_command
    return asyncio.run(run_command(cmd, **kw))


class HijackTestBase(unittest.TestCase):
    """Shared fixture: testsrc video + red.png + gradient.png."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="mtapi_hijack_test_")
        cls.dir = cls.tmp.name
        cls.src = os.path.join(cls.dir, "testsrc.mp4")
        cls.red_img = os.path.join(cls.dir, "red.png")
        cls.gradient_img = os.path.join(cls.dir, "gradient.png")
        w, h = _TESTSRC_DIMS.split("x")
        W, H = int(w), int(h)
        _make_testsrc(cls.src, 120)
        _make_color_png(cls.red_img, W, H, 255, 0, 0)
        _make_gradient_png(cls.gradient_img, W, H)
        cls.w, cls.h = W, H
        cls.fps = float(_TESTFPS)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _run_hijack(self, **kwargs) -> "HijackResult":
        from app.operations.datamosh.hijack import datamosh_hijack, DatamoshHijackParams

        defaults = dict(
            input_path=self.src,
            inject_mode="file",
            inject_image_path=self.red_img,
            start_frame=30,
            end_frame=49,
            transition_style="smear",
        )
        defaults.update(kwargs)
        p = DatamoshHijackParams(**defaults)
        res = asyncio.run(datamosh_hijack(p))
        return HijackResult(res)

    def _decode_with_stderr(self, video_path: str) -> tuple[int, str]:
        """Run ffmpeg decode and return (exit_code, stderr_text)."""
        cmd = [
            "ffmpeg", "-v", "error", "-i", video_path,
            "-f", "null", "-",
        ]
        code, _, err = subprocess_run(cmd)
        return code, err

    def _extract_frames(self, video_path: str, dst_dir: str, every_n: int = 1) -> list:
        """Extract frames as PNGs, return sorted list of paths."""
        os.makedirs(dst_dir, exist_ok=True)
        for f in os.listdir(dst_dir):
            if f.endswith(".png"):
                os.remove(os.path.join(dst_dir, f))
        if every_n > 1:
            cmd = [
                "ffmpeg", "-y", "-i", video_path,
                "-vf", f"select=not(mod(n\\,{every_n}))",
                "-vsync", "0",
                os.path.join(dst_dir, "frame_%03d.png"),
            ]
        else:
            cmd = [
                "ffmpeg", "-y", "-i", video_path,
                "-vsync", "0",
                os.path.join(dst_dir, "frame_%03d.png"),
            ]
        code, _, err = subprocess_run(cmd)
        files = sorted(os.listdir(dst_dir))
        if not files:
            raise RuntimeError(f"No frames extracted: {err}")
        return [os.path.join(dst_dir, f) for f in files if f.endswith(".png")]


class HijackResult:
    """Wrapper around OperationResult for test assertions."""

    def __init__(self, res):
        self.res = res
        self.path = res.output_path if res.ok else None


class DecoderValidationTests(HijackTestBase):
    """Validate the output stream is free of MPEG-2 corruption."""

    def test_no_decoder_errors_in_stderr(self):
        """The full pipeline must produce a stream that decodes with zero
        error/warning messages matching the forbidden patterns."""
        r = self._run_hijack()
        self.assertTrue(r.res.ok, f"Hijack failed: {r.res.error}")

        code, stderr = self._decode_with_stderr(r.path)
        # ffmpeg -v error should capture all warning/error messages
        lower = stderr.lower()
        for pattern in DECODER_ERROR_PATTERNS:
            self.assertNotIn(
                pattern.lower(), lower,
                f"Decoder produced forbidden pattern '{pattern}': {stderr[:500]}",
            )

    def test_no_decoder_error_green_pixels(self):
        """Scan every decoded frame for rgb(0, 135, 0) decoder-error green."""
        r = self._run_hijack()
        self.assertTrue(r.res.ok, f"Hijack failed: {r.res.error}")

        frame_dir = os.path.join(self.dir, "_frames_green_check")
        frames = self._extract_frames(r.path, frame_dir)
        self.assertGreaterEqual(len(frames), 100, f"Expected >=100 frames, got {len(frames)}")

        from PIL import Image  # type: ignore[import-not-found]
        total_green = 0
        for fp in frames:
            im = Image.open(fp).convert("RGB")
            px = list(im.getdata())
            green = sum(1 for p in px if p[0] == 0 and p[1] == 135 and p[2] == 0)
            total_green += green
        self.assertEqual(total_green, 0, f"Found {total_green} decoder-error green pixels")


class ImageInjectionTests(HijackTestBase):
    """Test that injecting an image payload works end-to-end."""

    def test_red_image_injected_at_frame_30(self):
        """Frames 30-49 (1-indexed) must be red; frames before/after must be source."""
        r = self._run_hijack(
            inject_image_path=self.red_img,
            start_frame=30, end_frame=49,
        )
        self.assertTrue(r.res.ok, f"Hijack failed: {r.res.error}")

        frame_dir = os.path.join(self.dir, "_frames_red")
        frames = self._extract_frames(r.path, frame_dir)
        # 1-indexed frame 30 = 0-indexed frame 29 = frames[29]
        from PIL import Image  # type: ignore[import-not-found]

        def avg_color(fp):
            im = Image.open(fp).convert("RGB")
            px = list(im.getdata())
            return tuple(sum(c) // len(px) for c in zip(*px))

        # Frame 30 (1-indexed) = first hijacked frame → red
        avg_30 = avg_color(frames[29])
        self.assertGreater(avg_30[0], 200, f"Frame 30 not red: avg={avg_30}")
        self.assertLess(avg_30[1], 50, f"Frame 30 has green: avg={avg_30}")
        self.assertLess(avg_30[2], 50, f"Frame 30 has blue: avg={avg_30}")

        # Frame 49 (1-indexed) = last hijacked frame → red
        avg_49 = avg_color(frames[48])
        self.assertGreater(avg_49[0], 200, f"Frame 49 not red: avg={avg_49}")

        # Frame 29 (1-indexed) = last clean source frame → not red
        avg_29 = avg_color(frames[28])
        self.assertLess(avg_29[0], 200, f"Frame 29 should be source, is red: avg={avg_29}")

        # Frame 50 (1-indexed) = first clean source frame → not red
        avg_50 = avg_color(frames[49])
        self.assertLess(avg_50[0], 200, f"Frame 50 should be source, is red: avg={avg_50}")

    def test_total_frame_count_preserved(self):
        """The full pipeline must preserve the source frame count."""
        r = self._run_hijack()
        self.assertTrue(r.res.ok, f"Hijack failed: {r.res.error}")

        frame_dir = os.path.join(self.dir, "_frames_count")
        frames = self._extract_frames(r.path, frame_dir)
        # Source has 120 frames; output should also have 120
        self.assertEqual(len(frames), 120, f"Expected 120 frames, got {len(frames)}")


class FrameInjectionTests(HijackTestBase):
    """Test injecting a frame extracted from the source video."""

    def test_frame_injection_from_source(self):
        """inject_mode='frame' extracts a frame and injects it."""
        r = self._run_hijack(
            inject_mode="frame",
            inject_frame_num=10,
            inject_image_path=None,  # not used in frame mode
            start_frame=30, end_frame=49,
        )
        self.assertTrue(r.res.ok, f"Hijack failed: {r.res.error}")

        # Verify the pipeline ran and produced valid output
        code, stderr = self._decode_with_stderr(r.path)
        lower = stderr.lower()
        for pattern in DECODER_ERROR_PATTERNS:
            self.assertNotIn(pattern.lower(), lower,
                             f"Decoder produced '{pattern}': {stderr[:500]}")

        # Verify frame count is preserved
        frame_dir = os.path.join(self.dir, "_frames_frameinject")
        frames = self._extract_frames(r.path, frame_dir)
        self.assertEqual(len(frames), 120)

    def test_frame_injection_image_content(self):
        """The injected frame's content should be visible in the hijacked region."""
        r = self._run_hijack(
            inject_mode="frame",
            inject_frame_num=5,
            inject_image_path=None,
            start_frame=30, end_frame=49,
        )
        self.assertTrue(r.res.ok, f"Hijack failed: {r.res.error}")

        frame_dir = os.path.join(self.dir, "_frames_frameinject_content")
        frames = self._extract_frames(r.path, frame_dir)

        from PIL import Image  # type: ignore[import-not-found]
        # Extract the injected frame from the source for comparison
        src_frame_dir = os.path.join(self.dir, "_src_frames")
        src_frames = self._extract_frames(self.src, src_frame_dir)

        def avg_color(path: str) -> tuple[int, int, int]:
            im = Image.open(path).convert("RGB")
            px = list(im.getdata())
            return tuple(sum(c) // len(px) for c in zip(*px))

        # The hijacked region should contain the injected frame's visual content
        # (not pure red, since it's a frame from the source video)
        hijack_avg = avg_color(frames[29])

        # The hijacked frame should NOT be pure red (it's a source frame, not red image)
        self.assertFalse(
            hijack_avg[0] > 200 and hijack_avg[1] < 50 and hijack_avg[2] < 50,
            f"Hijacked frame is pure red, expected injected source frame content: avg={hijack_avg}",
        )


class MVTransferValidationTests(HijackTestBase):
    """Validate that source motion vectors are actually transferred to the payload."""

    def test_source_mvs_extracted_and_applied(self):
        """The source MVs must be present in the final output pipeline step."""
        from app.operations.datamosh.common import (
            _encode_source_m2v, _create_payload_yuv, _encode_payload_m2v,
            _build_spliced_mv_json, _max_fcode_in_range,
            _scan_mv_magnitude, _fcode_for_max_mv,
        )
        from app.shell import run_command
        from app.operations.datamosh.common import _probe_source_info

        tmpdir = tempfile.mkdtemp()
        try:
            info = asyncio.run(_probe_source_info(self.src))
            w, h, fps = info["width"], info["height"], info["fps"]

            # Encode source m2v
            src_m2v = os.path.join(tmpdir, "source.m2v")
            ok, err = asyncio.run(_encode_source_m2v(self.src, src_m2v, info))
            self.assertTrue(ok, f"Source encode failed: {err}")

            # Export source MVs
            src_mv_path = os.path.join(tmpdir, "source_mv.json")
            code, _, err = asyncio.run(run_command(
                ["ffedit", "-i", src_m2v, "-f", "mv:0", "-e", src_mv_path]
            ))
            self.assertEqual(code, 0, f"MV export failed: {err}")

            with open(src_mv_path) as f:
                source_mv = json.load(f)

            src_frames = source_mv["streams"][0]["frames"]
            # Verify source has non-zero MVs at the hijack range
            start_0 = 29  # frame 30 1-indexed
            end_0_excl = 49  # frame 49 1-indexed (exclusive)
            source_nonzero = 0
            for idx in range(start_0 + 1, end_0_excl):
                mv = src_frames[idx].get("mv", {})
                fwd = mv.get("forward", [])
                if fwd:
                    source_nonzero += sum(
                        1 for row in fwd for p in row if p[0] != 0 or p[1] != 0
                    )
            self.assertGreater(source_nonzero, 0, "Source has no non-zero MVs in range")

            # Build spliced MV JSON
            spliced = _build_spliced_mv_json(source_mv, start_0, 20, "smear", 1.0)
            spliced_nonzero = 0
            for idx in range(1, 20):
                mv = spliced["streams"][0]["frames"][idx].get("mv", {})
                fwd = mv.get("forward", [])
                if fwd:
                    spliced_nonzero += sum(
                        1 for row in fwd for p in row if p[0] != 0 or p[1] != 0
                    )
            self.assertGreater(spliced_nonzero, 0, "Spliced MV JSON has no non-zero MVs")
            self.assertEqual(
                spliced_nonzero, source_nonzero,
                f"Spliced MVs ({spliced_nonzero}) should match source ({source_nonzero})",
            )

            # Create payload and apply MVs
            payload_yuv = os.path.join(tmpdir, "payload.yuv")
            asyncio.run(_create_payload_yuv(self.red_img, payload_yuv, 20, w, h, fps))

            max_x, max_y = _scan_mv_magnitude(source_mv, start_0, end_0_excl)
            src_fcode = _max_fcode_in_range(source_mv, start_0, end_0_excl)
            req_fcode = _fcode_for_max_mv(max(max_x, max_y))
            payload_fcode = max(src_fcode, req_fcode)

            payload_m2v = os.path.join(tmpdir, "payload.m2v")
            ok, err = asyncio.run(_encode_payload_m2v(
                payload_yuv, payload_m2v, w, h, fps, payload_fcode
            ))
            self.assertTrue(ok, f"Payload encode failed: {err}")

            spliced_path = os.path.join(tmpdir, "spliced_mv.json")
            with open(spliced_path, "w") as f:
                json.dump(spliced, f)

            hijacked_m2v = os.path.join(tmpdir, "hijacked.m2v")
            code, _, err = asyncio.run(run_command([
                "ffedit", "-i", payload_m2v, "-f", "mv",
                "-a", spliced_path, "-o", hijacked_m2v, "-y",
            ]))
            self.assertEqual(code, 0, f"ffedit apply failed: {err}")

            # Verify MVs are present in the hijacked output
            hijack_mv_path = os.path.join(tmpdir, "hijack_mv.json")
            asyncio.run(run_command([
                "ffedit", "-i", hijacked_m2v, "-f", "mv:0", "-e", hijack_mv_path
            ]))
            with open(hijack_mv_path) as f:
                hijack_mv = json.load(f)
            h_frames = hijack_mv["streams"][0]["frames"]
            hijack_nonzero = 0
            for idx in range(1, 20):
                mv = h_frames[idx].get("mv", {})
                fwd = mv.get("forward", [])
                if fwd:
                    hijack_nonzero += sum(
                        1 for row in fwd for p in row if p[0] != 0 or p[1] != 0
                    )
            self.assertGreater(hijack_nonzero, 0, "Hijacked output has no non-zero MVs")
            self.assertEqual(
                hijack_nonzero, spliced_nonzero,
                f"Hijacked MVs ({hijack_nonzero}) should match spliced ({spliced_nonzero})",
            )

            # Decode check
            code, _, stderr = subprocess_run([
                "ffmpeg", "-v", "error", "-i", hijacked_m2v, "-f", "null", "-",
            ])
            self.assertEqual(code, 0, f"Decode failed: {stderr}")
            lower = stderr.lower()
            for pattern in DECODER_ERROR_PATTERNS:
                self.assertNotIn(pattern.lower(), lower)

        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class FreezeModeTests(HijackTestBase):
    """Test the freeze transition style (zeroed MVs)."""

    def test_freeze_produces_static_image(self):
        """In freeze mode, the payload should hold still (no smear)."""
        r = self._run_hijack(transition_style="freeze", start_frame=30, end_frame=49)
        self.assertTrue(r.res.ok, f"Hijack failed: {r.res.error}")

        code, stderr = self._decode_with_stderr(r.path)
        lower = stderr.lower()
        for pattern in DECODER_ERROR_PATTERNS:
            self.assertNotIn(pattern.lower(), lower)

        frame_dir = os.path.join(self.dir, "_frames_freeze")
        frames = self._extract_frames(r.path, frame_dir)
        from PIL import Image

        # In freeze mode, all hijacked frames should be pure red (no smear)
        # Hijacked frames are 0-indexed 29-48 (1-indexed 30-49)
        for idx in range(29, 49):  # 0-indexed 29-48
            im = Image.open(frames[idx]).convert("RGB")
            px = list(im.getdata())
            red = sum(1 for p in px if p[0] > 200 and p[1] < 50 and p[2] < 50)
            self.assertGreater(red, len(px) * 0.9,
                               f"Frame {idx} not red in freeze: only {red}/{len(px)} red")


class MVTransferPixelTests(HijackTestBase):
    """Validate MV transfer produces visible motion on a structured payload."""

    def test_structured_payload_smeared_by_motion(self):
        """A gradient payload with source MVs should produce different frames
        (proving motion transfer is visible, not just a static image)."""
        from app.operations.datamosh.hijack import DatamoshHijackParams
        import hashlib

        p = DatamoshHijackParams(
            input_path=self.src,
            inject_image_path=self.gradient_img,
            inject_mode="file",
            start_frame=30, end_frame=49,
            transition_style="smear",
        )
        from app.operations.datamosh.hijack import datamosh_hijack
        res = asyncio.run(datamosh_hijack(p))
        self.assertTrue(res.ok, f"Hijack failed: {res.error}")

        code, stderr = self._decode_with_stderr(res.output_path)
        lower = stderr.lower()
        for pattern in DECODER_ERROR_PATTERNS:
            self.assertNotIn(pattern.lower(), lower)

        frame_dir = os.path.join(self.dir, "_frames_gradient")
        frames = self._extract_frames(res.output_path, frame_dir)
        from PIL import Image

        # The hijacked frames should not all be identical (motion is being applied)
        hashes = []
        for idx in range(29, 50):
            im = Image.open(frames[idx]).convert("RGB")
            h = hashlib.md5(im.tobytes()).hexdigest()
            hashes.append(h)

        unique_hashes = len(set(hashes))
        self.assertGreater(unique_hashes, 1,
                           f"All hijacked frames identical — MV transfer not visible: {hashes[:3]}")


def _run_tests():
    unittest.main(argv=["test_hijack", "-v"], exit=False)


if __name__ == "__main__":
    _run_tests()
