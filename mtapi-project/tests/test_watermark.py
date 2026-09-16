"""Watermark tab (Clean section) backend.

Covers argv builder (image vs video flags, overwrite/json/bitrate/timeout,
exactly-one of output/out-dir), the validation matrix (missing input,
planned-engine refusal, bitrate range, rel-path reject, house
never-overwrite _0001 increments), dry-run plans, --json stdout → meta
parse, node/gwr-missing installer hints, metadata inspect/strip on real
fixtures, registry contract, and the no-shell=True guard.
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
from app.operations import watermark_ops as wm  # noqa: E402
from app.operations.watermark_ops import (  # noqa: E402
    MetadataInspectParams,
    MetadataStripParams,
    WatermarkDetectParams,
    WatermarkRemoveParams,
    WatermarkSetupParams,
    build_remove_argv,
    get_watermark_status,
    metadata_inspect,
    metadata_strip,
    parse_remove_json,
    watermark_detect,
    watermark_remove,
    watermark_setup,
)


def _run(coro):
    return asyncio.run(coro)


def _run_cmd(argv: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True)


def _make_png(path: Path) -> Path:
    from PIL import Image

    Image.new("RGB", (320, 240), (30, 60, 90)).save(path)
    return path


def _make_mp4(path: Path) -> Path:
    r = _run_cmd([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30",
        "-vframes", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        str(path),
    ])
    assert r.returncode == 0, f"testsrc fixture failed: {r.stderr[-400:]}"
    return path


GWR_JSON = json.dumps({
    "input": "/abs/in.png",
    "output": "/abs/in_clean.png",
    "kind": "image",
    "meta": {"applied": True, "decisionTier": "validated-match",
             "skipReason": None},
})


# ── argv builder ──────────────────────────────────────────────────────────

def test_argv_image_minimal():
    argv = build_remove_argv("node", "/abs/gwr.mjs", "/abs/in.png",
                             "/abs/out.png", is_video=False)
    assert argv[:4] == ["node", "/abs/gwr.mjs", "remove", "/abs/in.png"]
    assert "--output" in argv and "--json" in argv
    assert "--video-bitrate-mbps" not in argv
    assert "--video-timeout-ms" not in argv
    assert "--overwrite" not in argv


def test_argv_video_flags():
    argv = build_remove_argv("node", "/abs/gwr.mjs", "/abs/in.mp4",
                             "/abs/out.mp4", overwrite=True,
                             video_bitrate_mbps=20.0, video_timeout_ms=60000,
                             is_video=True)
    assert "--overwrite" in argv
    assert argv[argv.index("--video-bitrate-mbps") + 1] == "20.0"
    assert argv[argv.index("--video-timeout-ms") + 1] == "60000"


def test_argv_no_shell_string():
    argv = build_remove_argv("node", "/abs/gwr.mjs", "/abs/in.png", "/abs/o.png")
    assert all(isinstance(a, str) for a in argv)


# ── json parse ────────────────────────────────────────────────────────────

def test_parse_remove_json_object():
    assert parse_remove_json(GWR_JSON)["meta"]["applied"] is True


def test_parse_remove_json_list_and_garbage():
    assert parse_remove_json("[" + GWR_JSON + "]")["kind"] == "image"
    assert parse_remove_json("not json{{") == {}


# ── validation matrix ─────────────────────────────────────────────────────

def test_missing_input():
    r = _run(watermark_remove(WatermarkRemoveParams(input_path="/nope/x.png")))
    assert r.ok is False and "not found" in (r.error or "")


def test_relative_input_rejected(tmp_path):
    r = _run(watermark_remove(WatermarkRemoveParams(input_path="rel/in.png")))
    assert r.ok is False and "absolute" in (r.error or "")


def test_planned_engine_refused(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(watermark_remove(WatermarkRemoveParams(
        input_path=str(src), engine="general-ai")))
    assert r.ok is False and "not installed yet" in (r.error or "")
    r = _run(watermark_detect(WatermarkDetectParams(
        input_path=str(src), engine="synthid-detect")))
    assert r.ok is False and "not installed yet" in (r.error or "")


def test_unknown_engine_refused(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(watermark_remove(WatermarkRemoveParams(
        input_path=str(src), engine="bogus")))
    assert r.ok is False and "unknown engine" in (r.error or "")


def test_bitrate_out_of_range_rejected_by_model():
    with pytest.raises(Exception):
        WatermarkRemoveParams(input_path="/abs/x.png", video_bitrate_mbps=100)


def test_output_and_outdir_exclusive(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(watermark_remove(WatermarkRemoveParams(
        input_path=str(src), output_path=str(tmp_path / "o.png"),
        out_dir=str(tmp_path))))
    assert r.ok is False and "either" in (r.error or "")


def test_collision_increments_like_everywhere_else(tmp_path):
    src = _make_png(tmp_path / "in.png")
    (tmp_path / "in_clean.png").write_bytes(b"x" * 64)
    (tmp_path / "in_clean_0001.png").write_bytes(b"x" * 64)
    r = _run(watermark_remove(WatermarkRemoveParams(
        input_path=str(src), dry_run=True)))
    assert r.ok is True and r.dry_run is True
    assert "in_clean_0002.png" in (r.stdout or "")


# ── dry run ───────────────────────────────────────────────────────────────

def test_dry_run_prints_command_writes_nothing(tmp_path):
    src = _make_png(tmp_path / "in.png")
    out = tmp_path / "in_clean.png"
    r = _run(watermark_remove(WatermarkRemoveParams(
        input_path=str(src), dry_run=True)))
    assert r.ok is True and r.dry_run is True
    assert r.command and "remove" in r.command and "--json" in r.command
    assert not out.exists()


def test_strip_dry_run(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(metadata_strip(MetadataStripParams(
        input_path=str(src), dry_run=True)))
    assert r.ok is True and r.dry_run is True
    assert not (tmp_path / "in_clean.png").exists()


def test_setup_dry_run():
    r = _run(watermark_setup(WatermarkSetupParams(action="install", dry_run=True)))
    assert r.ok is True and r.dry_run is True
    assert r.meta and r.meta.get("recommend_restart") is False
    assert "status" in (r.meta or {})


def test_setup_flat_vendor_skips_clone(tmp_path, monkeypatch):
    """Present gwr without nested .git: no clone/fetch, just dep install."""
    fake_tools = tmp_path / "gwr"
    (fake_tools / "bin").mkdir(parents=True)
    (fake_tools / "bin" / "gwr.mjs").write_text("// stub")
    monkeypatch.setattr(wm, "_tools_dir", lambda: fake_tools)
    seen: list[list[str]] = []

    async def fake_run(argv):
        seen.append(argv)
        return (0, "", "")

    with patch.object(wm, "run_command", side_effect=fake_run):
        r = _run(watermark_setup(WatermarkSetupParams(action="update")))
    assert r.ok is True
    assert not any(a[0] == "git" for a in seen), f"unexpected git phase: {seen}"
    assert any(a[0] == "npm" for a in seen)


# ── handlers with stubbed run_command ─────────────────────────────────────

def test_remove_ok_parses_meta(tmp_path):
    src = _make_png(tmp_path / "in.png")
    out = tmp_path / "custom.png"
    out.write_bytes(b"y" * 64)  # pre-existing → never clobbered, incremented
    canned = (0, GWR_JSON, "")

    async def fake_run(argv):
        assert argv[0].endswith("node") or argv[0] == "node" or "node" in argv[0]
        Path(argv[argv.index("--output") + 1]).write_bytes(b"z" * 64)
        return canned

    with patch.object(wm, "run_command", side_effect=fake_run):
        r = _run(watermark_remove(WatermarkRemoveParams(
            input_path=str(src), output_path=str(out))))
    assert r.ok is True
    assert r.output_path == str(tmp_path / "custom_0001.png")
    assert out.read_bytes() == b"y" * 64  # original untouched
    assert (r.meta or {}).get("applied") is True
    assert (r.meta or {}).get("decisionTier") == "validated-match"


def test_remove_gwr_failure(tmp_path):
    src = _make_png(tmp_path / "in.png")

    async def fake_run(argv):
        return (4, "", "boom")

    with patch.object(wm, "run_command", side_effect=fake_run):
        r = _run(watermark_remove(WatermarkRemoveParams(
            input_path=str(src), output_path=str(tmp_path / "o.png"))))
    assert r.ok is False and "exit 4" in (r.error or "")


def test_detect_reads_tier_deletes_probe(tmp_path):
    src = _make_png(tmp_path / "in.png")
    seen: dict = {}

    async def fake_run(argv):
        probe = argv[argv.index("--output") + 1]
        seen["probe"] = probe
        Path(probe).write_bytes(b"z" * 64)
        return (0, GWR_JSON, "")

    with patch.object(wm, "run_command", side_effect=fake_run):
        r = _run(watermark_detect(WatermarkDetectParams(input_path=str(src))))
    assert r.ok is True
    assert (r.meta or {}).get("watermark_found") is True
    assert (r.meta or {}).get("tier") == "validated-match"
    assert r.output_path is None
    assert not Path(seen["probe"]).exists()


def test_detect_no_watermark(tmp_path):
    src = _make_png(tmp_path / "in.png")
    payload = json.dumps({"kind": "image",
                          "meta": {"applied": False,
                                   "decisionTier": "insufficient",
                                   "skipReason": "no-watermark-detected"}})

    async def fake_run(argv):
        Path(argv[argv.index("--output") + 1]).write_bytes(b"z" * 64)
        return (0, payload, "")

    with patch.object(wm, "run_command", side_effect=fake_run):
        r = _run(watermark_detect(WatermarkDetectParams(input_path=str(src))))
    assert r.ok is True and (r.meta or {}).get("watermark_found") is False


# ── missing tools → installer hint ────────────────────────────────────────

def test_node_missing_hint(tmp_path):
    src = _make_png(tmp_path / "in.png")
    with patch.object(wm, "resolve_node", return_value=None):
        r = _run(watermark_remove(WatermarkRemoveParams(
            input_path=str(src), output_path=str(tmp_path / "o.png"))))
    assert r.ok is False and "node not found" in (r.error or "")


def test_gwr_missing_hint(tmp_path, monkeypatch):
    src = _make_png(tmp_path / "in.png")
    monkeypatch.setattr(wm, "gwr_entrypoint",
                        lambda: Path("/nonexistent/gwr.mjs"))
    r = _run(watermark_remove(WatermarkRemoveParams(
        input_path=str(src), output_path=str(tmp_path / "o.png"))))
    assert r.ok is False and "gwr" in (r.error or "").lower()


# ── metadata inspect/strip on real fixtures ───────────────────────────────

def test_metadata_inspect_image(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(metadata_inspect(MetadataInspectParams(input_path=str(src))))
    assert r.ok is True
    assert "tags" in (r.meta or {})


def test_metadata_strip_image_drops_exif(tmp_path):
    from PIL import Image

    src = tmp_path / "in.jpg"
    Image.new("RGB", (64, 48), (200, 10, 10)).save(src)
    r = _run(metadata_strip(MetadataStripParams(
        input_path=str(src), output_path=str(tmp_path / "in_clean.jpg"))))
    assert r.ok is True and r.output_path
    with Image.open(r.output_path) as im:
        assert not im.getexif()


def test_metadata_strip_video_remux(tmp_path):
    src = _make_mp4(tmp_path / "in.mp4")
    r = _run(metadata_strip(MetadataStripParams(
        input_path=str(src), output_path=str(tmp_path / "in_clean.mp4"))))
    assert r.ok is True and Path(r.output_path or "").stat().st_size > 32


# ── status + registry + shell guard ───────────────────────────────────────

def test_status_shape():
    st = get_watermark_status()
    assert st["ok"] is True
    for key in ("node", "gwr", "sharp", "pm"):
        assert key in st


def test_registry_contract():
    for op_id in ("watermark_remove", "watermark_detect", "metadata_inspect",
                  "metadata_strip", "watermark_setup"):
        assert op_id in REGISTRY, f"{op_id} not registered"


def test_no_shell_true_in_module():
    src = Path(wm.__file__).read_text(encoding="utf-8")
    assert "shell=True" not in src
