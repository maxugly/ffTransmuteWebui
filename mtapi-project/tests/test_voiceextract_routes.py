"""Voice Extract routes: the job must run in the audio venv as a subprocess.

Tests stub the worker with a stdlib-only script so the plumbing (interpreter
lookup, progress tailing, result parsing, failure reporting) is covered
without loading any diarization model.
"""
import json
import time

import pytest
from starlette.testclient import TestClient

from app.main import app
from app.routes import voiceextract


@pytest.fixture
def client():
    return TestClient(app)


STUB_WORKER = """
import json, sys
progress = sys.argv[sys.argv.index("--progress-file") + 1]
with open(progress, "a") as handle:
    handle.write(json.dumps({"pct": 2, "msg": "Loading pyannote diarization pipeline"}) + "\\n")
    handle.write(json.dumps({"pct": 45, "msg": "Diarization done"}) + "\\n")
sys.stdout.write(%s + "\\n")
sys.stdout.flush()
"""

RESULT_OK = {
    "ok": True,
    "combined_path": "/tmp/combined.opus",
    "manifest_path": "/tmp/manifest.json",
    "out_dir": "/tmp/out",
    "total_segments": 7,
    "total_duration_s": 42.5,
}


def _stub(tmp_path, result):
    worker = tmp_path / "stub_worker.py"
    payload = json.dumps(json.dumps(result))
    worker.write_text(STUB_WORKER % payload)
    return worker


def _start(client, monkeypatch, tmp_path, result):
    monkeypatch.setattr(voiceextract, "voice_python", lambda: __import__("sys").executable)
    monkeypatch.setattr(voiceextract, "WORKER", _stub(tmp_path, result))
    monkeypatch.setattr(voiceextract, "PROGRESS_ROOT", tmp_path / "progress")
    body = {
        "audio_path": str(tmp_path / "episode.mp3"),
        "ref_clip_path": str(tmp_path / "ref.wav"),
        "similarity_threshold": 0.4,
    }
    res = client.post("/api/voiceextract/run", json=body)
    assert res.status_code == 200
    return res.json()


def _wait_for_job(job_id):
    deadline = time.time() + 20
    while time.time() < deadline:
        data = voiceextract._jobs[job_id]
        if data["status"] in ("done", "error"):
            return data
        time.sleep(0.2)
    raise AssertionError("voiceextract job never finished")


def test_run_refuses_without_audio_venv(client, monkeypatch, tmp_path):
    monkeypatch.setattr(voiceextract, "voice_python", lambda: None)
    res = client.post(
        "/api/voiceextract/run",
        json={"audio_path": "/a.mp3", "ref_clip_path": "/b.wav"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert "voice-venv" in data["error"] or "MTAPI_VOICE_PYTHON" in data["error"]


def test_run_requires_both_paths(client, monkeypatch, tmp_path):
    monkeypatch.setattr(voiceextract, "voice_python", lambda: __import__("sys").executable)
    res = client.post(
        "/api/voiceextract/run",
        json={"audio_path": "  ", "ref_clip_path": "/b.wav"},
    )
    assert res.json()["ok"] is False


def test_status_unknown_job(client):
    res = client.get("/api/voiceextract/status/does-not-exist")
    assert res.status_code == 200
    assert res.json()["ok"] is False


def test_job_streams_progress_then_completes(client, monkeypatch, tmp_path):
    started = _start(client, monkeypatch, tmp_path, RESULT_OK)
    assert started["ok"] is True

    job = _wait_for_job(started["job_id"])
    assert job["status"] == "done"
    assert job["pct"] == 100
    assert job["combined_path"] == "/tmp/combined.opus"
    assert job["out_dir"] == "/tmp/out"
    assert job["total_segments"] == 7
    assert job["total_duration_s"] == 42.5
    assert "Diarization done" in "\n".join(job["log"])

    poll = client.get(f"/api/voiceextract/status/{started['job_id']}").json()
    assert poll["ok"] is True and poll["status"] == "done"


def test_worker_failure_becomes_job_error(client, monkeypatch, tmp_path):
    started = _start(client, monkeypatch, tmp_path, {"ok": False, "error": "similarity too low"})
    job = _wait_for_job(started["job_id"])
    assert job["status"] == "error"
    assert job["error"] == "similarity too low"


def _worker_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location("voiceextract_worker", voiceextract.WORKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_output_rate_is_always_opus_legal():
    worker = _worker_module()
    # libsndfile refuses to write Opus at 44.1k/22.05k, which is what most
    # episodes actually are, so anything outside the Opus set must be moved.
    assert worker.pick_output_rate(44100) == 48000
    assert worker.pick_output_rate(22050) in worker.OPUS_RATES
    assert worker.pick_output_rate(16000) == 16000
    assert worker.pick_output_rate(48000) == 48000


def test_resample_matches_target_rate_and_passes_through():
    import numpy as np

    worker = _worker_module()
    seg = np.zeros((44100, 2), dtype="float32")
    assert worker.resample(seg, 44100, 48000).shape == (48000, 2)
    assert worker.resample(seg, 16000, 16000) is seg
