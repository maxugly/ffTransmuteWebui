"""Demucs stem separator (OpenVINO Route C2): model catalog, stem validation,
params contract, strict-GPU failure, setup dry-run/status shape, registry,
frontend wiring, and — where IRs + deps are installed — real compile checks.
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
from app.operations import demucs_ops as dops  # noqa: E402
from app.operations import demucs_ov_engine as ove  # noqa: E402
from app.operations.demucs_ops import (  # noqa: E402
    DemucsOvSetupParams,
    DemucsSeparateParams,
    demucs_ov_setup,
    get_demucs_ov_status,
)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── model catalog (pure, no deps) ───────────────────────────────────────────

def test_three_models_registered():
    assert sorted(ove.MODEL_SPECS) == ["htdemucs", "htdemucs_6s", "htdemucs_ft"]


def test_four_stem_sources():
    assert ove.MODEL_SPECS["htdemucs"]["sources"] == ["drums", "bass", "other", "vocals"]
    assert ove.MODEL_SPECS["htdemucs_ft"]["sources"] == ["drums", "bass", "other", "vocals"]


def test_sixs_model_has_guitar_piano():
    assert ove.MODEL_SPECS["htdemucs_6s"]["sources"] == [
        "drums", "bass", "other", "vocals", "guitar", "piano",
    ]


def test_ft_is_four_member_bag():
    assert ove.MODEL_SPECS["htdemucs_ft"]["irs"] == [
        "htdemucs_ft_c2_m0.xml",
        "htdemucs_ft_c2_m1.xml",
        "htdemucs_ft_c2_m2.xml",
        "htdemucs_ft_c2_m3.xml",
    ]


def test_ir_file_names_cover_xml_and_bin():
    assert len(ove.IR_FILE_NAMES) == 12  # (1 + 1 + 4) IRs × (xml + bin)
    assert "htdemucs_6s_c2.xml" in ove.IR_FILE_NAMES
    assert "htdemucs_6s_c2.bin" in ove.IR_FILE_NAMES


def test_unknown_model_raises():
    with pytest.raises(RuntimeError):
        ove.resolve_artifacts_dir("mdx_extra")


# ── stem selection (pure) ───────────────────────────────────────────────────

def test_resolve_stems_defaults_to_all():
    assert dops._resolve_stems("htdemucs_6s", None) == [
        "drums", "bass", "other", "vocals", "guitar", "piano",
    ]


def test_resolve_stems_subset_keeps_manifest_order():
    assert dops._resolve_stems("htdemucs", ["vocals", "drums"]) == ["drums", "vocals"]


def test_resolve_stems_rejects_unknown():
    with pytest.raises(RuntimeError, match="no stem"):
        dops._resolve_stems("htdemucs", ["guitar"])


def test_resolve_stems_rejects_duplicates():
    with pytest.raises(RuntimeError, match="Duplicate"):
        dops._resolve_stems("htdemucs", ["vocals", "vocals"])


# ── params contract ─────────────────────────────────────────────────────────

def test_params_defaults():
    p = DemucsSeparateParams(input_path="/abs/song.wav")
    assert p.model == "htdemucs"
    assert p.device == "GPU"
    assert p.overlap == 0.25
    assert p.transition_power == 1.0
    assert p.output_format == "wav-f32"
    assert p.stems is None


def test_params_reject_bad_model_and_overlap():
    with pytest.raises(Exception):
        DemucsSeparateParams(input_path="/abs/s.wav", model="mdx")
    with pytest.raises(Exception):
        DemucsSeparateParams(input_path="/abs/s.wav", overlap=1.0)


def test_setup_params_need_no_input():
    p = DemucsOvSetupParams()
    assert p.input_path == ""
    assert p.action == "install"


# ── registry ────────────────────────────────────────────────────────────────

def test_registry_has_separate_and_setup():
    assert "demucs_separate" in REGISTRY
    assert "demucs_ov_setup" in REGISTRY


# ── clean failures (no IR, no deps needed) ───────────────────────────────────

def test_load_ensemble_fails_loud_without_ir(monkeypatch):
    monkeypatch.setattr(ove, "resolve_artifacts_dir", lambda model="htdemucs": None)
    with pytest.raises(RuntimeError, match="demucs_ov_setup"):
        ove.load_ensemble("htdemucs", "GPU")


def test_missing_ir_files_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(ove, "artifacts_candidates", lambda: [tmp_path])
    missing = ove.missing_ir_files("htdemucs_ft")
    assert len(missing) == 4


def test_separate_missing_input_is_ok_false():
    r = _run(dops.demucs_separate(
        DemucsSeparateParams(input_path="/no/such/file.wav", dry_run=True)
    ))
    assert r.ok is False
    assert "not found" in (r.error or "")


def test_strict_gpu_compile_raises_without_fallback(tmp_path):
    # Missing file → read_model throws → strict path raises RuntimeError
    # naming the no-fallback contract (never a silent CPU retry).
    with pytest.raises(RuntimeError, match="no CPU fallback"):
        ove._compile_one(tmp_path / "nope.xml", "GPU", tmp_path / "cache")


# ── setup dry-run + status shape (no deps) ───────────────────────────────────

def test_setup_dry_run_changes_nothing(tmp_path, monkeypatch):
    dest = tmp_path / "models"
    monkeypatch.setattr(dops, "_ov_model_dir", lambda: dest)
    r = _run(dops.demucs_ov_setup(DemucsOvSetupParams(dry_run=True)))
    assert r.ok is True and r.dry_run is True
    assert not dest.exists()
    assert "phase 1" in (r.command or "")


def test_status_shape():
    s = get_demucs_ov_status()
    assert s["ok"] is True
    assert sorted(s["models"]) == ["htdemucs", "htdemucs_6s", "htdemucs_ft"]
    assert isinstance(s["devices"], list)
    for name, m in s["models"].items():
        assert m["stems"] == ove.MODEL_SPECS[name]["sources"]


# ── frontend wiring (static, no browser) ─────────────────────────────────────

def test_frontend_files_wired():
    static = ROOT / "app" / "static"
    js = (static / "js" / "tabs" / "demucs.js").read_text(encoding="utf-8")
    assert "dmModel" in js and "collectDemucsBody" in js and "data-dm-stem" in js
    html = (static / "index.html").read_text(encoding="utf-8")
    assert 'data-tab="demucs"' in html
    app = (static / "app.js").read_text(encoding="utf-8")
    assert "renderDemucsForm" in app and "demucs" in app
    jc = (static / "js" / "job-control.js").read_text(encoding="utf-8")
    assert "demucs_separate" in jc


# ── real-artifact tests (skip unless IRs + openvino present) ─────────────────

def _needs_ir():
    if ove.resolve_artifacts_dir("htdemucs_6s") is None:
        pytest.skip("Demucs IRs not installed (run GPU Setup first)")


def test_real_ir_status_reports_all_models():
    _needs_ir()
    s = get_demucs_ov_status()
    assert all(m["ir_present"] for m in s["models"].values())


def test_real_cpu_compiles_all_models():
    ov = pytest.importorskip("openvino")
    assert ov is not None
    _needs_ir()
    for name in ove.MODEL_SPECS:
        compiled, settled, _ = ove.load_ensemble(name, "CPU")
        assert settled == "CPU"
        assert len(compiled) == len(ove.MODEL_SPECS[name]["irs"])
    ove.unload_all()


def test_real_gpu_compiles_when_present():
    pytest.importorskip("openvino")
    _needs_ir()
    if "GPU" not in ove.available_devices():
        pytest.skip("No OpenVINO GPU on this box")
    compiled, settled, _ = ove.load_ensemble("htdemucs", "GPU")
    assert settled == "GPU"
    assert len(compiled) == 1
    ove.unload_all()
