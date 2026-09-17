"""DeepDream GPU engine (OpenVINO static): pyramid math, compatibility gate,
clean-failure contract, setup dry-run/status shape, registry entries, and —
where the IR is installed — a real end-to-end GPU dream.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.contract import REGISTRY  # noqa: E402
from app.operations import deepdream_ops as ddo  # noqa: E402
from app.operations import deepdream_ov_engine as ove  # noqa: E402
from app.operations.deepdream_ops import (  # noqa: E402
    DeepDreamOvSetupParams,
    DeepDreamParams,
    deepdream as deepdream_op,
    get_deepdream_ov_status,
    deepdream_ov_setup,
)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _make_png(path: Path, w: int = 320, h: int = 240, color=(30, 60, 90)) -> Path:
    from PIL import Image

    Image.new("RGB", (w, h), color).save(path)
    return path


# ── pyramid math (pure, no model) ───────────────────────────────────────────

def test_octave_shapes_default_pyramid():
    assert ove.octave_shapes(4) == [(186, 186), (261, 261), (365, 365), (512, 512)]


def test_octave_shapes_subset():
    assert ove.octave_shapes(1) == [(512, 512)]
    assert ove.octave_shapes(2) == [(365, 365), (512, 512)]


def test_octave_shapes_rejects_out_of_range():
    with pytest.raises(RuntimeError, match="1–4 octaves"):
        ove.octave_shapes(0)
    with pytest.raises(RuntimeError, match="1–4 octaves"):
        ove.octave_shapes(5)


# ── compatibility gate ──────────────────────────────────────────────────────

def test_compatible_defaults_pass_with_baked_note():
    note = ove.check_compatible()
    assert "Mixed_6c" in note


def test_compatible_rejects_each_bad_knob():
    cases = [
        dict(model_name="vgg16"),
        dict(custom_layer_weights={"mixed4": 1.0}),
        dict(layer_cycle=True),
        dict(guide_path="/abs/g.png"),
        dict(max_loss=15.0),
        dict(max_loss_to=15.0),
        dict(preview_width=640),
        dict(optical_flow=True),
        dict(octave_scale=2.0),
        dict(num_octave=5),
        dict(num_octave=4, num_octave_to=2.0),
        dict(octave_scale=1.4, octave_scale_to=2.0),
    ]
    for kw in cases:
        with pytest.raises(RuntimeError, match="engine=gpu incompatible"):
            ove.check_compatible(**kw)


def test_noop_ramps_pass():
    """Dynamic mode always sends *_to endpoints — equal endpoints are a
    harmless constant, not a ramp, and must not fail."""
    note = ove.check_compatible(
        num_octave=4, num_octave_to=4,
        octave_scale=1.4, octave_scale_to=1.4,
        max_loss=0, max_loss_to=0,
    )
    assert "Mixed_6c" in note


def test_stills_ignore_video_only_ramps(tmp_path):
    """*_to ramps are video-path-only knobs the stills path never consumes
    (CPU silently ignores them too) — a still must not fail over them."""
    src = _make_png(tmp_path / "c.png")
    p = DeepDreamParams(
        input_path=str(src), engine="gpu",
        num_octave_to=5, octave_scale_to=2.0, max_loss_to=9,
        dry_run=True,
    )
    r = _run(deepdream_op(p))
    assert r.ok is True, r.error


def test_video_real_ramp_still_fails(tmp_path):
    """On a real video run the shape ramp is consumed → must fail loudly."""
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"fake")
    p = DeepDreamParams(
        input_path=str(clip), media_kind="video", engine="gpu",
        num_octave_to=5, dry_run=True,
    )
    r = _run(deepdream_op(p))
    assert r.ok is False
    assert "num_octave ramp" in (r.error or "")


# ── params contract ─────────────────────────────────────────────────────────

def test_engine_defaults_cpu():
    p = DeepDreamParams(input_path="/abs/x.png")
    assert p.engine == "cpu"


def test_engine_rejects_unknown():
    with pytest.raises(Exception):
        DeepDreamParams(input_path="/abs/x.png", engine="tpu")


def test_setup_params_need_no_input():
    p = DeepDreamOvSetupParams()
    assert p.input_path == ""
    assert p.action == "install"


# ── registry ────────────────────────────────────────────────────────────────

def test_registry_has_setup():
    assert "deepdream" in REGISTRY
    assert "deepdream_ov_setup" in REGISTRY


# ── clean failure when IR is absent ─────────────────────────────────────────

def test_gpu_pair_fails_clean_without_ir(tmp_path, monkeypatch):
    monkeypatch.setattr(ove, "resolve_artifacts_dir", lambda: None)
    content = _make_png(tmp_path / "c.png")
    r = ove.dream_pair(content, tmp_path / "out.png", iterations=1, num_octave=1)
    assert r["ok"] is False
    assert "setup" in r["error"]


def test_gpu_filter_factory_fails_clean_on_bad_knob():
    from app.filters import deepdream as ddf

    with pytest.raises(RuntimeError, match="engine=gpu incompatible"):
        ddf.make_deepdream_filter(engine="gpu", model_name="vgg16")


# ── setup dry-run + status shape ────────────────────────────────────────────

def test_ov_setup_dry_run_changes_nothing():
    before = get_deepdream_ov_status()
    r = _run(deepdream_ov_setup(DeepDreamOvSetupParams(dry_run=True)))
    assert r.ok is True and r.dry_run is True
    after = get_deepdream_ov_status()
    assert after["ir_present"] == before["ir_present"]


def test_ov_status_shape():
    s = get_deepdream_ov_status()
    assert s["ok"] is True
    assert isinstance(s["ir_present"], bool)
    assert isinstance(s["devices"], list)
    assert isinstance(s["files"], dict)
    assert len(s["files"]) == len(ddo.OV_DD_FILES)
    assert s["baked"] == {"model": ove.OV_MODEL, "layer": ove.OV_LAYER}


# ── strict GPU: failure is loud, never a silent CPU fallback ────────────────

class _GpuDownCore:
    """Fake ov.Core: GPU compile always blows up, CPU works."""

    available_devices = ["CPU", "GPU"]

    def read_model(self, _path):
        return object()

    def compile_model(self, _model, dev, _cfg=None):
        if dev == "GPU":
            raise RuntimeError("synthetic GPU down")
        return object()


def test_strict_gpu_raises_no_fallback(monkeypatch):
    ovmod = pytest.importorskip("openvino")
    monkeypatch.setattr(ovmod, "Core", _GpuDownCore)
    ove.clear_cache()
    with pytest.raises(RuntimeError, match="no CPU fallback"):
        ove._get_compiled((186, 186), "GPU")


def test_opt_in_fallback_still_reaches_cpu(monkeypatch):
    ovmod = pytest.importorskip("openvino")
    monkeypatch.setattr(ovmod, "Core", _GpuDownCore)
    ove.clear_cache()
    _model, settled = ove._get_compiled(
        (186, 186), "GPU", allow_fallback=True
    )
    assert settled == "CPU"


def test_pair_fails_loud_on_gpu_error(tmp_path, monkeypatch):
    calls: list[str] = []

    def _boom(shape, device, **_kw):
        calls.append(device)
        raise RuntimeError("synthetic GPU down")

    monkeypatch.setattr(ove, "_get_compiled", _boom)
    content = _make_png(tmp_path / "c.png")
    r = ove.dream_pair(content, tmp_path / "out.png", iterations=1, num_octave=1)
    assert r["ok"] is False
    assert "synthetic GPU down" in r["error"]
    # Exactly one compile attempt — no second try on CPU behind our back.
    assert calls == ["GPU"]


# ── real end-to-end (only where the IR + openvino exist) ────────────────────

_needs_ir = pytest.mark.skipif(
    not ove.ir_present(), reason="OVS-DD IR not installed"
)
_needs_ov = pytest.mark.skipif(
    not ove.available_devices(), reason="openvino not installed"
)


@_needs_ov
@_needs_ir
def test_real_gpu_dream_pair(tmp_path):
    pytest.importorskip("openvino")
    content = _make_png(tmp_path / "c.png", 320, 240)
    out = tmp_path / "c_dream.png"
    r = ove.dream_pair(content, out, iterations=2, num_octave=2)
    assert r["ok"] is True, r.get("error")
    assert Path(r["output_path"]).is_file()
    assert r["device_settled"] == "GPU"
    assert r["engine"] == "openvino"
    assert r["ov_layer"] == ove.OV_LAYER
    from PIL import Image

    with Image.open(r["output_path"]) as im:
        # Output returns to input dims (pyramid runs at native octave shapes).
        assert im.size == (320, 240)
        # Non-degenerate: must not be pure black (fp16-GPU 365/512 bug).
        assert np.asarray(im).mean() > 1.0


@_needs_ov
@_needs_ir
def test_gpu_matches_cpu_real_model(tmp_path):
    """Regression guard: default-fp16 GPU compiles returned pure zeros on
    the 365/512 octave IRs while CPU was correct. With the f32 inference
    hint the GPU output must match CPU closely. Fails (~30+ mean diff)
    without the hint."""
    pytest.importorskip("openvino")
    from PIL import Image

    _make_png(tmp_path / "c.png", 160, 120, color=(90, 40, 140))
    arr = np.asarray(Image.open(tmp_path / "c.png").convert("RGB"))
    cpu_out, _ = ove.dream_array(arr, iterations=2, num_octave=1, device="CPU")
    gpu_out, settled = ove.dream_array(arr, iterations=2, num_octave=1, device="GPU")
    assert settled == "GPU"
    assert float(np.mean(gpu_out)) > 1.0
    diff = float(np.abs(gpu_out.astype(float) - cpu_out.astype(float)).mean())
    assert diff < 5.0, diff
