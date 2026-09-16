import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parents[1]))

from app.video_pipeline import scan_vfr_paths


def test_scan_vfr_paths_is_read_only_and_deduplicates(tmp_path):
    async def fake_probe(path):
        return {
            "is_vfr_guess": True,
            "fps": 60.0,
            "fps_avg": 24.12,
            "fps_r": 60.0,
            "duration": 5.0,
            "frame_count": 121,
        }

    path = tmp_path / "vfr-scan-test.mp4"
    path.write_bytes(b"fixture")
    rows = asyncio.run(scan_vfr_paths([path, path], probe_fn=fake_probe))
    assert len(rows) == 1
    assert rows[0]["ok"] is True
    assert rows[0]["is_vfr_guess"] is True
    assert rows[0]["fps_avg"] == 24.12
