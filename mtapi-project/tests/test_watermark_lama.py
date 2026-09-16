"""Watermark LaMA inpaint mode (engine #2) backend.

Covers the rect validation matrix (out-of-range, zero-area, >25% refuse,
rel-path reject, output/output-dir exclusivity, house never-overwrite _0001
increments), dry-run plans, odd-dim pad/crop round-trip, missing-IR setup
hint, image-path success via a fake compiled model, the no-shell=True guard,
and the registry contract. V1 file (test_watermark.py) is untouched.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.contract import REGISTRY  # noqa: E402
from app.filters import lama as lama_filter  # noqa: E402
from app.operations import watermark_lama_ops as wl  # noqa: E402
from app.operations.watermark_lama_ops import (  # noqa: E402
    WatermarkLamaRemoveParams,
    WatermarkLamaSetupParams,
    get_lama_status,
    watermark_lama_remove,
    watermark_lama_setup,
)


def _run(coro):
    return asyncio.run(coro)


def _make_png(path: Path, w: int = 320, h: int = 240) -> Path:
    from PIL import Image

    Image.new("RGB", (w, h), (30, 60, 90)).save(path)
    return path


def _params(input_path: str, **kw) -> WatermarkLamaRemoveParams:
    base = dict(mask_x=0.80, mask_y=0.84, mask_w=0.17, mask_h=0.12)
    base.update(kw)
    return WatermarkLamaRemoveParams(input_path=input_path, **base)


# ── rect validation matrix ────────────────────────────────────────────────

def test_rect_out_of_range_rejected_by_model():
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", mask_x=1.5)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", mask_w=0.0)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", feather_px=9)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", device="TPU")
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", margin_px=300)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", margin_px=-1)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", blend="dream")
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", sharpen=2.5)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", sharpen_radius=0.1)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", grow_px=17)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", upscale=0.5)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", upscale=5.0)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", mask_thresh=0.05)
    with pytest.raises(Exception):
        WatermarkLamaRemoveParams(input_path="/abs/x.png", precision="int8")


def test_finish_defaults():
    p = WatermarkLamaRemoveParams(input_path="/abs/x.png")
    assert (p.blend, p.sharpen, p.grow_px, p.upscale) == ("linear", 0.0, 0, 1.0)
    assert (p.precision, p.color_match, p.mask_thresh) == ("fp16", False, 0.5)


def test_grow_expands_mask():
    import numpy as np

    base = lama_filter.rasterize_mask(320, 240, (0.45, 0.40, 0.10, 0.15), 1, 0)
    grown = lama_filter.rasterize_mask(320, 240, (0.45, 0.40, 0.10, 0.15), 1, 4)
    assert grown.sum() > base.sum() > 0
    assert grown.shape == base.shape


def test_margin_default_32():
    p = WatermarkLamaRemoveParams(input_path="/abs/x.png")
    assert p.margin_px == 32


def test_oversize_rect_refused(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(watermark_lama_remove(_params(str(src), mask_w=0.6, mask_h=0.6)))
    assert r.ok is False and "25%" in (r.error or "")


def test_relative_input_rejected():
    r = _run(watermark_lama_remove(_params("rel/in.png")))
    assert r.ok is False and "absolute" in (r.error or "")


def test_missing_input():
    r = _run(watermark_lama_remove(_params("/nope/x.png")))
    assert r.ok is False and "not found" in (r.error or "")


def test_output_exclusivity(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(watermark_lama_remove(_params(
        str(src), output_path="/abs/o.png", out_dir="/abs/d")))
    assert r.ok is False and "either output_path or out_dir" in (r.error or "")


def test_collision_increments_like_everywhere_else(tmp_path):
    src = _make_png(tmp_path / "in.png")
    (tmp_path / "in_clean.png").write_bytes(b"x" * 64)
    r = _run(watermark_lama_remove(_params(str(src), dry_run=True)))
    assert r.ok is True and r.dry_run is True
    assert "in_clean_0001.png" in (r.stdout or "")


def test_wrong_engine_refused(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(watermark_lama_remove(_params(str(src), engine="gemini-reverse-alpha")))
    assert r.ok is False and "lama-openvino" in (r.error or "")


# ── dry-run ───────────────────────────────────────────────────────────────

def test_dry_run_writes_nothing(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(watermark_lama_remove(_params(str(src), dry_run=True)))
    assert r.ok is True and r.dry_run is True
    assert r.output_path is None
    assert "watermark_lama_remove" in (r.command or "")
    assert "margin=32px" in (r.command or "")
    assert (r.meta or {}).get("margin_px") == 32
    assert not (tmp_path / "in_clean.png").exists()


def test_setup_dry_run(tmp_path, monkeypatch):
    monkeypatch.setattr(wl, "lama_model_dir", lambda: tmp_path / "lama")
    r = _run(watermark_lama_setup(WatermarkLamaSetupParams(dry_run=True)))
    assert r.ok is True and r.dry_run is True
    assert "phase 1" in (r.command or "") and "phase 3" in (r.command or "")
    assert (r.meta or {}).get("recommend_restart") is False
    assert not (tmp_path / "lama").exists()


# ── missing IR ────────────────────────────────────────────────────────────

def test_missing_ir_setup_hint(tmp_path, monkeypatch):
    src = _make_png(tmp_path / "in.png")
    monkeypatch.setattr(wl, "lama_model_dir", lambda: tmp_path / "empty")
    r = _run(watermark_lama_remove(_params(str(src))))
    assert r.ok is False
    assert "watermark_lama_setup" in (r.error or "")


def test_lama_status_shape(tmp_path, monkeypatch):
    monkeypatch.setattr(wl, "lama_model_dir", lambda: tmp_path / "empty")
    st = get_lama_status()
    assert st["onnx_present"] is False and st["ir_present"] is False
    assert isinstance(st["devices"], list)


# ── geometry without a model ──────────────────────────────────────────────

def test_rasterize_mask_odd_dims_clamped():
    m = lama_filter.rasterize_mask(321, 241, (0.80, 0.84, 0.17, 0.12), 1)
    assert m.shape == (241, 321) and m.dtype.name == "float32"
    assert 0.0 <= float(m.min()) and float(m.max()) <= 1.0
    assert float(m.sum()) > 0
    m2 = lama_filter.rasterize_mask(321, 241, (0.95, 0.95, 0.20, 0.20), 0)
    assert m2.shape == (241, 321)  # clamped, never out of bounds
    assert float(m2.sum()) <= 321 * 241 * 0.25 + 321 * 241 * 0.01


class _FakeCompiled:
    def __call__(self, inputs: dict):
        import numpy as np

        n = inputs["image"].shape[0]
        return {"output": np.zeros((n, 3, 512, 512), dtype=np.float32)}


_FAKE_SPEC = {"image_name": "image", "mask_name": "mask",
              "output_name": "output", "size": 512}


def test_compute_crop_box_matrix():
    import numpy as np

    m = np.zeros((240, 320), dtype=np.float32)
    m[200:220, 260:300] = 1.0
    assert lama_filter.compute_crop_box(320, 240, m, 0) is None  # 0 = full-frame
    assert lama_filter.compute_crop_box(320, 240, np.zeros_like(m), 32) is None
    box = lama_filter.compute_crop_box(320, 240, m, 32)
    assert box == {"x0": 228, "y0": 168, "x1": 320, "y1": 240}  # clamped
    big = np.ones((240, 320), dtype=np.float32)
    assert lama_filter.compute_crop_box(320, 240, big, 32) is None  # full cover


def test_crop_vs_full_consistent_fake_model():
    import numpy as np

    img = np.random.randint(0, 255, (240, 320, 3), dtype=np.uint8)
    mask = lama_filter.rasterize_mask(320, 240, (0.80, 0.84, 0.17, 0.12), 1)
    assert lama_filter.compute_crop_box(320, 240, mask, 32) is not None
    full = lama_filter.inpaint_image(img, mask, _FakeCompiled(), _FAKE_SPEC,
                                     margin_px=0)
    crop = lama_filter.inpaint_image(img, mask, _FakeCompiled(), _FAKE_SPEC,
                                     margin_px=32)
    assert full.shape == img.shape == crop.shape
    outside = mask == 0.0
    # Composite-only-inside-mask: exact-zero pixels are source-exact, both paths.
    assert np.abs(full[outside].astype(int) - img[outside].astype(int)).max() <= 1
    assert np.abs(crop[outside].astype(int) - img[outside].astype(int)).max() <= 1


def _ir_present() -> bool:
    from app.operations.watermark_lama_ops import lama_model_dir
    from app.filters.lama import ir_path_for

    return ir_path_for(lama_model_dir()).is_file()


@pytest.mark.skipif(not _ir_present(), reason="LaMA IR not installed")
def test_still_fixture_outside_mask_unchanged_real_model(tmp_path):
    """Validation bar (stills): with the REAL model, pixels where the
    feathered mask is exactly 0 are byte-identical to the source, and the
    hole actually changes."""
    import cv2
    import numpy as np

    from app.filters.lama import get_compiled, introspect_ir, ir_path_for
    from app.operations.watermark_lama_ops import lama_model_dir

    src = _make_png(tmp_path / "still.png", 320, 240)
    img = cv2.imread(str(src))
    mask = lama_filter.rasterize_mask(320, 240, (0.80, 0.84, 0.17, 0.12), 1)
    compiled, settled = get_compiled(lama_model_dir(), "CPU")
    spec = introspect_ir(ir_path_for(lama_model_dir()))
    assert settled == "CPU"
    done = lama_filter.inpaint_image(img, mask, compiled, spec, margin_px=32)
    assert done.shape == img.shape
    outside = mask == 0.0
    assert outside.sum() > 0
    assert np.abs(done[outside].astype(int) - img[outside].astype(int)).max() == 0
    hole = mask > 0.9
    assert hole.sum() > 100
    assert np.abs(done[hole].astype(int) - img[hole].astype(int)).mean() > 0.5


@pytest.mark.skipif(not _ir_present(), reason="LaMA IR not installed")
def test_finish_modes_fake_model():
    """Every blend + finish knob runs on the fake model: dims preserved and
    exact-zero mask pixels stay source-exact (fake output is zeros, so only
    outside-mask is asserted)."""
    import numpy as np

    img = np.random.randint(0, 255, (240, 320, 3), dtype=np.uint8)
    mask = lama_filter.rasterize_mask(320, 240, (0.80, 0.84, 0.17, 0.12), 1)
    outside = mask == 0.0
    for kw in (dict(blend="poisson"), dict(blend="mono"),
               dict(sharpen=1.0), dict(color_match=True),
               dict(upscale_max=2.0), dict(mask_thresh=0.3)):
        done = lama_filter.inpaint_image(img, mask, _FakeCompiled(),
                                         _FAKE_SPEC, margin_px=32, **kw)
        assert done.shape == img.shape, kw
        assert np.abs(done[outside].astype(int)
                      - img[outside].astype(int)).max() <= 1, kw


def test_mono_fill_real_model(tmp_path):
    """Smoke: the mono finish path runs on the real model and keeps color."""
    import cv2
    import numpy as np

    from app.filters.lama import get_compiled, introspect_ir, ir_path_for
    from app.operations.watermark_lama_ops import lama_model_dir

    if not ir_path_for(lama_model_dir()).is_file():
        pytest.skip("LaMA IR not installed")
    img = np.zeros((240, 320, 3), dtype=np.uint8)
    img[:, :, 2] = 255
    mask = lama_filter.rasterize_mask(320, 240, (0.45, 0.40, 0.10, 0.15), 1)
    compiled, _ = get_compiled(lama_model_dir(), "CPU")
    spec = introspect_ir(ir_path_for(lama_model_dir()))
    done = lama_filter.inpaint_image(img, mask, compiled, spec, margin_px=32,
                                     blend="mono", sharpen=0.5)
    hole = mask > 0.9
    assert done.shape == img.shape and hole.sum() > 100
    assert done[hole][:, 2].astype(float).mean() > 200


@pytest.mark.skipif(not _ir_present(), reason="LaMA IR not installed")
def test_flat_field_fills_to_background_real_model():
    """Root-cause regression (2026-09-16): a soft/feathered mask fed to the
    model collapses the fill toward mid-intensity (flat-red hole filled 130
    instead of ~255). The model-bound mask must be binarized; the feathered
    mask is composite-only."""
    import cv2
    import numpy as np

    from app.filters.lama import get_compiled, introspect_ir, ir_path_for
    from app.operations.watermark_lama_ops import lama_model_dir

    img = np.zeros((240, 320, 3), dtype=np.uint8)
    img[:, :, 2] = 255  # flat red (BGR)
    mask = lama_filter.rasterize_mask(320, 240, (0.45, 0.40, 0.10, 0.15), 1)
    compiled, _ = get_compiled(lama_model_dir(), "CPU")
    spec = introspect_ir(ir_path_for(lama_model_dir()))
    done = lama_filter.inpaint_image(img, mask, compiled, spec, margin_px=32)
    hole = mask > 0.9
    assert hole.sum() > 100
    mean_red = done[hole][:, 2].astype(float).mean()
    assert mean_red > 200, f"flat-red hole filled {mean_red:.0f}, want ~255"


def test_inpaint_round_trip_odd_dims():
    import cv2
    import numpy as np

    img = np.random.randint(0, 255, (241, 321, 3), dtype=np.uint8)
    mask = lama_filter.rasterize_mask(321, 241, (0.80, 0.84, 0.17, 0.12), 1)
    done = lama_filter.inpaint_image(img, mask, _FakeCompiled(), _FAKE_SPEC)
    assert done.shape == img.shape  # output dims = input dims
    # Outside the (feathered) mask the fake (zeros) output must not leak.
    # Only exact-zero pixels are compared — the feather transition blends
    # by design.
    outside = mask == 0.0
    assert outside.sum() > 0
    assert np.abs(done[outside].astype(int) - img[outside].astype(int)).max() <= 1


def test_image_path_success_fake_model(tmp_path, monkeypatch):
    src = _make_png(tmp_path / "in.png", 160, 120)
    fake_ir_dir = tmp_path / "lama"
    fake_ir_dir.mkdir()
    (fake_ir_dir / "lama_fp32_fp16.xml").write_text("<net/>")
    monkeypatch.setattr(wl, "lama_model_dir", lambda: fake_ir_dir)
    monkeypatch.setattr(wl, "get_compiled", lambda d, dev="GPU", precision="fp16": (_FakeCompiled(), "CPU"))
    monkeypatch.setattr(wl, "introspect_ir", lambda ir: dict(_FAKE_SPEC))
    r = _run(watermark_lama_remove(_params(str(src))))
    assert r.ok is True, r.error
    assert r.output_path and Path(r.output_path).is_file()
    from PIL import Image

    with Image.open(r.output_path) as im:
        assert im.size == (160, 120)  # dims preserved
    meta = r.meta or {}
    assert meta.get("engine") == "lama-openvino"
    assert meta.get("device_settled") == "CPU"
    assert meta.get("frame_count") == 1
    assert abs(meta["mask"]["w"] * meta["mask"]["h"] - 0.17 * 0.12) < 1e-9


def test_image_path_ignores_frame_range(tmp_path, monkeypatch):
    src = _make_png(tmp_path / "in.png", 64, 48)
    fake_ir_dir = tmp_path / "lama"
    fake_ir_dir.mkdir()
    (fake_ir_dir / "lama_fp32_fp16.xml").write_text("<net/>")
    monkeypatch.setattr(wl, "lama_model_dir", lambda: fake_ir_dir)
    monkeypatch.setattr(wl, "get_compiled", lambda d, dev="GPU", precision="fp16": (_FakeCompiled(), "GPU"))
    monkeypatch.setattr(wl, "introspect_ir", lambda ir: dict(_FAKE_SPEC))
    r = _run(watermark_lama_remove(_params(
        str(src), start_frame=5, end_frame=10)))
    assert r.ok is True, r.error  # video-only params never an error on images


# ── guards ────────────────────────────────────────────────────────────────

def test_no_shell_true_guard():
    for mod in ("app/filters/lama.py", "app/operations/watermark_lama_ops.py"):
        text = (ROOT / mod).read_text()
        assert "shell=True" not in text, mod
        assert "os.system" not in text, mod


def test_registry_contract():
    assert "watermark_lama_remove" in REGISTRY
    assert "watermark_lama_setup" in REGISTRY
    for op_id in ("watermark_lama_remove", "watermark_lama_setup"):
        spec = REGISTRY[op_id]
        assert spec.params_model is not None and spec.handler is not None


def test_v1_file_untouched():
    text = (ROOT / "app/operations/watermark_ops.py").read_text()
    assert "lama" not in text.lower()
