"""Playground catalog parity, correct model identity, and background downloads."""
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import job_control
from app.openvino_llm import catalog
from app.openvino_llm.config import load_config, save_config, validate_and_merge_config
from app.routes.openvino_llm import register


@pytest.fixture
def playground(tmp_path, monkeypatch):
    resources = tmp_path / "resources"
    resources.mkdir()
    models = [
        {"name": "OpenVINO/Small-int4-ov", "type": "openVINO", "maxContextSize": 4096,
         "supportsToolCalling": False, "supportsReasoning": False},
        {"name": "OpenVINO/Coder-int4-ov", "type": "openVINO", "maxContextSize": 131072,
         "supportsToolCalling": True, "supportsReasoning": True, "npuSupport": True},
        {"name": "OpenVINO/Vision-int4-ov", "type": "openVINO", "supportsVision": True},
        {"name": "Other/GGUF", "type": "llamaCPP"},
        {"name": "Other/Embed", "type": "embedding"},
        {"name": "../bad/path", "type": "openVINO"},
    ]
    (resources / "models.json").write_text(json.dumps(models))
    (resources / "model_config.json").write_text(json.dumps({"openvinoLLM": "./resources/custom-models"}))
    monkeypatch.setenv("MTAPI_AI_PLAYGROUND_RESOURCES", str(resources))
    monkeypatch.setenv("MTAPI_OPENVINO_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.setattr(catalog, "_download", {"state": "idle"})
    return resources


def _install(path):
    path.mkdir(parents=True, exist_ok=True)
    for name in ("openvino_model.xml", "openvino_model.bin", "config.json", "openvino_tokenizer.xml"):
        (path / name).write_text("test")


def test_catalog_uses_playground_metadata_and_shared_paths(playground):
    root = playground / "custom-models"
    installed = root / "OpenVINO---Small-int4-ov"
    _install(installed)
    data = catalog.model_catalog()
    assert data["source"] == str(playground / "models.json")
    assert data["warning"] is None
    small, coder, vision = data["models"]
    assert len(data["models"]) == 3
    assert small["installed"] is True
    assert small["model_path"] == str(installed)
    assert small["entry"]["context_window"] == 4096
    assert small["entry"]["capabilities"]["tools"] is False
    assert coder["installed"] is False
    assert coder["native_context_window"] == 131072
    assert coder["entry"]["context_window"] == 40960
    assert coder["entry"]["capabilities"]["reasoning"] is True
    assert coder["npu_support"] is True
    assert vision["selectable"] is True
    assert vision["entry"]["capabilities"]["vision"] is True
    cfg = load_config()
    cfg.runtime.engine = "genai"
    save_config(cfg)
    assert catalog.model_catalog()["models"][2]["selectable"] is False
    (installed / "openvino_model.bin").write_bytes(b"")
    assert catalog.model_catalog()["models"][0]["installed"] is False


@pytest.mark.parametrize("contents", [None, "broken JSON", "{}"])
def test_missing_or_invalid_catalog_uses_bundled_snapshot(playground, contents):
    path = playground / "models.json"
    if contents is None:
        path.unlink()
    else:
        path.write_text(contents)
    data = catalog.model_catalog()
    assert data["warning"]
    assert len(data["models"]) == 21
    assert any(m["id"] == "Qwen3-4B-int4-ov" for m in data["models"])


def test_model_switch_persists_correct_path_and_capabilities(playground):
    rows = catalog.model_catalog()["models"]
    first = validate_and_merge_config({"models": [rows[0]["entry"]], "active_model_id": rows[0]["id"]})
    save_config(first)
    second = validate_and_merge_config({
        "models": [first.active_model().model_dump(), rows[1]["entry"]],
        "active_model_id": rows[1]["id"],
    })
    save_config(second)
    saved = load_config()
    assert saved.active_model_id == rows[1]["id"]
    assert saved.runtime.model_path == rows[1]["model_path"]
    assert saved.active_model().capabilities.tools is True
    assert saved.active_model().tool_parser == "hermes3"
    assert saved.models[0].model_path == rows[0]["model_path"]


def test_catalog_routes_fail_with_http_200_and_download_allowlist(playground):
    app = FastAPI()
    register(app)
    client = TestClient(app)
    assert len(client.get("/api/openvino/models").json()["models"]) == 3
    for body in ([], {"model_id": "../../arbitrary"}):
        response = client.post("/api/openvino/models/download", json=body)
        assert response.status_code == 200
        assert response.json()["ok"] is False
    (playground / "models.json").write_text('[{"name":"OpenVINO/Bad", "type":"openVINO", "maxContextSize":"oops"}]')
    response = client.get("/api/openvino/models")
    assert response.status_code == 200
    assert response.json()["ok"] is False


def test_download_serialization_completion_and_failure(playground, monkeypatch):
    import huggingface_hub

    pending = []
    class DeferredThread:
        def __init__(self, *, target, args, daemon):
            pending.append((target, args))
        def start(self):
            pass

    monkeypatch.setattr(catalog.threading, "Thread", DeferredThread)
    files = ["openvino_model.xml", "openvino_model.bin", "config.json", "openvino_tokenizer.xml"]
    from types import SimpleNamespace
    monkeypatch.setattr(huggingface_hub.HfApi, 'model_info', lambda self, *a, **kw:
                        SimpleNamespace(sha='pinned', siblings=[SimpleNamespace(rfilename=n, size=7) for n in files]))

    def download(*, repo_id, filename, local_dir, **kwargs):
        path = Path(local_dir)
        path.mkdir(parents=True, exist_ok=True)
        (path / filename).write_text("weights")

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", download)
    response = catalog.start_download("Small-int4-ov")
    assert response["ok"] is True
    assert catalog.start_download("Coder-int4-ov")["ok"] is False
    target, args = pending.pop()
    target(*args)
    data = catalog.model_catalog()
    assert data["download"]["state"] == "complete"
    assert data["download"]["current"] == len(files)
    assert data["models"][0]["installed"] is True
    assert catalog.start_download("Small-int4-ov")["installed"] is True
    assert job_control.get_progress(args[1])["status"] == "done"

    def fail(**kwargs):
        raise OSError("Network unavailable")
    monkeypatch.setattr(huggingface_hub, "hf_hub_download", fail)
    catalog.start_download("Coder-int4-ov")
    target, args = pending.pop()
    target(*args)
    assert catalog.model_catalog()["download"]["state"] == "error"
    assert "OSError" in catalog.model_catalog()["download"]["message"]
    assert job_control.get_progress(args[1])["status"] == "error"
