"""digicam_2000s + scripts catalog: core, filter, op, catalog recovery."""
import asyncio
import io
import json
import subprocess

import numpy as np
import pytest
from PIL import Image

from app import digicam_core as core
from app.digicam_core import DigicamParams
from app.contract import REGISTRY


def _tiny(color=(120, 100, 80), size=(64, 48)) -> Image.Image:
    return Image.new("RGB", size, color)


def _small_params(**kw) -> DigicamParams:
    args: dict = {"width": 64, "height": 48, "jpeg_passes": 1}
    args.update(kw)
    return DigicamParams(**args)


# ── determinism ──────────────────────────────────────────────────────────

def test_determinism_same_seed_identical():
    p = _small_params(deterministic=True, noise_seed=2003)
    a = core.process_pil(_tiny(), p, seed=2003)
    b = core.process_pil(_tiny(), p, seed=2003)
    assert np.array_equal(np.array(a), np.array(b))


def test_determinism_seed_plus_one_differs():
    p = _small_params(deterministic=True, noise_seed=2003)
    a = core.process_pil(_tiny(), p, seed=2003)
    c = core.process_pil(_tiny(), p, seed=2004)
    assert not np.array_equal(np.array(a), np.array(c))


def test_no_random_module_use():
    src = __import__("pathlib").Path(core.__file__).read_text(encoding="utf-8")
    assert "import random" not in src
    assert "np.random.seed(" not in src


# ── each apply_* smoke ───────────────────────────────────────────────────

def test_each_stage_smoke():
    p = DigicamParams(width=64, height=48, jpeg_passes=1, stuck_pixels=2,
                      chroma_aberration=1.0, barrel_distortion=0.1,
                      vertical_banding=1.0, timestamp_enabled=True,
                      interlace=True, tint_strength=0.5, gamma=1.2,
                      pixelate=2)
    img = _tiny(size=(96, 72))
    rng = np.random.default_rng(7)
    assert core.apply_resolution(img, p).size == (64, 48)
    assert core.apply_blur(img, p, rng).size == img.size
    assert core.apply_color(img, p).size == img.size
    assert core.apply_noise(img, p, rng).size == img.size
    assert core.apply_flash(img, p).size == img.size
    assert core.apply_ccd_defects(img, p, rng).size == img.size
    assert core.apply_barrel(img, 0.2).size == img.size
    assert core.apply_compression(img, p).size == img.size
    assert core.apply_timestamp(img, p).size == img.size
    assert core.apply_interlace(img, p).size == img.size


def test_luma_only_forces_chroma_zero():
    base = dict(width=64, height=48, noise_amount=22.0,
                chroma_r_amount=10.0, chroma_b_amount=8.0, noise_seed=11)
    p_luma = DigicamParams(grain_type="luma_only", **base)
    p_zero = DigicamParams(grain_type="gaussian", chroma_r_amount=0,
                           chroma_b_amount=0, **{k: v for k, v in base.items()
                                                 if k not in ("chroma_r_amount", "chroma_b_amount")})
    rng1 = np.random.default_rng(11)
    rng2 = np.random.default_rng(11)
    a = core.apply_noise(_tiny(), p_luma, rng1)
    b = core.apply_noise(_tiny(), p_zero, rng2)
    assert np.array_equal(np.array(a), np.array(b))


def test_jpeg_passes_all_valid():
    for passes in (1, 2, 3, 4, 5):
        p = _small_params(jpeg_passes=passes)
        out = core.apply_compression(_tiny(), p)
        assert out.size == (64, 48)


def test_timestamp_hex_and_pos():
    p = _small_params(timestamp_enabled=True, timestamp_text="X",
                      timestamp_color="#FF0000", timestamp_pos="top_left")
    assert core.apply_timestamp(_tiny(), p).size == (64, 48)
    assert core.parse_hex_color("#FFE600") == (255, 230, 0)
    assert core.parse_hex_color("bogus") == (255, 230, 0)
    # bad color never crashes
    p2 = _small_params(timestamp_enabled=True, timestamp_color="zzz")
    assert core.apply_timestamp(_tiny(), p2).size == (64, 48)


def test_params_from_dict_preset_and_coercion():
    p = core.params_from_dict({"preset": "vga", "noise_enabled": "0",
                               "deterministic": "1", "timestamp_color": "#FFE600"})
    assert (p.width, p.height) == (640, 480)
    assert p.noise_enabled is False and p.deterministic is True
    p2 = core.params_from_dict({"preset": "custom", "width": "99", "height": "88"})
    assert (p2.width, p2.height) == (99, 88)


