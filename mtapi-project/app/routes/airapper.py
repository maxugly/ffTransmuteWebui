"""AI Rapper saved-track library routes (spec: docs/airapper-spec.md §4.2).

Layer B only. The workspace tiles themselves are NOT here — they ride the
existing desk form-state snapshot (§4.1); a separate `/api/airapper/state`
route would duplicate that snapshot and the named-project copy would omit the
tab entirely.

Invariant 10: every failure is HTTP 200 with {"ok": false, "error": ...} — this
route never returns 4xx/5xx for an op failure, including "not found" and
"payload rejected".
"""
from fastapi import FastAPI, Request

from .. import airapper_store as store


def register(app: FastAPI) -> None:
    @app.get("/api/airapper/tracks", tags=["airapper"])
    async def airapper_tracks_list():
        return {"ok": True, "tracks": store.list_tracks()}

    @app.get("/api/airapper/tracks/{track_id}", tags=["airapper"])
    async def airapper_tracks_detail(track_id: str):
        try:
            track = store.read_track_detail(track_id)
        except KeyError:
            return {"ok": False, "error": "Track not found"}
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "track": track}

    @app.post("/api/airapper/tracks", tags=["airapper"])
    async def airapper_tracks_save(request: Request):
        # The body is read by hand rather than declared as a Pydantic model:
        # FastAPI's validation gate answers 422 before a handler ever runs,
        # which breaks invariant 10. A bad payload here is an op failure and
        # must come back as HTTP 200 + ok:false.
        try:
            body = await request.json()
        except Exception:
            return {"ok": False, "error": "Body must be a JSON object"}
        if not isinstance(body, dict):
            return {"ok": False, "error": "Body must be a JSON object"}

        track_id = body.get("id")
        track_id = str(track_id).strip() if isinstance(track_id, str) and track_id.strip() else None
        try:
            track = store.save_track(body, track_id=track_id)
        except ValueError as e:
            # Cap / size rejection is a normal outcome, not an exception.
            return {"ok": False, "error": str(e)}
        except OSError as e:
            return {"ok": False, "error": f"Could not write track: {e}"}
        return {"ok": True, "track": track, "created": track_id is None}

    @app.delete("/api/airapper/tracks/{track_id}", tags=["airapper"])
    async def airapper_tracks_delete(track_id: str):
        if not store.delete_track(track_id):
            return {"ok": False, "error": "Track not found"}
        return {"ok": True, "deleted": track_id}