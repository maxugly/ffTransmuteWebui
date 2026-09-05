"""Single-clip zoom op: preset map, guards, dry-runs, stable still render."""
import asyncio

from PIL import Image

from app.contract import REGISTRY
from app.operations.zoom_ops import (
    ZoomParams, _check_expr, build_raw_expressions, build_raw_vf, zoom_run,
)


def test_registered():
    assert "zoom" in REGISTRY
    assert REGISTRY["zoom"].params_model is ZoomParams


def test_preset_map_spot_checks():
    base = dict(input_path="/tmp/x.png")
    z, _, _, _ = build_raw_expressions(ZoomParams(**{**base, "preset": "zoom_in"}))
    assert "1+" in z and "*on" in z
    z, _, _, _ = build_raw_expressions(ZoomParams(**{**base, "preset": "kenburns"}))
    assert "0.005" in z
    z, _, _, _ = build_raw_expressions(ZoomParams(**{**base, "preset": "punch", "punch_frame": 20}))
    assert "if(lt(on,20)" in z
    z, x, y, extra = build_raw_expressions(
        ZoomParams(**{**base, "preset": "targeted", "target_x": 200, "target_y": 300}))
    assert x == "200-(iw/zoom/2)" and y == "300-(ih/zoom/2)"
    z, _, _, extra = build_raw_expressions(
        ZoomParams(**{**base, "preset": "spiral", "rotate_rate": 0.01}))
    assert "rotate=on*0.01" in extra
    z, _, _, _ = build_raw_expressions(
        ZoomParams(**{**base, "preset": "glitch", "glitch_amt": 0.1}))
    assert "random(1)" in z
    _, _, _, extra = build_raw_expressions(ZoomParams(**{**base, "preset": "hue_cycle"}))
    assert "{HUE}" in extra
    vf = build_raw_vf(ZoomParams(**{**base, "preset": "hue_cycle", "hue_cycle": True}), 960, 960)
    assert "hue=h=on*" in vf and "s=960x960" in vf


def test_expr_guard_rejects_injection():
    assert not _check_expr("1+on; rm -rf /")
    assert not _check_expr("system('id')")
    assert _check_expr("min(1+0.02*on,3)+sin(on/10)*50")


def test_dry_run_still_raw(tmp_path):
    img = tmp_path / "in.png"
    Image.new("RGB", (64, 64), (10, 20, 30)).save(img)
    p = ZoomParams(input_path=str(img), engine="raw", preset="zoom_in",
                   duration_sec=1.0, fps=8, output_width=32, output_height=32, dry_run=True)
    res = asyncio.run(zoom_run(p))
    assert res.ok and res.dry_run
    assert "-loop" in (res.command or "") and "zoompan" in (res.command or "")


def test_stable_still_renders(tmp_path):
    img = tmp_path / "in.png"
    Image.new("RGB", (64, 48), (200, 30, 30)).save(img)
    out = tmp_path / "out.mp4"
    p = ZoomParams(input_path=str(img), output_path=str(out), engine="stable",
                   preset="zoom_in", duration_sec=0.5, fps=8,
                   output_width=32, output_height=32)
    res = asyncio.run(zoom_run(p))
    assert res.ok, res.error
    assert out.is_file() and out.stat().st_size > 32


def test_stable_video_rejected(tmp_path):
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"\x00" * 64)
    p = ZoomParams(input_path=str(clip), engine="stable", dry_run=True)
    res = asyncio.run(zoom_run(p))
    assert not res.ok and "still-image only" in (res.error or "")


def test_bad_input_ok_false(tmp_path):
    p = ZoomParams(input_path=str(tmp_path / "nope.png"), dry_run=True)
    res = asyncio.run(zoom_run(p))
    assert not res.ok


def test_raw_fx_need_raw_in_stable(tmp_path):
    img = tmp_path / "in.png"
    Image.new("RGB", (32, 32)).save(img)
    p = ZoomParams(input_path=str(img), engine="stable", preset="spiral",
                   rotate_rate=0.01, dry_run=True)
    res = asyncio.run(zoom_run(p))
    assert not res.ok and "raw-engine only" in (res.error or "")
