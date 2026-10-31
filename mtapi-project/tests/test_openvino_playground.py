"""Native Playground launch profile, memory policy and OpenAI forwarding."""
import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

from app.openvino_llm import playground, worker
from app.openvino_llm.config import OpenVinoSettings, load_config, save_config, validate_and_merge_config


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("MTAPI_OPENVINO_SETTINGS", str(tmp_path / "settings.json"))
    original = dict(worker._state)
    worker._state.update(pipe=None, tok=None, loaded_model_id=None, model_state="cold")
    yield
    worker._state.clear()
    worker._state.update(original)


def test_launch_profile_matches_installed_playground(tmp_path, monkeypatch):
    cfg = OpenVinoSettings()
    root = tmp_path / "ovms"
    (root / "bin").mkdir(parents=True)
    (root / "bin/ovms").touch()
    cfg.runtime.runtime_overlay_path = str(root)
    entry = cfg.active_model()
    entry.tool_parser = "gptoss"
    monkeypatch.setenv("VIRTUAL_ENV", "/foreign/.venv")
    monkeypatch.setenv("PYTHONHOME", "/foreign/python")
    monkeypatch.setenv("PYTHONPATH", "/foreign/packages")
    monkeypatch.setenv("PATH", "/foreign/.venv/bin:/usr/bin")
    argv, env, cwd = playground.build_launch(cfg, entry, tmp_path / "OpenVINO---Model", "GPU", "u4", 23456)
    options = dict(zip(argv[1::2], argv[2::2]))
    assert options["--source_model"] == "OpenVINO---Model"
    assert options["--task"] == "text_generation"
    assert options["--rest_workers"] == "4"
    assert options["--tool_parser"] == "gptoss"
    assert options["--reasoning_parser"] == "qwen3"
    assert options["--cache_size"] == "0"
    assert options["--max_num_seqs"] == "256"
    assert options["--enable_prefix_caching"] == "true"
    assert options["--kv_cache_precision"] == "u4"
    assert "--max_prompt_len" not in options
    assert "VIRTUAL_ENV" not in env
    assert "/foreign" not in env.get("PYTHONPATH", "")
    assert "/foreign" not in env.get("PYTHONHOME", "")
    assert "/foreign/.venv/bin" not in env["PATH"]
    assert cwd == str(root)
    argv, _, _ = playground.build_launch(cfg, entry, tmp_path / "Model", "NPU", "auto", 23456)
    assert "--max_prompt_len" in argv and "--kv_cache_precision" not in argv


def test_tiny_model_not_blocked_by_legacy_eight_gb_gate(tmp_path, monkeypatch):
    cfg = load_config()
    assert cfg.runtime.engine == cfg.runtime.preflight_policy == "playground"
    directory = tmp_path / "TinyLlama"
    directory.mkdir()
    closed = []

    class NativeRuntime:
        running = True
        proc = None
        error = None
        argv = ["ovms"]
        def __init__(self, *args):
            pass
        def close(self):
            closed.append(True)

    monkeypatch.setattr(worker, "PlaygroundRuntime", NativeRuntime)
    monkeypatch.setattr(worker, "mem_available_mb", lambda: (7903, 15825))
    result = worker.load_pipeline_sync(model_id="TinyLlama", model_path=str(directory))
    assert result["hot"] is True
    worker.unload_pipeline_sync()
    assert closed == [True]
    cfg.runtime.preflight_policy = "fixed"
    save_config(cfg)
    with pytest.raises(RuntimeError, match="7903MB < preflight 8192MB"):
        worker.load_pipeline_sync(model_id="TinyLlama", model_path=str(directory))


@pytest.mark.parametrize("patch", [
    {"engine": "other"}, {"preflight_policy": "other"}, {"ovms_cache_size_gb": -1},
    {"ovms_rest_workers": 0}, {"ovms_max_num_seqs": "bad"},
])
def test_native_settings_validation(patch):
    with pytest.raises(ValueError):
        validate_and_merge_config({"runtime": patch})


