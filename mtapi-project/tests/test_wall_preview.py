"""Wall preview is a 120px display JPEG, separate from match/first/last thumbs."""
from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from app.media.config import WALL_WIDTH
from app.media.thumbnails import _write_wall_from_image, _write_wall_pair, ensure_wall_preview


def _jpeg(path: Path, w: int = 480, h: int = 270, color=(20, 80, 160)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (w, h), color).save(path, "JPEG", quality=90)


class WallPreviewTests(unittest.TestCase):
    def test_resize_from_first_frame_is_120_wide(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "first_H.jpg"
            dest = Path(tmp) / "wall.jpg"
            _jpeg(src)
            self.assertTrue(_write_wall_from_image(src, dest))
            with Image.open(dest) as im:
                self.assertEqual(im.size[0], WALL_WIDTH)
                self.assertGreater(im.size[1], 0)

    def test_missing_source_does_not_invent_wall(self):
        result = asyncio.run(ensure_wall_preview("0" * 32, generate_from_video=False))
        self.assertIsNone(result)

    def test_pair_is_first_and_last_side_by_side(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "first.jpg"
            last = Path(tmp) / "last.jpg"
            dest = Path(tmp) / "wall_pair.jpg"
            _jpeg(first, 480, 270, (200, 30, 30))
            _jpeg(last, 480, 270, (30, 30, 200))
            self.assertTrue(_write_wall_pair(first, last, dest))
            with Image.open(dest) as im:
                self.assertEqual(im.size[0], WALL_WIDTH * 2)
                self.assertGreater(im.size[1], 0)
                left = im.getpixel((10, im.size[1] // 2))
                right = im.getpixel((WALL_WIDTH + 10, im.size[1] // 2))
                self.assertGreater(left[0], right[0])
                self.assertGreater(right[2], left[2])


if __name__ == "__main__":
    unittest.main()
