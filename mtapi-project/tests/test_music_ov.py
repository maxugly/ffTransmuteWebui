"""Music tab (ACE-Step text-to-music): model catalog + knob matrix, params
contract, env mapping, setup dry-run/status shape, registry, frontend wiring.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.contract import REGISTRY  # noqa: E402
from app.operations import music_ops as mops  # noqa: E402
from app.operations import music_ov_engine as ove  # noqa: E402
from app.operations.music_ops import (  # noqa: E402
    MusicGenerateParams,
    MusicSetupParams,
    music_generate,
    music_ov_setup,
)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── catalog: turbo enabled with exactly the v1 knob set ─────────────────────

def test_turbo_enabled_exact_knobs():
    spec = ove.MUSIC_MODELS["acestep-v15-turbo"]
    assert spec["enabled"] is True
    assert spec["knobs"] == ["prompt", "lyrics", "seed", "duration", "bpm",
                             "key", "timesig", "device", "outdir", "format",
                             "overwrite", "dryrun"]
    for dead in ("guidance", "negative", "steps", "shift"):
        assert dead not in spec["knobs"]


def test_build_env_metas_passthrough():
    e = ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                      duration_sec=12, model="acestep-v15-turbo",
                      device="HETERO", out_path="/tmp/t.wav",
                      bpm="95", key="E minor", timesig="4/4")
    assert e["T2M_BPM"] == "95" and e["T2M_KEY"] == "E minor"
    assert e["T2M_TIMESIG"] == "4/4"
    e2 = ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                       duration_sec=12, model="acestep-v15-turbo",
                       device="HETERO", out_path="/tmp/t.wav")
    assert e2["T2M_BPM"] == "" and e2["T2M_KEY"] == "" and e2["T2M_TIMESIG"] == ""


def test_lora_pairs_catalog_shape():
    assert set(ove.LORA_PAIRS) >= {"turbo+rap_s08_short", "base+rap_s08_base",
                                   "turbo+psychrock_v1"}
    for pid, p in ove.LORA_PAIRS.items():
        assert set(p) >= {"label", "model", "dit_dir", "dit_file",
                          "hetero_pin", "verdict"}
        assert p["verdict"] in ("GOOD", "untested", "BAD")


def test_build_env_lora_overrides_dit():
    e = ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                      duration_sec=12, model="acestep-v15-turbo",
                      device="HETERO", out_path="/tmp/t.wav",
                      lora="turbo+psychrock_v1")
    assert e["T2M_DIT"] == "openvino_model_lora_psychrock_v1_f32.xml"
    assert e["T2M_DIT_DIR"] == "models/dit"


def test_build_env_lora_wrong_model_raises():
    import pytest as _pt
    with _pt.raises(ValueError):
        ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                      duration_sec=12, model="acestep-v15-base",
                      device="HETERO", out_path="/tmp/t.wav",
                      lora="turbo+psychrock_v1")
    with _pt.raises(ValueError):
        ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                      duration_sec=12, model="acestep-v15-turbo",
                      device="HETERO", out_path="/tmp/t.wav", lora="nope")


def test_status_includes_loras():
    s = ove.get_music_ov_status()
    assert isinstance(s["loras"], list) and len(s["loras"]) >= 3
    by_id = {l["id"]: l for l in s["loras"]}
    assert by_id["base+rap_s08_base"]["verdict"] == "BAD"
    assert by_id["base+rap_s08_base"]["trigger"] == "roti-r4pz"
    assert isinstance(by_id["turbo+psychrock_v1"]["ir_present"], bool)


def test_future_entries_disabled_with_reasons():
    for name in ("acestep-v15-turbo-shift1", "acestep-v15-xl-turbo"):
        spec = ove.MUSIC_MODELS[name]
        assert spec["enabled"] is False
        assert spec.get("disabled_reason")


def test_sft_base_expose_cfg_knobs_when_enabled():
    for name in ("acestep-v15-sft", "acestep-v15-base"):
        knobs = ove.MUSIC_MODELS[name]["knobs"]
        for k in ("negative", "steps", "guidance"):
            assert k in knobs


# ── params contract ─────────────────────────────────────────────────────────

def test_duration_clamped_by_validation():
    with pytest.raises(ValidationError):
        MusicGenerateParams(duration_sec=9)
    with pytest.raises(ValidationError):
        MusicGenerateParams(duration_sec=61)
    assert MusicGenerateParams(duration_sec=40).duration_sec == 40


def test_seed_must_be_nonnegative():
    with pytest.raises(ValidationError):
        MusicGenerateParams(seed=-1)


def test_unknown_model_rejected():
    with pytest.raises(ValidationError):
        MusicGenerateParams(model="nope")
    with pytest.raises(ValidationError):
        MusicGenerateParams(model="acestep-v15-turbo-shift1")  # real entry, not yet wired
    # wired models accept:
    assert MusicGenerateParams(model="acestep-v15-sft").model == "acestep-v15-sft"


def test_base_model_accepted_with_cfg_fields():
    p = MusicGenerateParams(model="acestep-v15-base", negative="muddy",
                            steps=30, guidance=5.0)
    assert p.negative == "muddy" and p.steps == 30 and p.guidance == 5.0


def test_base_catalog_declares_cfg_knobs_and_enabled():
    spec = ove.MUSIC_MODELS["acestep-v15-base"]
    assert spec["enabled"] is True
    for k in ("negative", "steps", "guidance"):
        assert k in spec["knobs"]
    assert spec["runner"] == "scripts/generate_t2m_base.py"
    assert spec["dit_dir"] == "models/dit_base"


def test_sft_enabled_with_ckpt_and_base_runner():
    spec = ove.MUSIC_MODELS["acestep-v15-sft"]
    assert spec["enabled"] is True
    assert spec["runner"] == "scripts/generate_t2m_base.py"
    assert spec["dit_dir"] == "models/dit_sft"
    assert spec["ckpt"] == "models--ACE-Step--acestep-v15-sft"
    e = ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                      duration_sec=12, model="acestep-v15-sft",
                      device="HETERO", out_path="/tmp/t.wav")
    assert e["T2M_CKPT"] == "models--ACE-Step--acestep-v15-sft"
    assert e["T2M_DIT_DIR"] == "models/dit_sft"


def test_setup_params_defaults():
    p = MusicSetupParams()
    assert p.action == "install" and p.deep is True and p.dry_run is False


# ── env mapping (the backend contract) ──────────────────────────────────────

def test_build_env_hetero_pins_projout():
    e = ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                      duration_sec=12, model="acestep-v15-turbo",
                      device="HETERO", out_path="/tmp/t.wav")
    assert e["T2M_DIT_DEVICE"] == "GPU"
    assert e["T2M_HETERO_PIN"] == "proj_out"
    assert e["T2M_PREC_HINT"] == "f32"  # locked, never from params
    assert e["T2M_SEED"] == "7" and e["T2M_OUT"] == "/tmp/t.wav"


def test_build_env_cpu_has_no_pin():
    e = ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                      duration_sec=12, model="acestep-v15-turbo",
                      device="CPU", out_path="/tmp/t.wav")
    assert e["T2M_DIT_DEVICE"] == "CPU"
    assert e["T2M_HETERO_PIN"] == ""


def test_build_env_base_maps_cfg_and_dit_dir():
    e = ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                      duration_sec=12, model="acestep-v15-base",
                      device="HETERO", out_path="/tmp/t.wav",
                      negative="muddy", steps=30, guidance=5.0)
    assert e["T2M_DIT_DIR"] == "models/dit_base"
    assert e["T2M_NEGATIVE"] == "muddy"
    assert e["T2M_STEPS"] == "30" and e["T2M_GUIDANCE"] == "5.0"
    assert e["T2M_HETERO_PIN"] == "proj_out"


def test_build_env_turbo_omits_cfg_keys():
    e = ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                      duration_sec=12, model="acestep-v15-turbo",
                      device="HETERO", out_path="/tmp/t.wav")
    assert "T2M_NEGATIVE" not in e and "T2M_STEPS" not in e
    assert "T2M_GUIDANCE" not in e
    assert e["T2M_DIT_DIR"] == "models/dit"  # harmless: turbo runner ignores it


# ── status shape ────────────────────────────────────────────────────────────

def test_status_shape():
    s = ove.get_music_ov_status()
    assert s["ok"] is True
    assert set(s) >= {"models", "source_dir", "devices"}
    for name, m in s["models"].items():
        assert set(m) >= {"label", "enabled", "knobs", "notes"}
        if not m["enabled"]:
            assert m["disabled_reason"]
        else:
            assert isinstance(m["ir_present"], bool)


# ── generate: unknown model + missing artifacts fail loudly ─────────────────

def test_generate_disabled_model_fails_loud():
    p = MusicGenerateParams(model="acestep-v15-turbo")
    # Literal blocks shift1 at validation; force past it to test the op gate.
    # (Must stay a DISABLED entry — otherwise this spawns a real generation.)
    assert ove.MUSIC_MODELS["acestep-v15-turbo-shift1"]["enabled"] is False
    p.__dict__["model"] = "acestep-v15-turbo-shift1"
    r = _run(mops.music_generate(p))
    assert r.ok is False and "disabled" in r.error


def test_generate_missing_artifacts_fails_loud(monkeypatch):
    monkeypatch.setattr(ove, "manifest_for",
                        lambda model: ["nope.xml"])
    p = MusicGenerateParams()
    r = _run(mops.music_generate(p))
    assert r.ok is False and "music_ov_setup" in r.error


def test_generate_dry_run_ok(monkeypatch, tmp_path):
    # manifest_for -> a file that really exists under SOURCE_DIR (no spawning; dry run)
    monkeypatch.setattr(ove, "manifest_for",
                        lambda model: ["scripts/generate_t2m.py"])
    p = MusicGenerateParams(output_dir=str(tmp_path), dry_run=True)
    r = _run(mops.music_generate(p))
    assert r.ok is True and r.dry_run is True
    assert r.output_path and r.output_path.endswith(".wav")


def test_cover_flag_per_model():
    assert ove.MUSIC_MODELS["acestep-v15-turbo"]["cover"] is False
    assert ove.MUSIC_MODELS["acestep-v15-base"]["cover"] is True
    assert ove.MUSIC_MODELS["acestep-v15-sft"]["cover"] is True
    s = ove.get_music_ov_status()
    assert s["models"]["acestep-v15-base"]["cover"] is True
    assert s["vae_encoder_present"] in (True, False)


def test_build_env_cover_mapping():
    e = ove.build_env(prompt="x", lyrics="[Instrumental]", seed=7,
                      duration_sec=12, model="acestep-v15-base",
                      device="HETERO", out_path="/tmp/t.wav",
                      task="cover", src_audio="/m/guillotine.wav", repeat=2)
    assert e["T2M_SRC_AUDIO"] == "/m/guillotine.wav"
    assert e["T2M_REPEAT"] == "2"


def test_cover_rejected_for_turbo(monkeypatch, tmp_path):
    monkeypatch.setattr(ove, "manifest_for",
                        lambda model: ["scripts/generate_t2m.py"])
    p = MusicGenerateParams(model="acestep-v15-turbo", task="cover",
                            src_audio="x.wav", output_dir=str(tmp_path))
    r = _run(mops.music_generate(p))
    assert r.ok is False and "base/sft" in r.error


def test_cover_needs_src_audio(monkeypatch, tmp_path):
    monkeypatch.setattr(ove, "manifest_for",
                        lambda model: ["scripts/generate_t2m.py"])
    p = MusicGenerateParams(model="acestep-v15-base", task="cover",
                            output_dir=str(tmp_path))
    r = _run(mops.music_generate(p))
    assert r.ok is False and "src_audio" in r.error