def test_native_request_preserves_tools_images_and_thinking():
    entry = OpenVinoSettings().active_model()
    body = {
        "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}]},
                     {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "read", "arguments": "{}"}}]},
                     {"role": "tool", "tool_call_id": "call_1", "content": "result"}],
        "tools": [{"type": "function", "function": {"name": "read"}}],
        "tool_choice": "auto", "max_completion_tokens": 99999, "enable_thinking": False,
    }
    result = playground.request_payload(body, entry)
    assert result["messages"] == body["messages"]
    assert result["tools"] == body["tools"]
    assert result["tool_choice"] == "auto"
    assert result["max_tokens"] == entry.max_tokens
    assert result["chat_template_kwargs"] == {"enable_thinking": False}
    assert "max_completion_tokens" in body  # original request not mutated


@pytest.mark.parametrize("keepalive", [True, False])
def test_native_chat_forwards_json_and_sse(monkeypatch, keepalive):
    cfg = OpenVinoSettings()
    cfg.runtime.enable_sse_keepalive = keepalive
    entry = cfg.active_model()
    received = []

    def handler(request):
        data = json.loads(request.content)
        received.append(data)
        if data.get("stream"):
            content = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1"}]}}]}\n\ndata: [DONE]\n\n'
            return httpx.Response(200, text=content, headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "hello"}}]})

    transport = httpx.MockTransport(handler)
    client_class = httpx.AsyncClient
    monkeypatch.setattr(playground.httpx, "AsyncClient", lambda **kw: client_class(transport=transport, **kw))
    runtime = type("Runtime", (), {"base_url": "http://127.0.0.1:9999"})()
    state = {}

    async def exercise():
        result = await playground.chat(runtime, {"messages": [], "stream": False}, cfg, entry, state)
        assert json.loads(result.body)["choices"][0]["message"]["content"] == "hello"
        result = await playground.chat(runtime, {"messages": [], "stream": True}, cfg, entry, state)
        chunks = [chunk async for chunk in result.body_iterator]
        assert any('"tool_calls"' in chunk for chunk in chunks)
        assert any("[DONE]" in chunk for chunk in chunks)
        assert state["generating"] is False

    asyncio.run(exercise())
    assert received[0]["model"] == entry.id


def test_managed_ovms_child_not_reported_as_orphan(tmp_path, monkeypatch):
    from app.openvino_llm import cage
    for pid in (101, 201):
        directory = tmp_path / str(pid)
        directory.mkdir()
        (directory / "cmdline").write_bytes(b"/home/m/.local/share/ai-playground/resources/OpenVINO/ovms/bin/ovms\x00")
    monkeypatch.setattr(cage, "Path", lambda value: tmp_path if str(value) == "/proc" else Path(value))
    monkeypatch.setattr(cage, "_descendant_pids", lambda root: {100, 101})
    monkeypatch.setattr(cage, "process_rss_mb", lambda pid: 64)
    assert [p["pid"] for p in cage.detect_orphaned_ovms(exclude_pid=100)] == [201]


def test_shell_capture_compatibility_and_managed_server_output():
    from app import shell
    argv = [sys.executable, "-c", "import sys; print('stdout'); print('stderr', file=sys.stderr)"]
    code, stdout, stderr = asyncio.run(shell.run_command(argv))
    assert code == 0 and stdout.strip() == "stdout" and stderr.strip() == "stderr"
    children = []
    code, stdout, stderr = asyncio.run(shell.run_command(argv, on_spawn=children.append, capture_output=False))
    assert code == 0 and stdout == stderr == ""
    assert children[0].returncode == 0


def test_quick_test_accepts_running_server_and_surfaces_native_errors(monkeypatch):
    from app.openvino_llm import supervisor
    instance = supervisor.OpenVinoSupervisor()
    instance._proc = type("Process", (), {"returncode": None})()
    monkeypatch.setattr(supervisor, "_http_json", lambda *args: (200, {
        "choices": [{"message": {"content": "hello"}}], "usage": {"completion_tokens": 1},
    }))
    result = asyncio.run(instance.test_chat(prompt="Hello"))
    assert result["ok"] is True and result["reply"] == "hello"
    monkeypatch.setattr(supervisor, "_http_json", lambda *args: (200, {"error": {"message": "Native failure"}}))
    result = asyncio.run(instance.test_chat(prompt="Hello"))
    assert result["ok"] is False and result["error"] == "Native failure"