# ── filter 1:1 ───────────────────────────────────────────────────────────

def test_filter_frame_mapping(tmp_path):
    from app.filters.digicam import make_digicam_filter

    fin = tmp_path / "frames_in"
    fout = tmp_path / "frames_out"
    fin.mkdir()
    for i in range(3):
        _tiny().save(fin / f"frame_{i:06d}.png")
    fn = make_digicam_filter(width=64, height=48, jpeg_passes=1,
                             deterministic=True, noise_seed=5)
    assert fn.kind == "per_frame"

    async def go():
        for i, src in enumerate(sorted(fin.glob("frame_*.png"))):
            await fn(src, fout / src.name, i)

    asyncio.run(go())
    assert sorted(p.name for p in fout.glob("frame_*.png")) == [
        "frame_000000.png", "frame_000001.png", "frame_000002.png",
    ]


# ── op: dry-run / image / registry ───────────────────────────────────────

def test_registry_has_op():
    import app.operations  # noqa: F401 (side effect)
    assert "digicam_2000s" in REGISTRY


def test_op_dry_run_no_file(tmp_path):
    from app.operations.digicam_ops import DigicamParams as OpParams, digicam_2000s

    src = tmp_path / "photo.png"
    _tiny().save(src)
    p = OpParams(input_path=str(src), dry_run=True, width=64, height=48)
    res = asyncio.run(digicam_2000s(p))
    assert res.ok is True and res.dry_run is True
    assert res.output_path and res.output_path.endswith(".jpg")
    assert not __import__("pathlib").Path(res.output_path).exists()


def test_op_tiny_image_run(tmp_path):
    from app.operations.digicam_ops import DigicamParams as OpParams, digicam_2000s

    src = tmp_path / "photo.png"
    _tiny(size=(96, 72)).save(src)
    p = OpParams(input_path=str(src), dry_run=False, width=64, height=48,
                 jpeg_passes=1, noise_amount=5.0)
    res = asyncio.run(digicam_2000s(p))
    assert res.ok is True, res.error
    assert res.output_path and res.output_path.endswith("_digicam.jpg")
    out = __import__("pathlib").Path(res.output_path)
    assert out.is_file() and out.stat().st_size > 0
    assert Image.open(out).size == (64, 48)


def test_op_video_run(tmp_path):
    from app.operations.digicam_ops import DigicamParams as OpParams, digicam_2000s

    src = tmp_path / "clip.mp4"
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=0.3",
         "-pix_fmt", "yuv420p", str(src)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    p = OpParams(input_path=str(src), dry_run=False, width=64, height=48,
                 jpeg_passes=1, noise_amount=5.0)
    res = asyncio.run(digicam_2000s(p))
    assert res.ok is True, (res.error, res.stderr)
    out = __import__("pathlib").Path(res.output_path or "")
    assert out.suffix == ".mp4" and out.is_file() and out.stat().st_size > 0


# ── catalog ──────────────────────────────────────────────────────────────

def test_catalog_load_validate(tmp_path):
    from app import scripts_catalog as cat

    scripts = cat.load_catalog(force=True)
    assert len(scripts) == 1
    e = scripts[0]
    assert e["id"] == "digicam_2000s"
    assert e["op"] == "digicam_2000s"
    assert e["endpoint"] == "/ops/digicam_2000s"
    assert e["uses_frame_range"] is True
    names = [p["name"] for p in e["parameters"]]
    for want in ("width", "height", "noise_seed", "deterministic",
                 "jpeg_passes", "final_quality", "timestamp_color",
                 "barrel_distortion", "vertical_banding", "flash_falloff",
                 "vignette_strength", "tint_strength"):
        assert want in names, want


def test_catalog_corrupt_recovers(tmp_path, monkeypatch):
    from app import scripts_catalog as cat

    bad = tmp_path / "catalog.json"
    bad.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(cat, "_CATALOG_PATH", bad)
    cat.clear_cache()
    try:
        assert cat.load_catalog(force=True) == []
    finally:
        cat.clear_cache()


def test_catalog_route_shape():
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    res = client.get("/api/scripts/catalog")
    assert res.status_code == 200
    data = res.json()
    assert data.get("ok") is True
    assert isinstance(data.get("scripts"), list)
    assert data["scripts"] and data["scripts"][0]["id"] == "digicam_2000s"
