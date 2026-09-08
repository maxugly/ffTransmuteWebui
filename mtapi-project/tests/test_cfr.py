"""Single-clip VFR → CFR (+ optional RIFE) op.

Covers FPS resolve (Auto avg wins / garbage-avg r fallback / explicit wins),
the cfr_first-without-RIFE coercion, dry-run plans for all three paths,
registry contract, output suffixes + self-collision guard, and a real
CFR-only encode on a testsrc clip.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.contract import REGISTRY  # noqa: E402
from app.operations.cfr_ops import (  # noqa: E402
    CfrParams,
    _effective_cfr_first,
    _effective_pts_aware,
    cfr_normalize,
    resolve_cfr_fps,
)
from app.filters.rife_pts import plan_rife_pts, quantize_timestep  # noqa: E402
from app.video_pipeline import pts_map  # noqa: E402


def _run(argv: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True)


def _make_testsrc(path: Path, n_frames: int = 48, fps: str = "30") -> Path:
    r = _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=size=320x240:rate={fps}",
        "-vframes", str(n_frames),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        str(path),
    ])
    assert r.returncode == 0, f"testsrc fixture failed: {r.stderr[-400:]}"
    return path


def _rates(path: Path) -> tuple[str, str]:
    r = _run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate,avg_frame_rate",
        "-of", "json", str(path),
    ])
    data = json.loads(r.stdout or "{}")
    s0 = (data.get("streams") or [{}])[0]
    return s0.get("r_frame_rate"), s0.get("avg_frame_rate")


# ── FPS resolve ────────────────────────────────────────────────────────────

def test_auto_prefers_avg():
    assert resolve_cfr_fps({"fps_avg": 29.97, "fps": 30.0, "fps_r": 30.0}, None) == pytest.approx(29.97)


def test_auto_falls_back_to_r_on_garbage_avg():
    # avg_frame_rate "0/0" probes as 0.0 → r wins.
    assert resolve_cfr_fps({"fps_avg": 0.0, "fps": 30.0, "fps_r": 30.0}, None) == pytest.approx(30.0)


def test_auto_nothing_sane_returns_none():
    assert resolve_cfr_fps({"fps_avg": 0.0, "fps": 0.0, "fps_r": 0.0}, None) is None


def test_explicit_fps_wins_over_avg():
    assert resolve_cfr_fps({"fps_avg": 29.97, "fps": 30.0, "fps_r": 30.0}, 24.0) == pytest.approx(24.0)


# ── cfr_first coercion ─────────────────────────────────────────────────────

def test_cfr_first_without_rife_coerced_false():
    assert _effective_cfr_first(False, True) is False
    assert _effective_cfr_first(False, False) is False
    assert _effective_cfr_first(True, True) is True
    assert _effective_cfr_first(True, False) is False


# ── Registry ───────────────────────────────────────────────────────────────

def test_registered():
    assert "cfr" in REGISTRY
    assert REGISTRY["cfr"].params_model is CfrParams


def test_bad_input_is_ok_false(tmp_path):
    p = CfrParams(input_path=str(tmp_path / "nope.mp4"), dry_run=True)
    res = asyncio.run(cfr_normalize(p))
    assert not res.ok


# ── Dry runs: all three paths ──────────────────────────────────────────────

def test_dry_run_path_a_cfr_only(tmp_path):
    clip = _make_testsrc(tmp_path / "vfrish.mp4")
    p = CfrParams(input_path=str(clip), target_fps=24.0, dry_run=True)
    res = asyncio.run(cfr_normalize(p))
    assert res.ok and res.dry_run, res.error
    assert "fps=24" in (res.command or "")
    assert "-fps_mode" in (res.command or "") and "cfr" in (res.command or "")
    assert "rife" not in (res.command or "").lower()
    assert (res.meta or {}).get("path") == "A"
    assert (res.meta or {}).get("cfr_first") is False  # coerced: no RIFE
    assert str(res.output_path).endswith("_cfr.mp4")
    assert not Path(str(res.output_path)).exists()  # dry run writes nothing


def test_dry_run_path_b_rife_cfr_first(tmp_path):
    clip = _make_testsrc(tmp_path / "vfrish.mp4")
    p = CfrParams(input_path=str(clip), target_fps=24.0, use_rife=True,
                  pts_aware=False, cfr_first=True, dry_run=True)
    with patch("app.filters.rife.resolve_rife_bin", return_value="/usr/bin/rife-ncnn-vulkan"):
        res = asyncio.run(cfr_normalize(p))
    assert res.ok and res.dry_run, res.error
    assert "# stage: cfr (directory)" in (res.stdout or "")
    assert "# stage: rife (directory)" in (res.stdout or "")
    assert (res.meta or {}).get("path") == "B"
    assert str(res.output_path).endswith("_cfr_rife.mp4")
    assert not Path(str(res.output_path)).exists()


def test_dry_run_path_c_rife_direct(tmp_path):
    clip = _make_testsrc(tmp_path / "vfrish.mp4")
    p = CfrParams(input_path=str(clip), target_fps=24.0, use_rife=True,
                  pts_aware=False, cfr_first=False, dry_run=True)
    with patch("app.filters.rife.resolve_rife_bin", return_value="/usr/bin/rife-ncnn-vulkan"):
        res = asyncio.run(cfr_normalize(p))
    assert res.ok and res.dry_run, res.error
    assert "# stage: cfr (directory)" not in (res.stdout or "")
    assert "# stage: rife (directory)" in (res.stdout or "")
    assert (res.meta or {}).get("path") == "C"
    assert (res.meta or {}).get("cfr_first") is False


# ── Suffix + self-collision ────────────────────────────────────────────────

def test_explicit_output_equal_to_input_never_overwrites(tmp_path):
    clip = _make_testsrc(tmp_path / "vfrish.mp4")
    p = CfrParams(input_path=str(clip), output_path=str(clip),
                  target_fps=24.0, dry_run=True)
    res = asyncio.run(cfr_normalize(p))
    assert res.ok, res.error
    assert Path(str(res.output_path)).resolve() != clip.resolve()


# ── Real CFR-only encode ───────────────────────────────────────────────────

def test_real_cfr_only_encode_is_cfr(tmp_path):
    clip = _make_testsrc(tmp_path / "vfrish.mp4")
    out = tmp_path / "out.mp4"
    p = CfrParams(input_path=str(clip), output_path=str(out), target_fps=24.0)
    res = asyncio.run(cfr_normalize(p))
    assert res.ok, res.error
    assert out.is_file() and out.stat().st_size > 32
    r_rate, avg_rate = _rates(out)
    assert r_rate == avg_rate, f"output not CFR: r={r_rate} avg={avg_rate}"


# ── PTS-aware Path D ───────────────────────────────────────────────────────

def test_pts_aware_without_rife_coerced_false():
    assert _effective_pts_aware(False, True) is False
    assert _effective_pts_aware(True, True) is True


def test_t_step_validator_bounds():
    import pydantic
    with pytest.raises(pydantic.ValidationError):
        CfrParams(input_path="/tmp/x.mp4", t_step=1.5)
    with pytest.raises(pydantic.ValidationError):
        CfrParams(input_path="/tmp/x.mp4", t_step=-0.1)
    assert CfrParams(input_path="/tmp/x.mp4", t_step=0.0).t_step == 0.0


def test_quantize_grid():
    assert quantize_timestep(0.3, 0.25) == pytest.approx(0.25)
    assert quantize_timestep(0.4, 0.25) == pytest.approx(0.5)
    assert quantize_timestep(0.37, 0.0) == pytest.approx(0.37)  # exact
    assert quantize_timestep(0.99, 0.25) == pytest.approx(1.0)
    assert quantize_timestep(2.0, 0.25) == pytest.approx(1.0)  # clamped


def test_plan_brackets_uneven_pts():
    # Unevenly spaced sources: targets must bracket true pairs, exact t.
    pts = [0.0, 0.033, 0.1, 0.2, 0.233]
    plan = plan_rife_pts(pts, 30.0, t_step=0.0)
    assert plan["num_targets"] == 7  # round(0.233*30)
    first = plan["targets"][0]
    assert first["action"] == "copy" and first["a"] == 0
    mids = [t for t in plan["targets"] if t["action"] == "infer"]
    assert mids, "expected interpolated targets"
    for m in mids:
        a, b = m["a"], m["b"]
        assert b == a + 1
        expect = (m["t"] - pts[a]) / (pts[b] - pts[a])
        assert m["t_q"] == pytest.approx(expect)


def test_plan_discontinuity_copies_without_inference():
    # 2s jump mid-clip = cut: targets inside the gap copy, never infer.
    pts = [0.0, 0.033, 0.066, 2.1, 2.133, 2.166]
    plan = plan_rife_pts(pts, 30.0, t_step=0.0)
    gap_targets = [t for t in plan["targets"] if 0.066 < t["t"] < 2.1]
    assert gap_targets, "expected targets inside the cut gap"
    assert all(t["action"] == "copy" for t in gap_targets)


def test_pts_map_reads_real_gaps_sorted(tmp_path):
    src = _make_testsrc(tmp_path / "dense.mp4", n_frames=30, fps="30")
    sparse = tmp_path / "sparse.mp4"
    r = _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src), "-vf", "select='lt(mod(n\\,10)\\,3)'",
        "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        str(sparse),
    ])
    assert r.returncode == 0
    info = asyncio.run(pts_map(str(sparse)))
    pts = info["pts"]
    assert info["count"] == len(pts) > 0
    assert pts == sorted(pts)
    gaps = [b - a for a, b in zip(pts, pts[1:])]
    assert max(gaps) > 2 * min(gaps), "fixture is not actually VFR"


def test_dry_run_path_d_pts_aware(tmp_path):
    clip = _make_testsrc(tmp_path / "vfrish.mp4")
    p = CfrParams(input_path=str(clip), target_fps=24.0, use_rife=True,
                  pts_aware=True, dry_run=True)
    with patch("app.filters.rife.resolve_rife_bin", return_value="/usr/bin/rife-ncnn-vulkan"):
        res = asyncio.run(cfr_normalize(p))
    assert res.ok and res.dry_run, res.error
    assert "inferred" in (res.stdout or "") and "copied" in (res.stdout or "")
    assert (res.meta or {}).get("path") == "D"
    assert (res.meta or {}).get("pts_aware") is True
    assert str(res.output_path).endswith("_cfr_pts.mp4")
    assert not Path(str(res.output_path)).exists()


def test_pts_png_count_mismatch_ok_false(tmp_path):
    from PIL import Image
    from app.filters.rife_pts import run_rife_pts_directory
    src = tmp_path / "frames"
    src.mkdir()
    for i in range(2):
        Image.new("RGB", (16, 16), (i * 40, 0, 0)).save(src / f"frame_{i:06d}.png")
    with pytest.raises(RuntimeError, match="count mismatch"):
        asyncio.run(run_rife_pts_directory(
            src, tmp_path / "out", target_fps=10.0,
            pts=[0.0, 0.1, 0.2],  # 3 PTS vs 2 PNGs
        ))


def test_single_pair_timestep_monotonic(tmp_path):
    """Regression: rife-v4.6 honors -s (box lands at fractional position)."""
    from PIL import Image, ImageDraw
    from app.filters.rife import run_rife_single_pair
    a = tmp_path / "a.png"
    b = tmp_path / "b.png"
    for path, bx in ((a, 20), (b, 100)):
        im = Image.new("RGB", (160, 120), (128, 128, 128))
        ImageDraw.Draw(im).rectangle([bx, 20, bx + 30, 50], fill=(255, 0, 0))
        im.save(path)

    def mean_x(p):
        im = Image.open(p).convert("RGB")
        xs = [x for y in range(20, 51) for x in range(160)
              if (lambda px: px[0] > 150 and px[1] < 100 and px[2] < 100)(im.getpixel((x, y)))]
        assert xs, f"no red box found in {p}"
        return sum(xs) / len(xs)

    outs = {}
    for t in (0.1, 0.5, 0.9):
        o = tmp_path / f"out_{t}.png"
        res = asyncio.run(run_rife_single_pair(a, b, o, timestep=t, model="rife-v4.6"))
        assert res["timestep"] == pytest.approx(t)
        outs[t] = mean_x(o)
    assert outs[0.1] < outs[0.5] < outs[0.9], outs
    assert 35.0 < outs[0.1] < 75.0 < outs[0.9] < 115.0, outs
