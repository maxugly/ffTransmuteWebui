"""Erase tab backend: iopaint-exact settings, brush-or-rect mask.

Covers the HD validation matrix, brush PNG decode, draw_mask/crop_window
units, dry-run plans, fake-model Original/Crop/Resize paths, a real-model
ground-truth guard, the registry contract, and the no-shell=True guard.
"""
from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.contract import REGISTRY  # noqa: E402
from app.operations import erase_ops as eo  # noqa: E402
from app.operations.erase_ops import (  # noqa: E402
    EraseRemoveParams,
    EraseSetupParams,
    erase_remove,
    erase_setup,
)
from app.filters import erase as ef  # noqa: E402


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _make_png(path: Path, w: int = 320, h: int = 240) -> Path:
    from PIL import Image

    Image.new("RGB", (w, h), (30, 60, 90)).save(path)
    return path


def _mask_b64(w: int = 320, h: int = 240) -> str:
    import base64
    import cv2
    import numpy as np

    m = np.zeros((h, w), dtype=np.uint8)
    m[200:220, 260:300] = 255
    ok, buf = cv2.imencode(".png", m)
    assert ok
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def _params(input_path: str, **kw) -> EraseRemoveParams:
    base = dict(mask_x=0.80, mask_y=0.84, mask_w=0.17, mask_h=0.12)
    base.update(kw)
    return EraseRemoveParams(input_path=input_path, **base)


# ── validation matrix ───────────────────────────────────────────────────

def test_hd_defaults_verbatim_iopaint():
    p = EraseRemoveParams(input_path="/abs/x.png")
    assert (p.hd_strategy, p.crop_trigger, p.crop_margin,
            p.resize_limit) == ("Crop", 800, 128, 1280)


def test_hd_validation():
    with pytest.raises(Exception):
        EraseRemoveParams(input_path="/abs/x.png", hd_strategy="Dream")
    with pytest.raises(Exception):
        EraseRemoveParams(input_path="/abs/x.png", crop_trigger=100)
    with pytest.raises(Exception):
        EraseRemoveParams(input_path="/abs/x.png", crop_margin=600)
    with pytest.raises(Exception):
        EraseRemoveParams(input_path="/abs/x.png", resize_limit=100)


