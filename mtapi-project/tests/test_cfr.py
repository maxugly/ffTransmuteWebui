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
    cfr_normalize,
    resolve_cfr_fps,
)


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
                  cfr_first=True, dry_run=True)
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
                  cfr_first=False, dry_run=True)
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
