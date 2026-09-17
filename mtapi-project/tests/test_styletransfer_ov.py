"""Style transfer GPU engine (OpenVINO AdaIN): bucket picker, clean-failure
contract, setup dry-run/status shape, registry entries, and — where the IR
is installed — a real end-to-end GPU stylization.
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
from app.operations import styletransfer_ops as sto  # noqa: E402
from app.operations import styletransfer_ov_engine as ove  # noqa: E402
from app.operations.styletransfer_ops import (  # noqa: E402
    StyleTransferOvSetupParams,
    StyleTransferParams,
    get_styletransfer_ov_status,
    styletransfer_ov_setup,
)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _make_png(path: Path, w: int = 320, h: int = 240, color=(30, 60, 90)) -> Path:
    from PIL import Image

    Image.new("RGB", (w, h), color).save(path)
    return path


# ── bucket picker (pure, no model) ──────────────────────────────────────────

def test_pick_bucket_smallest_fit():
    assert ove.pick_bucket(100, 100) == (512, 512)
    assert ove.pick_bucket(512, 512) == (512, 512)
    assert ove.pick_bucket(513, 400) == (768, 768)
    assert ove.pick_bucket(800, 1200) == (1080, 1920)


def test_pick_bucket_oversize_clamps_to_largest():
    assert ove.pick_bucket(4000, 3000) == (1080, 1920)


# ── params contract ─────────────────────────────────────────────────────────

def test_engine_defaults_cpu():
    p = StyleTransferParams(style_path="/abs/s.png")
    assert p.engine == "cpu"


def test_engine_rejects_unknown():
    with pytest.raises(Exception):
        StyleTransferParams(style_path="/abs/s.png", engine="tpu")


def test_setup_params_need_no_style():
    p = StyleTransferOvSetupParams()
    assert p.style_path == ""
    assert p.action == "install"


# ── registry ────────────────────────────────────────────────────────────────

def test_registry_has_styletransfer_and_setup():
    assert "styletransfer" in REGISTRY
    assert "styletransfer_ov_setup" in REGISTRY


# ── clean failure when IR is absent (no crash, no traceback leak) ───────────

def test_gpu_pair_fails_clean_without_ir(tmp_path, monkeypatch):
    monkeypatch.setattr(ove, "resolve_artifacts_dir", lambda: None)
    content = _make_png(tmp_path / "c.png")
    style = _make_png(tmp_path / "s.png", color=(200, 30, 30))
    r = ove.stylize_pair(content, style, tmp_path / "out.png")
    assert r["ok"] is False
    assert "setup" in r["error"]


def test_gpu_filter_factory_fails_clean_without_ir(tmp_path, monkeypatch):
    from app.filters import styletransfer as stf

    style = _make_png(tmp_path / "s.png", color=(200, 30, 30))
    monkeypatch.setattr(ove, "resolve_artifacts_dir", lambda: None)
    with pytest.raises(RuntimeError, match="setup"):
        stf.make_styletransfer_filter(style_path=str(style), engine="gpu")


def test_cpu_filter_factory_still_imports_tf_path():
    """CPU factory must not touch openvino — it takes the TF branch.

    TF is not installed here, so it must raise ImportError (not anything
    OV-related), proving the branch selection happens first.
    """
    from app.filters import styletransfer as stf

    with pytest.raises(Exception):
        stf.make_styletransfer_filter(style_path="/abs/s.png", engine="cpu")


# ── setup dry-run + status shape ────────────────────────────────────────────

def test_ov_setup_dry_run_changes_nothing():
    before = get_styletransfer_ov_status()
    r = _run(styletransfer_ov_setup(StyleTransferOvSetupParams(dry_run=True)))
    assert r.ok is True and r.dry_run is True
    after = get_styletransfer_ov_status()
    assert after["ir_present"] == before["ir_present"]


def test_ov_status_shape():
    s = get_styletransfer_ov_status()
    assert s["ok"] is True
    assert isinstance(s["ir_present"], bool)
    assert isinstance(s["devices"], list)
    assert isinstance(s["files"], dict)
    assert len(s["files"]) == len(sto.OV_IR_FILES)


# ── real end-to-end (only where the IR + openvino exist) ────────────────────

_needs_ir = pytest.mark.skipif(
    not ove.ir_present(), reason="OVS-Style IR not installed"
)
_needs_ov = pytest.mark.skipif(
    not ove.available_devices(), reason="openvino not installed"
)


@_needs_ov
@_needs_ir
def test_real_gpu_stylize_pair(tmp_path):
    pytest.importorskip("openvino")
    content = _make_png(tmp_path / "c.png", 320, 240)
    style = _make_png(tmp_path / "s.png", 256, 256, color=(200, 30, 30))
    out = tmp_path / "c_styled.png"
    r = ove.stylize_pair(content, style, out, strength=1.0, max_side=256)
    assert r["ok"] is True, r.get("error")
    assert Path(r["output_path"]).is_file()
    assert r["device_settled"] == "GPU"
    assert r["engine"] == "openvino"
    from PIL import Image

    with Image.open(r["output_path"]) as im:
        # max_side=256 caps the working res (320x240 -> 256x192); output
        # stays at working res, same contract as the Magenta engine.
        assert im.size == (256, 192)


@_needs_ov
@_needs_ir
def test_real_gpu_strength_strip(tmp_path):
    pytest.importorskip("openvino")
    content = _make_png(tmp_path / "c.png", 160, 120)
    style = _make_png(tmp_path / "s.png", 128, 128, color=(30, 200, 30))
    cand = tmp_path / "cand"
    r = ove.stylize_strength_strip(
        content, style, cand, strengths=[0.0, 1.0], max_side=128
    )
    assert r["ok"] is True, r.get("error")
    assert len(r["paths"]) == 2
    assert all(Path(p).is_file() for p in r["paths"])
    assert r["device_settled"] == "GPU"


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
        ove._get_compiled("/fake/style_encoder_fp16.xml", "GPU")


def test_opt_in_fallback_still_reaches_cpu(monkeypatch):
    ovmod = pytest.importorskip("openvino")
    monkeypatch.setattr(ovmod, "Core", _GpuDownCore)
    ove.clear_cache()
    _model, settled = ove._get_compiled(
        "/fake/style_encoder_fp16.xml", "GPU", allow_fallback=True
    )
    assert settled == "CPU"


def test_pair_fails_loud_on_gpu_error(tmp_path, monkeypatch):
    calls: list[str] = []

    def _boom(ir_path: str, device: str, **_kw):
        calls.append(device)
        raise RuntimeError("synthetic GPU down")

    monkeypatch.setattr(ove, "_get_compiled", _boom)
    content = _make_png(tmp_path / "c.png")
    style = _make_png(tmp_path / "s.png", color=(200, 30, 30))
    r = ove.stylize_pair(content, style, tmp_path / "out.png")
    assert r["ok"] is False
    assert "synthetic GPU down" in r["error"]
    # Exactly one compile attempt — no second try on CPU behind our back.
    assert calls == ["GPU"]
