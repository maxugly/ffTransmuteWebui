"""FastAPI router for DECbars robotic rap step sequencer."""
from __future__ import annotations

import logging
from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import FileResponse

from ..audio import decbars
from ..audio.export import FORMATS

log = logging.getLogger("mtapi.decbars")


def register(app: FastAPI):
    @app.post("/api/decbars/synthesize-words")
    async def synthesize_words(payload: dict):
        text = str(payload.get("text") or "").strip()
        if not text:
            return {"ok": False, "error": "Please enter lyrics text"}
        voice = str(payload.get("voice") or "en")
        speed = int(payload.get("speed", 160))
        pitch = int(payload.get("pitch", 50))
        try:
            words = await decbars.synthesize_all_words(text, voice=voice, speed=speed, pitch=pitch)
            return {"ok": True, "words": words}
        except Exception as e:
            log.exception("DECbars synthesize failed")
            return {"ok": False, "error": str(e)}

    @app.post("/api/decbars/analyze-beat")
    async def analyze_beat(payload: dict):
        audio_path = str(payload.get("audio_path") or "").strip()
        if not audio_path:
            return {"ok": False, "error": "Missing audio path"}
        try:
            res = await decbars.analyze_beat_file(audio_path)
            return res
        except Exception as e:
            log.exception("DECbars analyze beat failed")
            return {"ok": False, "error": str(e)}

    @app.get("/api/decbars/sample/{session_id}/{filename}")
    async def get_sample(session_id: str, filename: str):
        path = decbars.SAMPLES_DIR / session_id / filename
        if not path.is_file():
            return {"ok": False, "error": "Sample not found"}
        return FileResponse(path, media_type="audio/wav")

    @app.post("/api/decbars/render-mix")
    async def render_mix(payload: dict):
        beat_path = str(payload.get("beat_path") or "").strip()
        if not beat_path:
            return {"ok": False, "error": "Missing backing track beat path"}
        words = payload.get("words") or []
        out_path = str(payload.get("out_path") or "").strip()
        if not out_path:
            out_path = str((decbars.ROOT / "outbox" / "decbars_mix.flac").resolve())
        fmt = str(payload.get("format") or "flac").lower()
        if fmt not in FORMATS:
            return {"ok": False, "error": f"Unsupported format: {fmt}"}
        settings = payload.get("settings") or {}

        try:
            res = await decbars.render_decbars_mix(
                beat_path=beat_path,
                word_placements=words,
                out_path=out_path,
                fmt=fmt,
                settings=settings,
            )
            return res
        except Exception as e:
            log.exception("DECbars render mix failed")
            return {"ok": False, "error": str(e)}
