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
from app.operations import deepdream_ov_engine_v2 as ove_v2  # noqa: E402
from app.operations import deepdream_ov_engine_v3 as ove_v3  # noqa: E402
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


def test_v3_octave_shapes_and_layer_mapping():
    assert ove_v3.octave_shapes(4) == [(186, 186), (261, 261), (365, 365), (512, 512)]
    mapped = ove_v3.resolve_v3_weights(
        layer_weights={"mixed4": 1.0, "mixed5": 1.5, "mixed6": 2.0, "mixed7": 2.5}
    )
    assert mapped == {"5b": 1.0, "5c": 1.5, "6a": 1.0, "6b": 1.0, "6c": 3.5}


def test_v3_compatibility_and_turbo_contract():
    note = ove_v3.check_compatible(
        layer_weights={"5b": 1.0, "6c": 2.0},
        turbo=True,
        num_octave=2,
    )
    assert "Turbo forward-only" in note
    with pytest.raises(RuntimeError, match="engine=gpu_v3 incompatible"):
        ove_v3.check_compatible(model_name="vgg16")
    with pytest.raises(RuntimeError, match="engine=gpu_v3 incompatible"):
        ove_v3.check_compatible(octave_scale=2.0)
    assert "Turbo forward-only" in ove_v3.check_compatible(
        turbo=True,
        turbo_strength=0.0,
    )


def test_v3_params_and_filter_factory():
    p = DeepDreamParams(
        input_path="/abs/x.png",
        engine="gpu_v3",
        layer_preset="custom",
        custom_layer_weights={"5b": 1.0, "6c": 2.0},
        turbo=True,
        turbo_strength=0.4,
    )
    assert p.engine == "gpu_v3"
    from app.filters import deepdream as ddf

    fn = ddf.make_deepdream_filter(
        engine="gpu_v3",
        layer_preset="custom",
        layer_weights=p.custom_layer_weights,
        turbo=True,
        turbo_strength=p.turbo_strength,
        num_octave=1,
    )
    assert fn.kind == "per_frame"
    assert fn.stage_name == "deepdream-v3"


def test_v3_pair_fails_clean_without_ir(tmp_path, monkeypatch):
    monkeypatch.setattr(ove_v3, "resolve_artifacts_dir", lambda kind="ascent": None)
    content = _make_png(tmp_path / "c.png")
    result = ove_v3.dream_pair(content, tmp_path / "out.png", iterations=1, num_octave=1)
    assert result["ok"] is False
    assert "export_v3.py" in result["error"]


def test_v3_status_shape():
    status = get_deepdream_ov_status()["v3"]
    assert status["ir_present"] in (True, False)
    assert status["turbo_present"] in (True, False)
    assert status["baked"]["model"] == "inception_v3"
    assert status["baked"]["layers"] == [
        "Mixed_5b", "Mixed_5c", "Mixed_6a", "Mixed_6b", "Mixed_6c",
    ]


def test_turbo_is_ignored_off_v3_never_a_hard_fail(tmp_path):
    """Turbo is a V3-only knob whose row is hidden for every other engine, so a
    leftover/restored value must not fail CPU/V1/V2 — the owning engine simply
    never consumes it. It is named in the summary so it is not silent."""
    source = _make_png(tmp_path / "c.png")
    for engine in ("cpu", "gpu", "gpu_v2"):
        result = _run(deepdream_op(DeepDreamParams(
            input_path=str(source), engine=engine, turbo=True, dry_run=True,
        )))
        assert result.ok is True, (engine, result.error)
        assert "turbo=ignored" in (result.command or ""), engine


def test_turbo_still_runs_on_v3(tmp_path):
    source = _make_png(tmp_path / "c.png")
    result = _run(deepdream_op(DeepDreamParams(
        input_path=str(source), engine="gpu_v3", turbo=True, turbo_strength=0.4,
        dry_run=True,
    )))
    assert result.ok is True, result.error
    assert "turbo=on strength=0.4" in (result.command or "")


