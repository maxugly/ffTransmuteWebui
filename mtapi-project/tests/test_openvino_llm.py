"""Unit and route contract tests for the OpenVINO Local LLM Server tab (`openvino`).

Spec: docs/openvino-tab-spec.md
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.openvino_llm.cage import (
    CgroupPrlimitLauncher,
    SystemdScopeLauncher,
    UncagedLauncher,
    parse_mem_bytes,
    resolve_launcher,
)
from app.openvino_llm.config import (
    CageConfig,
    OpenVinoSettings,
    build_v1_models_payload,
    config_env_path,
    load_config,
    save_config,
    validate_and_merge_config,
)
from app.openvino_llm import worker as ov_worker


@pytest.fixture(autouse=True)
def _isolated_settings(tmp_path, monkeypatch):
    """Isolate settings.json and config.env to tmp_path for every test."""
    cfg_file = tmp_path / "settings.json"
    monkeypatch.setenv("MTAPI_OPENVINO_SETTINGS", str(cfg_file))
    yield cfg_file


def test_default_config_matches_cline_and_vinoapi_requirements():
    cfg = load_config()
    assert cfg.port == 2431
    assert cfg.host == "127.0.0.1"
    assert cfg.base_url == "http://127.0.0.1:2431/v1"
    assert cfg.model_source_url == "http://127.0.0.1:2431/v1/models"
    # Timeout default must be 300000 ms (300s), never 30000 ms
    assert cfg.timeout_ms == 300000
    assert cfg.active_model_id == "Qwen3-8B-int4-ov"
    active = cfg.active_model()
    assert active.context_window == 40960
    assert active.max_tokens == 4096
    assert active.capabilities.streaming is True
    assert active.capabilities.tools is True
    assert active.capabilities.reasoning is True
    assert active.capabilities.vision is False
    assert active.capabilities.prompt_cache is True
    # Memory cage defaults
    assert cfg.cage.memory_max == "9G"
    assert cfg.cage.memory_high == "8G"
    assert cfg.cage.memory_swap_max == "0"
    assert cfg.cage.oom_score_adjust == 1000
    assert cfg.runtime.device == "GPU"
    assert cfg.runtime.kv_cache_precision == "u4"
    assert cfg.runtime.preflight_min_mb == 8192


def test_save_config_writes_settings_json_and_config_env():
    merged = validate_and_merge_config(
        {
            "port": 2435,
            "timeout_ms": 450000,
            "context_window": 32768,
            "max_tokens": 8192,
            "models": ["Qwen3-8B-int4-ov", "DeepSeek-R1-Distill-Qwen-7B-int4-ov"],
            "active_model_id": "DeepSeek-R1-Distill-Qwen-7B-int4-ov",
            "cage": {
                "memory_max": "10G",
                "memory_high": "9G",
                "memory_swap_max": "0",
                "oom_score_adjust": 900,
            },
        }
    )
    save_config(merged)
    reloaded = load_config()
    assert reloaded.port == 2435
    assert reloaded.timeout_ms == 450000
    assert reloaded.active_model_id == "DeepSeek-R1-Distill-Qwen-7B-int4-ov"
    assert len(reloaded.models) == 2
    assert reloaded.active_model().context_window == 32768
    assert reloaded.active_model().max_tokens == 8192
    assert reloaded.cage.memory_max == "10G"

    env_txt = config_env_path().read_text(encoding="utf-8")
    assert "VINO_PORT=2435" in env_txt
    assert "VINO_TIMEOUT_MS=450000" in env_txt
    assert "VINO_MEMORY_MAX=10G" in env_txt


def test_systemd_scope_and_void_linux_cage_launchers():
    cage = CageConfig(
        backend="systemd_scope",
        memory_max="9G",
        memory_high="8G",
        memory_swap_max="0",
        oom_score_adjust=1000,
    )
    target = ["/venv/bin/python", "-m", "uvicorn", "app.openvino_llm.worker:app", "--port", "2431"]

    systemd_launcher = SystemdScopeLauncher()
    argv = systemd_launcher.build_argv(target, cage)
    assert argv[1:3] == ["--user", "--scope"]
    assert "MemoryMax=9G" in argv
    assert "MemoryHigh=8G" in argv
    assert "MemorySwapMax=0" in argv
    meta = systemd_launcher.post_spawn(999999999, cage)
    assert meta["oom_score_adjust"] == 1000
    assert "--" in argv
    sep_idx = argv.index("--")
    assert argv[sep_idx + 1 :] == target

    # Void Linux / no-systemd fallback
    void_launcher = resolve_launcher("cgroup_prlimit")
    assert isinstance(void_launcher, CgroupPrlimitLauncher)
    void_argv = void_launcher.build_argv(target, cage)
    assert void_argv[-len(target) :] == target

    # Uncaged
    uncaged = resolve_launcher("none")
    assert isinstance(uncaged, UncagedLauncher)
    assert uncaged.build_argv(target, cage) == target

    assert parse_mem_bytes("9G") == 9 * 1024**3
    assert parse_mem_bytes("8192M") == 8192 * 1024**2
    assert parse_mem_bytes("0") == 0
    assert parse_mem_bytes("infinity") is None


def test_v1_models_returns_complete_cline_metadata():
    cfg = load_config()
    payload = build_v1_models_payload(cfg, loaded_model_id="Qwen3-8B-int4-ov")
    assert payload["object"] == "list"
    assert len(payload["data"]) == 1
    card = payload["data"][0]
    assert card["id"] == "Qwen3-8B-int4-ov"
    assert card["context_length"] == 40960
    assert card["contextWindow"] == 40960
    assert card["max_model_len"] == 40960
    assert card["max_tokens"] == 4096
    assert card["maxTokens"] == 4096
    assert card["max_completion_tokens"] == 4096
    assert card["timeout"] == 300000
    assert card["timeout_ms"] == 300000
    assert card["capabilities"]["streaming"] is True
    assert card["capabilities"]["tools"] is True
    assert card["capabilities"]["reasoning"] is True
    assert card["capabilities"]["vision"] is False
    assert card["capabilities"]["prompt_cache"] is True
    assert card["model_info"]["hot"] is True


def test_worker_chat_completions_handles_cline_multiturn_without_422(monkeypatch):
    monkeypatch.setattr(ov_worker, "_keep_model_loaded", lambda: True)
    """Regression test: Cline sends array content blocks, null content with tool_calls,
    role='tool', and extra fields like stream_options/reasoning_effort. Must NEVER 422.
    """
    class _FakeEncodedIds:
        class data:
            size = 24

    class _FakeEncoded:
        input_ids = _FakeEncodedIds()

    class _FakeTokenizer:
        def apply_chat_template(self, msgs, add_generation_prompt=True, **kwargs):
            for m in msgs:
                assert isinstance(m["role"], str)
                assert isinstance(m["content"], str)
            return "TEMPLATED_PROMPT"

        def encode(self, prompt):
            return _FakeEncoded()

        def decode(self, tokens, skip_special_tokens=True):
            return ["Hello ", "from ", "OpenVINO!"]

    class _FakeGenConfig:
        max_new_tokens = 512
        apply_chat_template = True
        temperature = 0.7
        do_sample = True
        top_p = 0.95

    class _FakePipeline:
        def get_generation_config(self):
            return _FakeGenConfig()

        def get_tokenizer(self):
            return _FakeTokenizer()

        def generate(self, prompt, cfg, streamer):
            streamer.write(1)
            streamer. end()
            return "Hello from OpenVINO!"

    monkeypatch.setitem(ov_worker._state, "pipe", _FakePipeline())
    monkeypatch.setitem(ov_worker._state, "tok", _FakeTokenizer())
    monkeypatch.setitem(ov_worker._state, "model_state", "hot")
    monkeypatch.setitem(ov_worker._state, "loaded_model_id", "Qwen3-8B-int4-ov")

    client = TestClient(ov_worker.app)
    cline_payload = {
        "model": "Qwen3-8B-int4-ov",
        "messages": [
            {
                "role": "system",
                "content": [{"type": "text", "text": "You are Cline, an autonomous coding agent."}],
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Write spec.md"},
                    {"type": "text", "text": "Include /admin/status."},
                ],
            },
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path":"README.md"}'},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "# README content",
            },
        ],
        "stream": False,
        "max_tokens": 256,
        "temperature": 0.2,
        "reasoning_effort": "low",
        "stream_options": {"include_usage": True},
        "extra_cline_metadata": {"taskId": "12345"},
    }
    resp = client.post("/v1/chat/completions", json=cline_payload)
    assert resp.status_code == 200, f"Unexpected status {resp.status_code}: {resp.text}"
    data = resp.json()
    assert data["object"] == "chat.completion"
    assert "Hello from OpenVINO!" in data["choices"][0]["message"]["content"]
    assert data["usage"]["prompt_tokens"] == 24

    # Also test streaming SSE response
    cline_payload["stream"] = True
    stream_resp = client.post("/v1/chat/completions", json=cline_payload)
    assert stream_resp.status_code == 200
    assert "text/event-stream" in stream_resp.headers.get("content-type", "")
    assert "data: [DONE]" in stream_resp.text


def test_single_hot_model_guard_and_preflight_refusal(tmp_path, monkeypatch):
    """Verify that loading when MemAvailable < preflight_min_mb refuses cleanly,
    and loading a second model unloads the first one first (never >1 hot).
    """
    model_dir = tmp_path / "FakeModel-ov"
    model_dir.mkdir()
    (model_dir / "openvino_model.xml").write_text("<net/>", encoding="utf-8")
    cfg = load_config()
    cfg.runtime.engine = "genai"
    cfg.runtime.preflight_policy = "fixed"
    save_config(cfg)

    # 1. Force low MemAvailable -> preflight must refuse cleanly
    monkeypatch.setattr(ov_worker, "mem_available_mb", lambda: (2048, 15680))
    with pytest.raises(RuntimeError, match="Not enough memory headroom"):
        ov_worker.load_pipeline_sync(
            model_id="FakeModel-ov",
            model_path=str(model_dir),
        )
    assert ov_worker._state["model_state"] == "cold"

    # 2. Verify single-hot-model unload happens before loading a new model
    unload_calls = []
    orig_unload = ov_worker._unload_locked

    def _tracked_unload():
        unload_calls.append(ov_worker._state.get("loaded_model_id"))
        return orig_unload()

    monkeypatch.setattr(ov_worker, "_unload_locked", _tracked_unload)
    ov_worker._state["pipe"] = object()
    ov_worker._state["loaded_model_id"] = "OldModel-ov"
    ov_worker._state["model_state"] = "hot"

    with pytest.raises(RuntimeError, match="Not enough memory headroom"):
        ov_worker.load_pipeline_sync(
            model_id="NewModel-ov",
            model_path=str(model_dir),
        )
    assert unload_calls == ["OldModel-ov"]
    assert ov_worker._state.get("pipe") is None


def test_admin_routes_invariant_10_and_status():
    """Verify /admin/status, /admin/config, /admin/load, and /v1/models on main app."""
    from app.main import app

    client = TestClient(app)

    st = client.get("/admin/status")
    assert st.status_code == 200
    body = st.json()
    assert body["ok"] is True
    assert body["server"]["state"] == "down"
    assert body["server"]["port"] == 2431
    assert body["model"]["state"] == "cold"

    # Invariant 10: bad config port returns HTTP 200 + ok:false, NEVER 422
    bad_cfg = client.post("/admin/config", json={"port": 80})
    assert bad_cfg.status_code == 200
    assert bad_cfg.json()["ok"] is False
    assert "Port must be between" in bad_cfg.json()["error"]

    # Non-JSON / array body returns HTTP 200 + ok:false, NEVER 422
    non_obj = client.post(
        "/admin/config",
        content="[1, 2, 3]",
        headers={"Content-Type": "application/json"},
    )
    assert non_obj.status_code == 200
    assert non_obj.json()["ok"] is False

    # Calling /admin/load while server is Down returns HTTP 200 + ok:false
    load_down = client.post("/admin/load", json={})
    assert load_down.status_code == 200
    assert load_down.json()["ok"] is False
    assert "Server is Down" in load_down.json()["error"]

    # Saving valid config updates /v1/models immediately
    save_ok = client.post(
        "/admin/config",
        json={
            "port": 2431,
            "timeout_ms": 360000,
            "context_window": 32768,
            "max_tokens": 4096,
            "models": ["Qwen3-8B-int4-ov", "Custom-Coder-7B-ov"],
            "active_model_id": "Qwen3-8B-int4-ov",
        },
    )
    assert save_ok.status_code == 200
    assert save_ok.json()["ok"] is True

    models_res = client.get("/v1/models")
    assert models_res.status_code == 200
    mdata = models_res.json()["data"]
    assert [m["id"] for m in mdata] == ["Qwen3-8B-int4-ov", "Custom-Coder-7B-ov"]
    assert mdata[0]["context_length"] == 32768
    assert mdata[0]["timeout_ms"] == 360000

    # /admin/kill-stray route returns HTTP 200 + ok:true and killed list
    ks = client.post("/admin/kill-stray", json={"pids": [999999999]})
    assert ks.status_code == 200
    assert ks.json()["ok"] is True
    assert isinstance(ks.json()["killed"], list)
    assert isinstance(ks.json()["server"]["stray_processes"], list)
