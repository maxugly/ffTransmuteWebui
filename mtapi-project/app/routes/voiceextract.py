"""Voice Extract tab routes.

POST /api/voiceextract/run   — start a diarization + speaker-match job
GET  /api/voiceextract/status/{job_id} — poll job status/progress

The heavy lifting runs as a subprocess in a separate interpreter (see
tools/voiceextract_worker.py): pyannote/SpeechBrain checkpoints cannot be
loaded by the PyTorch the server itself uses.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

from .. import shell

log = logging.getLogger("mtapi.voiceextract")

PROJECT_ROOT = Path(__file__).resolve().parents[2]
WORKER = PROJECT_ROOT / "tools" / "voiceextract_worker.py"
PROGRESS_ROOT = PROJECT_ROOT / "junk" / "voiceextract"

# in-memory job store (process lifetime)
_jobs: dict[str, dict] = {}


class VoiceExtractRequest(BaseModel):
    audio_path: str                     # full episode / long audio file
    ref_clip_path: str                  # short clip of the target speaker
    output_dir: Optional[str] = None    # blank → sibling dir of audio_path
    hf_token: Optional[str] = None      # HF token (falls back to env HF_TOKEN)
    similarity_threshold: float = 0.55  # cosine sim floor against ref centroid


def voice_python() -> Optional[str]:
    """Interpreter that can load the diarization models, or None if absent.

    Override with MTAPI_VOICE_PYTHON. Otherwise look for the audio venv next to
    the project, then one level up (kept out of the repo).
    """
    candidates = [
        os.environ.get("MTAPI_VOICE_PYTHON"),
        str(PROJECT_ROOT.parent / "voice-venv" / "bin" / "python"),
        str(PROJECT_ROOT / "voice-venv" / "bin" / "python"),
        str(PROJECT_ROOT.parent.parent / "voice-venv" / "bin" / "python"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return None


MISSING_VENV = (
    "Voice Extract needs its own Python environment (PyTorch 2.5.x) because "
    "pyannote checkpoints are rejected by torch.load(weights_only=True). "
    "Create it once:\n"
    "  uv venv voice-venv --python 3.11\n"
    "  uv pip install --python voice-venv/bin/python -r "
    "mtapi-project/tools/requirements-voice.txt\n"
    "Or point MTAPI_VOICE_PYTHON at any interpreter that has pyannote.audio "
    "and speechbrain importable."
)


def _read_progress(job: dict, progress_path: Path, state: dict) -> None:
    """Append any new worker progress lines to the job log / percentage."""
    try:
        lines = progress_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines[state["seen"]:]:
        state["seen"] += 1
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = entry.get("msg")
        if not message:
            continue
        job["log"].append(message)
        if entry.get("pct") is not None:
            job["pct"] = entry["pct"]


async def _execute(job: dict, argv: list[str], progress_path: Path, env: dict) -> None:
    state = {"seen": 0}
    stop = asyncio.Event()

    async def follow() -> None:
        while not stop.is_set():
            _read_progress(job, progress_path, state)
            await asyncio.sleep(0.5)

    watcher = asyncio.create_task(follow())
    try:
        code, stdout, stderr = await shell.run_command(argv, env=env)
    finally:
        stop.set()
        await watcher
    _read_progress(job, progress_path, state)

    result: Optional[dict] = None
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                result = json.loads(line)
            except json.JSONDecodeError:
                continue
            break

    if result and result.get("ok"):
        job.update(
            status="done",
            pct=100,
            combined_path=result.get("combined_path"),
            manifest_path=result.get("manifest_path"),
            out_dir=result.get("out_dir"),
            total_segments=result.get("total_segments"),
            total_duration_s=result.get("total_duration_s"),
        )
        return

    if result and result.get("error"):
        error = result["error"]
    elif code:
        error = f"Voice worker exited with code {code}:\n{(stderr or stdout)[-2000:]}"
    else:
        error = "Voice worker returned no result."
    job["status"] = "error"
    job["error"] = error
    job["log"].append(f"ERROR: {error}")


def _run_job(job_id: str, req: VoiceExtractRequest, interpreter: str) -> None:
    job = _jobs[job_id]
    progress_path = PROGRESS_ROOT / f"{job_id}.jsonl"
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    progress_path.write_text("", encoding="utf-8")

    argv = [
        interpreter, str(WORKER),
        "--audio", req.audio_path.strip(),
        "--ref", req.ref_clip_path.strip(),
        "--threshold", str(req.similarity_threshold),
        "--progress-file", str(progress_path),
    ]
    if req.output_dir and req.output_dir.strip():
        argv += ["--out-dir", req.output_dir.strip()]

    env = dict(os.environ)
    if req.hf_token:
        env["HF_TOKEN"] = req.hf_token

    try:
        asyncio.run(_execute(job, argv, progress_path, env))
    except Exception as exc:
        log.exception("[voiceextract %s] failed", job_id)
        job["status"] = "error"
        job["error"] = str(exc)
        job["log"].append(f"ERROR: {exc}")
    finally:
        progress_path.unlink(missing_ok=True)


def register(app: FastAPI) -> None:

    @app.post("/api/voiceextract/run")
    async def voiceextract_run(req: VoiceExtractRequest):
        interpreter = voice_python()
        if not interpreter:
            return {"ok": False, "error": MISSING_VENV}
        if not WORKER.is_file():
            return {"ok": False, "error": f"Voice worker script missing: {WORKER}"}
        if not req.audio_path.strip() or not req.ref_clip_path.strip():
            return {"ok": False, "error": "Both an audio path and a reference clip path are required."}

        job_id = str(uuid.uuid4())
        _jobs[job_id] = {
            "status": "running",
            "pct": 0,
            "log": [f"Starting voice worker ({interpreter})."],
            "error": None,
            "combined_path": None,
            "manifest_path": None,
        }
        threading.Thread(target=_run_job, args=(job_id, req, interpreter), daemon=True).start()
        return {"ok": True, "job_id": job_id}

    @app.get("/api/voiceextract/status/{job_id}")
    async def voiceextract_status(job_id: str):
        job = _jobs.get(job_id)
        if not job:
            return {"ok": False, "error": "Unknown job id"}
        return {"ok": True, **job}