# ── version isolation: the three engines are separate products ───────────────

def test_each_engine_names_itself_in_gate_errors():
    """A gpu_v2 run must never be reported as engine=gpu (V1). The old shared
    string is what made a V2 failure look like the wrong engine was selected."""
    assert ove.ENGINE_ID == "gpu"
    assert ove_v2.ENGINE_ID == "gpu_v2"
    assert ove_v3.ENGINE_ID == "gpu_v3"
    for engine_module in (ove, ove_v2, ove_v3):
        with pytest.raises(RuntimeError) as exc:
            engine_module.check_compatible(model_name="vgg16")
        assert f"engine={engine_module.ENGINE_ID} incompatible" in str(exc.value)


def test_v2_layer_cycle_error_says_v2():
    with pytest.raises(RuntimeError) as exc:
        ove_v2.check_compatible(layer_cycle=True)
    assert "engine=gpu_v2" in str(exc.value)
    assert "GPU V2 bakes a single ascent layer" in str(exc.value)


def test_stills_ignore_video_only_layer_cycle(tmp_path):
    """layer_cycle is a per-frame video concept; the stills path never consumes
    it (CPU ignores it there too), so a still must not fail over it. This was
    the exact V1/V2 outage: a restored Layer cycle=1 lives in the hidden
    video-only bank and blocked every GPU still with an off-screen knob."""
    src = _make_png(tmp_path / "c.png")
    for engine in ("gpu", "gpu_v2"):
        p = DeepDreamParams(
            input_path=str(src), engine=engine, layer_cycle=True, dry_run=True,
        )
        r = _run(deepdream_op(p))
        assert r.ok is True, (engine, r.error)


def test_video_layer_cycle_still_fails_loudly(tmp_path):
    """On a real video run layer_cycle IS consumed → V1/V2 must fail loudly
    (both bake one ascent layer) and name the engine the user picked."""
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"fake")
    for engine, expect in (("gpu", "engine=gpu "), ("gpu_v2", "engine=gpu_v2 ")):
        p = DeepDreamParams(
            input_path=str(clip), media_kind="video", engine=engine,
            layer_cycle=True, dry_run=True,
        )
        r = _run(deepdream_op(p))
        assert r.ok is False, engine
        assert expect in (r.error or ""), (engine, r.error)
        assert "layer_cycle" in (r.error or "")


def test_v3_accepts_layer_cycle_because_it_implements_it(tmp_path):
    """V3 is the one GPU engine that cycles taps per frame, so layer_cycle is
    legal there and is surfaced in the baked-layer note rather than dropped."""
    src = _make_png(tmp_path / "c.png")
    p = DeepDreamParams(
        input_path=str(src), engine="gpu_v3", layer_cycle=True, dry_run=True,
    )
    r = _run(deepdream_op(p))
    assert r.ok is True, r.error
    note = ove_v3.check_compatible(layer_cycle=True)
    assert "layer_cycle=on" in note


def test_v3_status_survives_a_broken_v3_engine(monkeypatch):
    """The tab's status line reads V1 and V3 from one payload, so a V3 failure
    must degrade to an error string instead of taking the endpoint — and with
    it the V1/V2 verdict — down."""
    def _boom(*a, **kw):
        raise RuntimeError("v3 exploded")

    monkeypatch.setattr(ove_v3, "resolve_artifacts_dir", _boom)
    status = get_deepdream_ov_status()
    assert status["ok"] is True
    assert status["ir_present"] in (True, False)
    assert status["v3"]["ir_present"] is False
    assert "v3 exploded" in status["v3"]["error"]


def test_status_lists_each_engine_separately():
    status = get_deepdream_ov_status()
    assert set(status["engines"]) == {"gpu", "gpu_v2", "gpu_v3"}
    assert status["engines"]["gpu_v2"]["id"] == "gpu_v2"
    assert status["engines"]["gpu_v3"]["id"] == "gpu_v3"