def test_native_stop_failure_prevents_stacking_another_model():
    runtime = playground.PlaygroundRuntime.__new__(playground.PlaygroundRuntime)
    actions = []
    runtime.proc = type("Process", (), {
        "returncode": None, "terminate": lambda self: actions.append("terminate"),
        "kill": lambda self: actions.append("kill"),
    })()
    runtime.thread = type("Thread", (), {"join": lambda self, timeout: None, "is_alive": lambda self: True})()
    with pytest.raises(RuntimeError, match="refusing to stack"):
        runtime.close()
    assert actions == ["terminate", "kill"]


def test_context_budget_uses_exact_native_count_without_trimming_input():
    entry = OpenVinoSettings().active_model()
    entry.context_window = 2048
    payload = {"messages": [{"role": "system", "content": "keep all instructions"}],
               "tools": [{"type": "function", "function": {"name": "read"}}], "max_tokens": 1024}
    error = "Number of prompt tokens: 1556 + max tokens value: 1024 exceeds model max length: 2048"
    retry = playground.fit_context_budget(payload, error, entry)
    assert retry["max_tokens"] == 492
    assert retry["messages"] is payload["messages"]
    assert retry["tools"] is payload["tools"]
    assert payload["max_tokens"] == 1024


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("prompt_tokens", [1556, 2048, 2050])
def test_context_rejection_caps_output_or_explains_full_prompt(monkeypatch, stream, prompt_tokens):
    cfg = OpenVinoSettings()
    entry = cfg.active_model()
    entry.context_window = 2048
    calls = []
    error = (f"Number of prompt tokens: {prompt_tokens} + max tokens value: 1024 exceeds model max length: 2048"
             if prompt_tokens < 2048 else f"Number of prompt tokens: {prompt_tokens} exceeds model max length: 2048")
    def handler(request):
        data = json.loads(request.content)
        calls.append(data)
        if len(calls) == 1:
            return httpx.Response(400, json={"error": error})
        assert data["max_tokens"] == 492
        if stream:
            return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
        return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})
    client_class = httpx.AsyncClient
    monkeypatch.setattr(playground.httpx, "AsyncClient", lambda **kw: client_class(transport=httpx.MockTransport(handler), **kw))
    runtime = type("Runtime", (), {"base_url": "http://localhost:9999"})()
    body = {"messages": [{"role": "user", "content": "preserve prompt"}], "max_tokens": 1024, "stream": stream}
    async def exercise():
        response = await playground.chat(runtime, body, cfg, entry, {})
        if stream:
            text = "".join([chunk async for chunk in response.body_iterator])
            assert "[DONE]" in text
        else:
            assert response.status_code == 200
            text = response.body.decode()
        if prompt_tokens == 1556:
            assert '"OK"' in text and "context_length_exceeded" not in text
        else:
            assert "context_length_exceeded" in text
            assert "Shorten Cline" in text
    asyncio.run(exercise())
    assert len(calls) == (2 if prompt_tokens == 1556 else 1)
    assert all(call["messages"] == body["messages"] for call in calls)


@pytest.mark.parametrize("stream", [False, True])
def test_unrelated_native_error_is_not_retried(monkeypatch, stream):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(400, json={"error": "GPU driver unavailable"})
    client_class = httpx.AsyncClient
    monkeypatch.setattr(playground.httpx, "AsyncClient", lambda **kw: client_class(transport=httpx.MockTransport(handler), **kw))
    cfg = OpenVinoSettings()
    runtime = type("Runtime", (), {"base_url": "http://localhost:9999"})()
    async def exercise():
        response = await playground.chat(runtime, {"messages": [], "stream": stream}, cfg, cfg.active_model(), {})
        text = "".join([chunk async for chunk in response.body_iterator]) if stream else response.body.decode()
        assert "GPU driver unavailable" in text
    asyncio.run(exercise())
    assert len(calls) == 1