def test_oversize_rect_refused(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(erase_remove(_params(str(src), mask_w=0.6, mask_h=0.6)))
    assert r.ok is False and "25%" in (r.error or "")


def test_relative_input_rejected():
    r = _run(erase_remove(_params("rel/in.png")))
    assert r.ok is False and "absolute" in (r.error or "")


def test_output_exclusivity(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(erase_remove(_params(
        str(src), output_path="/abs/o.png", out_dir="/abs/d")))
    assert r.ok is False and "either output_path or out_dir" in (r.error or "")


def test_collision_increments_like_everywhere_else(tmp_path):
    src = _make_png(tmp_path / "in.png")
    (tmp_path / "in_clean.png").write_bytes(b"x" * 64)
    r = _run(erase_remove(_params(str(src), dry_run=True)))
    assert r.ok is True and r.dry_run is True
    assert "in_clean_0001.png" in (r.stdout or "")


def test_bad_mask_b64_refused(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(erase_remove(_params(str(src), mask_b64="not-base64!!!")))
    assert r.ok is False and "base64" in (r.error or "")


# ── mask units (no model) ───────────────────────────────────────────────

def test_draw_mask_binary():
    import numpy as np

    m = ef.draw_mask(320, 240, (0.45, 0.40, 0.10, 0.15))
    assert set(np.unique(m)).issubset({0.0, 1.0})
    assert m.sum() > 0


def test_decode_mask_png_threshold_and_resize():
    import cv2
    import numpy as np

    m = np.zeros((60, 80), dtype=np.uint8)
    m[10:20, 10:30] = 200  # above 127 → kept
    m[30:40, 10:30] = 100  # below 127 → dropped
    ok, buf = cv2.imencode(".png", m)
    assert ok
    out = ef.decode_mask_png(buf.tobytes(), 320, 240)
    assert out.shape == (240, 320)
    assert set(np.unique(out)).issubset({0.0, 1.0})
    assert out.sum() > 0


def test_decode_mask_png_rgba_alpha_decides():
    """Browser canvases are RGBA: transparent is background even where the
    RGB channels are hot (antialiased stroke fringes must not leak in)."""
    import cv2
    import numpy as np

    m = np.zeros((60, 80, 4), dtype=np.uint8)  # transparent black
    m[10:20, 10:30] = (255, 255, 255, 255)  # opaque white stroke
    m[30:32, 10:30] = (255, 255, 255, 0)  # hot RGB, transparent → dropped
    ok, buf = cv2.imencode(".png", m)
    assert ok
    out = ef.decode_mask_png(bytes(buf.tobytes()), 80, 60)
    assert out.shape == (60, 80)
    assert out[10:20, 10:30].sum() == 10 * 20
    assert out[30:32, :].sum() == 0
    assert out[:10, :].sum() == 0


def test_decode_mask_png_fills_closed_brush_outline():
    import cv2
    import numpy as np

    m = np.zeros((80, 100), dtype=np.uint8)
    cv2.rectangle(m, (20, 20), (79, 59), 255, 5)
    ok, buf = cv2.imencode(".png", m)
    assert ok
    out = ef.decode_mask_png(buf.tobytes(), 100, 80)
    assert np.all(out[30:50, 30:70] == 1.0)
    assert out[5, 5] == 0.0


def test_crop_window_edge_compensated():
    import numpy as np

    m = np.zeros((240, 320), dtype=np.float32)
    m[200:220, 260:300] = 1.0
    box = ef.crop_window(320, 240, m, 128)
    assert box is not None
    # Full-width 296px window kept (shifted, not shrunk); the 276px-tall
    # window clamps to the 240px frame height.
    assert (box["x1"] - box["x0"], box["y1"] - box["y0"]) == (296, 240)
    assert box["x1"] <= 320 and box["y1"] <= 240
    assert ef.crop_window(320, 240, np.zeros_like(m), 128) is None


def test_inpaint_frame_hd_paths_fake_model():
    import numpy as np

    class _Fake:
        def __call__(self, inputs: dict):
            n = inputs["image"].shape[0]
            return {"output": np.zeros((n, 3, 512, 512), dtype=np.float32)}

    spec = {"image_name": "image", "mask_name": "mask",
            "output_name": "output", "size": 512}
    img = np.random.randint(0, 255, (900, 1600, 3), dtype=np.uint8)
    mask = ef.draw_mask(1600, 900, (0.80, 0.84, 0.17, 0.12))
    for kw in (dict(hd_strategy="Original"), dict(hd_strategy="Crop"),
               dict(hd_strategy="Resize", resize_limit=640)):
        done = ef.inpaint_frame(img, mask, _Fake(), spec, **kw)
        assert done.shape == img.shape, kw
        # Outside the binary mask the fake (zeros) output must not leak.
        outside = mask == 0.0
        assert np.abs(done[outside].astype(int)
                      - img[outside].astype(int)).max() <= 1, kw
    with pytest.raises(Exception):
        ef.inpaint_frame(img, mask, _Fake(), spec, hd_strategy="Dream")


def test_small_crop_keeps_original_pixels_for_model_input():
    """Small crops follow IOPaint: no upscale, symmetric padding."""
    import numpy as np

    seen = {}

    class _Capture:
        def __call__(self, inputs: dict):
            seen["image"] = inputs["image"].copy()
            seen["mask"] = inputs["mask"].copy()
            # Return the input image in the model's [0, 255] output units.
            return {"output": inputs["image"] * 255.0}

    spec = {"image_name": "image", "mask_name": "mask",
            "output_name": "output", "size": 512}
    img = np.zeros((180, 260, 3), dtype=np.uint8)
    yy, xx = np.indices(img.shape[:2])
    img[:, :, 0] = xx % 251
    img[:, :, 1] = yy % 251
    img[:, :, 2] = (xx + yy) % 251
    mask = ef.draw_mask(260, 180, (0.35, 0.35, 0.18, 0.18))
    ef.run_view(img, mask, _Capture(), spec)

    # The pixels supplied to LaMa remain the original RGB values, including
    # under the mask. The small source is not upscaled.
    expected = img[:, :, ::-1].astype(np.float32) / 255.0
    got = np.transpose(seen["image"][0], (1, 2, 0))
    np.testing.assert_allclose(got[:180, :260], expected,
                               atol=1 / 255 + 1e-6)
    assert set(np.unique(seen["mask"])).issubset({0.0, 1.0})
    ys, xs = np.nonzero(seen["mask"][0, 0] > 0.5)
    assert xs.min() == int(round(0.35 * 260))


# ── dry run ─────────────────────────────────────────────────────────────

def test_dry_run_writes_nothing(tmp_path):
    src = _make_png(tmp_path / "in.png")
    r = _run(erase_remove(_params(str(src), dry_run=True,
                                  mask_b64=_mask_b64())))
    assert r.ok is True and r.dry_run is True
    assert "erase_remove" in (r.command or "")
    assert not (tmp_path / "in_clean.png").exists()


# ── real model ──────────────────────────────────────────────────────────

def _ir_present() -> bool:
    from app.filters.erase import erase_model_dir, ir_path_for

    return ir_path_for(erase_model_dir()).is_file()


@pytest.mark.skipif(not _ir_present(), reason="Erase IR not installed")
def test_busy_ground_truth_real_model():
    """GT guard: seeded busy fixture must clear the drawn bars (rails 55)."""
    import cv2
    import numpy as np

    from app.filters.erase import (
        erase_model_dir,
        get_compiled,
        inpaint_frame,
        introspect_ir,
        ir_path_for,
    )

    rng = np.random.default_rng(23)
    gt = np.zeros((720, 1280, 3), dtype=np.uint8)
    for _ in range(220):
        x, y = rng.integers(0, 1240), rng.integers(0, 690)
        w, h = rng.integers(30, 160), rng.integers(20, 110)
        cv2.rectangle(gt, (x, y), (x + w, y + h),
                      tuple(int(v) for v in rng.integers(50, 210, 3)), -1)
    gt = cv2.GaussianBlur(gt, (3, 3), 0)
    wm = gt.copy()
    cv2.rectangle(wm, (1000, 620), (1220, 690), (235, 235, 235), -1)
    cv2.putText(wm, "PIXVERSE", (1015, 668), cv2.FONT_HERSHEY_SIMPLEX, 1.1,
                (25, 25, 25), 3)
    mask = ef.draw_mask(1280, 720, (1000 / 1280, 615 / 720,
                                    225 / 1280, 80 / 720))
    compiled, _ = get_compiled(erase_model_dir(), "CPU")
    spec = introspect_ir(ir_path_for(erase_model_dir()))
    done = inpaint_frame(wm, mask, compiled, spec)
    hole = mask > 0.5
    assert hole.sum() > 1000
    err = np.abs(done[hole].astype(float) - gt[hole].astype(float)).mean()
    assert err < 55, f"erase GT hole err {err:.1f}"


# ── Intel GPU (docs/intel_gpu_5d_bug_workaround.md) ─────────────────────
#
# The workaround doc theorizes an Add/Sub 5D fusion bug fixed by ONNX
# Squeeze/Unsqueeze surgery. Bisection on this stack (OV 2026.3.1) proved
# otherwise: the first CPU-vs-GPU divergence is a 5D spectral MatMul, and
# wrapping the 72 true-5D rttn Add/Subs changed nothing (hole mean|d|
# stayed ≈ 65). The actual cause is the GPU plugin's default fp16
# accumulation in those large reductions, amplified by the spectral Div.
# Compiling GPU with hint.inference_precision=f32 matches CPU bit-nearly,
# so that hint (in filters/erase.py:get_compiled) IS the fix — no model
# surgery, no extra weights. This test guards it: without the hint the
# hole diff is ~65 and the test fails.

def _gpu_available() -> bool:
    try:
        import openvino as ov

        return "GPU" in [str(x) for x in ov.Core().available_devices]
    except Exception:
        return False


@pytest.mark.skipif(not _ir_present(), reason="Erase IR not installed")
@pytest.mark.skipif(not _gpu_available(), reason="No Intel GPU")
def test_gpu_matches_cpu_real_model():
    """GPU (f32 hint) must match CPU bit-nearly on a seeded fixture."""
    import numpy as np

    from app.filters.erase import (
        draw_mask,
        erase_model_dir,
        get_compiled,
        inpaint_frame,
        introspect_ir,
        ir_path_for,
    )

    rng = np.random.default_rng(7)
    img = np.zeros((240, 320, 3), dtype=np.uint8)
    for _ in range(60):
        x, y = rng.integers(0, 300), rng.integers(0, 220)
        w, h = rng.integers(10, 60), rng.integers(10, 50)
        import cv2

        cv2.rectangle(img, (x, y), (x + w, y + h),
                      tuple(int(v) for v in rng.integers(50, 210, 3)), -1)
    import cv2

    img = cv2.GaussianBlur(img, (3, 3), 0)
    mask = draw_mask(320, 240, (0.55, 0.60, 0.20, 0.16))
    compiled_cpu, _ = get_compiled(erase_model_dir(), "CPU")
    compiled_gpu, settled = get_compiled(erase_model_dir(), "GPU")
    assert settled == "GPU"
    spec = introspect_ir(ir_path_for(erase_model_dir()))
    cpu = inpaint_frame(img, mask, compiled_cpu, spec,
                        hd_strategy="Original").astype(float)
    gpu = inpaint_frame(img, mask, compiled_gpu, spec,
                        hd_strategy="Original").astype(float)
    hole = mask > 0.5
    diff = float(np.abs(cpu[hole] - gpu[hole]).mean())
    assert diff < 1.0, f"GPU diverged from CPU in hole: mean|d|={diff:.2f}"


def test_setup_dry_run_phases(tmp_path):
    r = _run(erase_setup(EraseSetupParams(action="install", dry_run=True)))
    assert r.ok is True and r.dry_run is True
    plan = (r.command or "").lower()
    assert "download" in plan and "convert" in plan and "gpu" in plan


def _white_mask_b64(w: int = 320, h: int = 240) -> str:
    import base64
    import cv2
    import numpy as np

    m = np.full((h, w), 255, dtype=np.uint8)
    ok, buf = cv2.imencode(".png", m)
    assert ok
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def test_painted_mask_over_cap_refused(tmp_path):
    """A full-frame painted mask must fail loudly (cap 25%), never render
    whole-frame LaMA texture. Regression: an opaque canvas background
    decodes to 100% coverage via the alpha channel."""
    src = _make_png(tmp_path / "in.png")
    r = _run(erase_remove(_params(str(src), mask_b64=_white_mask_b64())))
    assert r.ok is False and "25%" in (r.error or "")
    assert "tighter mask" in (r.error or "")


def test_mask_area_helper_units():
    import numpy as np

    from app.filters.erase import MAX_MASK_AREA, check_mask_area

    assert MAX_MASK_AREA == 0.25
    m = np.zeros((100, 100), dtype=np.float32)
    m[40:60, 40:60] = 1.0  # 4% — fine
    assert check_mask_area(m, painted=True) == 0.04
    m[:] = 1.0
    with pytest.raises(RuntimeError, match="25%"):
        check_mask_area(m, painted=True)


# ── contract guards ─────────────────────────────────────────────────────

def test_no_shell_true_guard():
    for mod in ("erase.py", "erase_ops.py"):
        p = ROOT / "app" / ("filters" if mod == "erase.py" else "operations") / mod
        src = p.read_text()
        assert "shell=True" not in src
        assert "subprocess" not in src or "run_command" in src


def test_registry_contract():
    assert "erase_remove" in REGISTRY
    assert "erase_setup" in REGISTRY
    from app.filters import STAGE_REGISTRY

    assert "erase" in STAGE_REGISTRY