def test_v3_artifacts_never_resolve_into_v1_dirs(monkeypatch, tmp_path):
    """V1/V2 and V3 own separate artifact trees. V3 used to search $OVS_DD_DIR
    and the V1 dev fallback, so a V1 directory could become a V3 runtime root."""
    monkeypatch.setenv("OVS_DD_DIR", str(tmp_path))
    monkeypatch.setenv("OVS_DD_SRC", str(tmp_path))
    monkeypatch.setenv("OVS_DD_V3_DIR", str(tmp_path))
    candidates = [str(p) for p in ove_v3.artifacts_candidates()]
    assert candidates[0] == str(tmp_path), candidates
    assert len(candidates) == 2, candidates
    assert "deepdream_ov_v3" in candidates[1], candidates
    assert not any("testLamaEraser" in c for c in candidates), candidates
    # …and the V1 engine is likewise unaware of the V3 tree.
    assert not any("deepdream_ov_v3" in str(p) for p in ove.artifacts_candidates())


def test_v1_and_v2_still_share_the_static_ir_set():
    """V2 is V1's graph with a different execution profile (selective FP16 +
    persistent requests) — same IRs, same baked layer, same gate rules."""
    assert ove_v2._ir_name((186, 186)) == ove._ir_name((186, 186))
    assert ove_v2.OV_LAYER == ove.OV_LAYER
    assert ove_v2.octave_shapes(4) == ove.octave_shapes(4)
    assert ove_v2._ir_name((186, 186)) != ove_v3._ir_name((186, 186))


# ── frontend wiring (static, no browser) ─────────────────────────────────────
# The Layer cycle outage was half frontend: the restored value was written into
# the hidden input without repainting the knob, so the UI read "Off" while every
# run sent On. These lock the honesty rules at source.

STATIC = ROOT / "app" / "static"


def test_knobs_repaint_from_the_hidden_input_value():
    """A programmatic write (form-state restore, engine switch, hydration) must
    repaint both knob systems, or the knob lies about the payload it sends."""
    knobs = (STATIC / "js" / "ui" / "knobs.js").read_text(encoding="utf-8")
    assert knobs.count("hiddenInput.addEventListener('change'") == 2, (
        "both setupContinuousKnob and setupBinaryKnob must re-sync on change"
    )


def test_every_knobs_importer_is_cache_busted():
    """app.js and deepdream.js imported knobs.js unversioned, so the browser
    could serve a cached copy and hide the fix (the 8.074 / sequence-erase trap).
    The knob engine is global — every importer must move together."""
    import re

    importers = [
        path for path in STATIC.rglob("*.js")
        if "/js/ui/knobs.js" in path.read_text(encoding="utf-8")
    ]
    assert len(importers) >= 20, len(importers)
    versions = set()
    for path in importers:
        for found in re.findall(r"/js/ui/knobs\.js(\?v=\d+)?", path.read_text(encoding="utf-8")):
            versions.add(found)
    assert versions == {"?v=6"}, versions


def test_leaving_v3_turns_turbo_off():
    """The Turbo row is hidden for every non-V3 engine, so a leftover On could
    not be seen or undone by the user."""
    js = (STATIC / "js" / "tabs" / "deepdream.js").read_text(encoding="utf-8")
    assert "if (dreamEng.value !== 'gpu_v3')" in js
    assert "Turbo off — GPU V3 only" in js


def test_status_line_names_the_selected_engine():
    """Per-engine verdicts, so 'which version is broken' is answerable without
    running it (V1/V2 share the static IR set; V3 has its own export)."""
    js = (STATIC / "js" / "tabs" / "deepdream.js").read_text(encoding="utf-8")
    assert "GPU status: [${sel}]" in js
    assert "V1/V2 IR ${staticIr}" in js
