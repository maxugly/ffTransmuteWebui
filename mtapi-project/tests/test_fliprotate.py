"""
Regression tests for the Flip / Rotate operation.

Covers the shared ``-R MODE`` vocabulary in three layers:
  1. The ``transmute`` CLI flag (filter chain + auto-named suffix) as dry-runs
     plus one real 90° rotation whose dimensions must swap.
  2. The registered ``flip_rotate`` op in the contract registry.
  3. The Image Edit ``flip_rotate`` stack op on all three engines (ffmpeg /
     ImageMagick / Pillow) — green marker (source top-left) must land in the
     corner each transform promises, and 90° rotations must swap dimensions.
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
BIN_TRANSMUTE = ROOT / "bin" / "transmute"


def _run(argv: list[str], cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, cwd=cwd)


def _make_clip(path: str) -> None:
    r = _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10",
        "-vframes", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", path,
    ])
    if r.returncode != 0:
        raise RuntimeError(f"clip fixture failed: {r.stderr[-400:]}")


def _dims(path: str) -> tuple[int, int]:
    r = _run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path,
    ])
    return tuple(int(v) for v in r.stdout.strip().split("x"))


# green occupies the source top-left quadrant; red the bottom-right.
GREEN = (0, 255, 0)
RED = (255, 0, 0)
SRC_DIMS = (320, 200)
CORNER_KEY = (lambda w, h: {"tl": (2, 2), "tr": (w - 3, 2),
                            "bl": (2, h - 3), "br": (w - 3, h - 3)})


class TransmuteCliTest(unittest.TestCase):
    def test_dry_run_filters_and_suffixes(self) -> None:
        cases = {
            "rotate_90": ("transpose=1", "_r90"),
            "rotate_180": ("transpose=1,transpose=1", "_r180"),
            "rotate_270": ("transpose=2", "_r270"),
            "hflip": ("hflip", "_hflip"),
            "vflip": ("vflip", "_vflip"),
            "hflip+rotate_90": ("hflip,transpose=1", "_hflip_r90"),
        }
        tmp = Path(self._serial) / "clip.mp4"
        for mode, (vf, suffix) in cases.items():
            r = _run([str(BIN_TRANSMUTE), str(tmp), "-R", mode, "-d"])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(f"-vf {vf}", r.stdout, f"mode {mode}")
            self.assertIn(f"_{tmp.stem}_{mode}"[:0] + f"{tmp.stem}{suffix}.mp4", r.stdout)

    def test_real_rotate_90_swaps_dims(self) -> None:
        tmp = Path(self._serial) / "clip.mp4"
        r = _run([str(BIN_TRANSMUTE), str(tmp), "-R", "rotate_90"], cwd=self._serial)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = Path(self._serial) / f"{tmp.stem}_r90.mp4"
        self.assertTrue(out.exists(), r.stdout)
        self.assertEqual(_dims(str(out)), (240, 320))

    def test_bad_mode_rejected(self) -> None:
        r = _run([str(BIN_TRANSMUTE), "/nonexistent.mp4", "-R", "sideways", "-d"])
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Error: -R requires mode", r.stderr)

    @classmethod
    def setUpClass(cls) -> None:
        import tempfile
        cls._serial = tempfile.mkdtemp(prefix="fliprotate_cli_")
        _make_clip(str(Path(cls._serial) / "clip.mp4"))


class RegistrationTest(unittest.TestCase):
    def test_flip_rotate_registered(self) -> None:
        from app.operations import transmute_ops  # noqa: F401  (populates registry)
        from app.contract import REGISTRY

        spec = REGISTRY["flip_rotate"]
        self.assertIn("geometry", spec.tags)
        self.assertEqual(
            set(spec.params_model.model_fields), {"input_path", "mode", "output_path", "dry_run"}
        )
        modes = spec.params_model.model_fields["mode"]
        for want in ("rotate_90", "rotate_180", "rotate_270", "hflip", "vflip", "hflip+rotate_90"):
            self.assertIn(want, modes.annotation.__args__)


class ImageEditEnginesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        import tempfile
        cls._serial = tempfile.mkdtemp(prefix="fliprotate_img_")
        cls.src = Path(cls._serial) / "marker.png"
        marker = []
        for y in range(SRC_DIMS[1]):
            row = []
            for x in range(SRC_DIMS[0]):
                if x < SRC_DIMS[0] // 2 and y < SRC_DIMS[1] // 2:
                    row.append(GREEN)
                elif x >= SRC_DIMS[0] // 2 and y >= SRC_DIMS[1] // 2:
                    row.append(RED)
                else:
                    row.append((255, 255, 255))
            marker.append(row)
        from PIL import Image
        img = Image.new("RGB", SRC_DIMS)
        img.putdata([px for row in marker for px in row])
        img.save(cls.src)

    def _corners(self, path: str) -> tuple[tuple[int, int], dict]:
        from PIL import Image
        img = Image.open(path).convert("RGB")
        w, h = img.size
        k = CORNER_KEY(w, h)
        return img.size, {name: img.getpixel(pos) for name, pos in k.items()}

    def _run_stack(self, engine: str, mode: str) -> tuple[bool, str | None, tuple | None]:
        from app.operations.imageedit_ops import ImageEditParams, imageedit
        res = asyncio.run(imageedit(ImageEditParams(
            paths=[str(self.src)],
            output=None,
            engine=engine,
            outputFormat="png",
            stack=[{"type": "flip_rotate", "mode": mode}],
            dry_run=False,
        )))
        if not res.ok:
            return False, res.error, None
        return True, None, self._corners(res.output_path)

    def test_all_modes_all_engines(self) -> None:
        green_home = {  # where the source top-left green marker must land
            "rotate_90": "tr", "rotate_180": "br", "rotate_270": "bl",
            "hflip": "tr", "vflip": "bl", "hflip+rotate_90": "br",
        }
        swaps = {"rotate_90", "rotate_270", "hflip+rotate_90"}
        swapped_dims = (SRC_DIMS[1], SRC_DIMS[0])
        modes = list(green_home)
        for engine in ("ffmpeg", "imagemagick", "pillow"):
            for mode in modes:
                ok, err, result = self._run_stack(engine, mode)
                self.assertTrue(ok, f"{engine}/{mode}: {err}")
                self.assertIsNotNone(result)
                dims, corners = result
                self.assertEqual(dims, swapped_dims if mode in swaps else SRC_DIMS,
                                 f"{engine}/{mode}: dims")
                self.assertEqual(corners[green_home[mode]], GREEN, f"{engine}/{mode}: green corner")
                red_home = {"tl": "br", "tr": "bl", "bl": "tr", "br": "tl"}[green_home[mode]]
                self.assertEqual(corners[red_home], RED, f"{engine}/{mode}: red corner")


if __name__ == "__main__":
    unittest.main()