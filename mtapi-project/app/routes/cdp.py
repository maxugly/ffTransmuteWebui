"""CDP (Composers Desktop Project) HTTP surface — Phase 1 browser execution.

Spec: docs/cdp-integration-spec.md §7 (execution model), §9 Phase 1.

The DSP runs client-side: the vendored ``cdp-wasm`` package executes in a
module Worker in the browser. The server's three jobs are:

- ``GET  /status``    — is the vendored runtime present (honest setup hint)
- ``POST /prepare``   — validate an input path against the Phase-1 limits,
                        decode it to canonical 44.1 kHz float WAV via ffmpeg
                        (argv list, invariant 2), and hand the browser a token
- ``GET  /asset/{t}`` — serve the prepared WAV bytes (binary-safe)
- ``POST /artifact``  — take the rendered WAV bytes back, write them beside
                        the source (never-overwrite name), stamp the Media
                        Catalog (origin=generated, tool provenance)

Invariant 10: every failure is HTTP 200 with ``{"ok": false, "error": ...}``.
"""
from __future__ import annotations

import logging
import os
import re
import sqlite3
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Request
from starlette.responses import FileResponse, JSONResponse

from ..database import audio_db

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cdp", tags=["cdp"])

CDP_WASM_VERSION = "0.7.0"
VENDOR_DIRNAME = f"cdp-wasm-{CDP_WASM_VERSION}"

# Phase-1 caps (spec §7.3, spike-grounded): input ≤ 200 MB decoded WAV or
# ≤ 60 s at 44.1 kHz stereo, whichever binds first; >2 channels refused in
# Phase 1 (mono-only programs are handled per-channel in the Worker).
MAX_INPUT_SEC = 60.0
MAX_INPUT_BYTES = 200 * 1024 * 1024
MAX_CHANNELS = 2

TOKEN_TTL_SEC = 6 * 3600

# token -> {"wav": str, "src": str, "dur": float, "rate": int, "channels": int, "ts": float}
_PREPARED: dict[str, dict] = {}


def vendor_dir() -> Path:
    """Directory of the vendored cdp-wasm build (may not exist)."""
    return Path(__file__).resolve().parent.parent / "static" / "vendor" / VENDOR_DIRNAME


def _fail(error: str, **extra) -> JSONResponse:
    return JSONResponse({"ok": False, "error": error, **extra})


def _cleanup_tokens() -> None:
    now = time.time()
    stale = [t for t, v in _PREPARED.items() if now - v["ts"] > TOKEN_TTL_SEC]
    for t in stale:
        v = _PREPARED.pop(t)
        try:
            Path(v["wav"]).unlink(missing_ok=True)
        except OSError:
            pass


async def _probe(path: Path) -> dict:
    """ffprobe duration/channels/sample rate. Never raises."""
    import json as _json

    from app.shell import run_command

    # No -nostdin here: this ffprobe build (n9) rejects it as an unknown
    # option (invariant 13 — the flag is ffmpeg-only).
    argv = [
        "ffprobe", "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=channels,sample_rate:format=duration",
        "-of", "json", str(path),
    ]
    try:
        _code, out, _err = await run_command(argv)
        return _json.loads(out or "{}")
    except Exception:
        return {}


def register(app) -> None:
    app.include_router(router)

    @router.get("/status")
    async def cdp_status() -> JSONResponse:
        vdir = vendor_dir()
        manifest = vdir / "wasm" / "manifest.json"
        return JSONResponse({
            "ok": True,
            "vendored": vdir.is_dir() and manifest.is_file(),
            "version": CDP_WASM_VERSION,
            "vendorPath": f"/vendor/{VENDOR_DIRNAME}/src/index.js",
            "hint": "" if manifest.is_file() else (
                "CDP runtime not vendored — run mtapi-project/scripts/update_cdp_wasm.sh"
            ),
        })

    @router.post("/prepare")
    async def cdp_prepare(request: Request) -> JSONResponse:
        """Validate + decode an input to canonical WAV, return a token."""
        _cleanup_tokens()
        try:
            body = await request.json()
        except Exception:
            return _fail("invalid JSON body")
        path = body.get("path")
        if not isinstance(path, str) or not path.strip():
            return _fail("path is required")
        src = Path(path.strip()).expanduser()
        if not src.is_file():
            return _fail(f"file not found: {src}")

        # Spectral inputs pass through untouched: a .ana file is not audio, so
        # ffprobe/ffmpeg have nothing to say about it (spec §2.1 file types).
        # The bytes are served as-is for the Worker to stage into CDP's virtual FS.
        if src.suffix.lower() == ".ana":
            size = src.stat().st_size
            if size > MAX_INPUT_BYTES:
                return _fail(
                    f"spectral input is {size / 1048576:.0f} MB — over the "
                    f"{MAX_INPUT_BYTES // 1048576} MB Phase-1 cap")
            token = uuid.uuid4().hex
            _PREPARED[token] = {
                "wav": str(src), "src": str(src), "dur": None,
                "rate": None, "channels": 1, "decodedBytes": size,
                "ts": time.time(), "spectral": True,
            }
            return JSONResponse({
                "ok": True, "token": token, "spectral": True,
                "decodedBytes": size,
            })

        probe = await _probe(src)
        fmt = (probe.get("format") or {})
        streams = probe.get("streams") or []
        try:
            dur = float(fmt.get("duration") or 0.0)
        except (TypeError, ValueError):
            dur = 0.0
        channels = int(streams[0].get("channels") or 0) if streams else 0
        if dur <= 0:
            return _fail("no audio track found (ffprobe read no duration)")
        if dur > MAX_INPUT_SEC:
            return _fail(
                f"input is {dur:.1f} s — over the {MAX_INPUT_SEC:.0f} s Phase-1 cap; "
                "trim or downsample first (spec §7.3)")
        if channels > MAX_CHANNELS:
            return _fail(
                f"input has {channels} channels — Phase 1 handles mono/stereo only; "
                "mix down first")

        # Decode to canonical 44.1 kHz 32-bit float WAV (byte budget check on
        # the decoded size, not the source container).
        decoded = int(dur * 44100 * max(channels, 1) * 4)
        if decoded > MAX_INPUT_BYTES:
            return _fail(
                f"decoded input is {decoded / 1048576:.0f} MB — over the "
                f"{MAX_INPUT_BYTES // 1048576} MB Phase-1 cap; trim or downsample first")
        from app.shell import run_command

        token = uuid.uuid4().hex
        tmp_dir = Path(os.environ.get("MTAPI_TMPDIR", "/tmp")) / "mtapi-cdp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        wav = tmp_dir / f"cdp_{token}.wav"
        argv = [
            "ffmpeg", "-nostdin", "-y", "-loglevel", "error",
            "-i", str(src), "-vn", "-ar", "44100", "-c:a", "pcm_f32le",
            str(wav),
        ]
        code, _out, err = await run_command(argv)
        if code != 0 or not wav.exists() or wav.stat().st_size == 0:
            tail = (err or "").strip().splitlines()
            return _fail("ffmpeg decode failed: " + (tail[-1][:200] if tail else "no output"))
        _PREPARED[token] = {
            "wav": str(wav), "src": str(src), "dur": dur,
            "rate": 44100, "channels": channels or 1,
            "decodedBytes": decoded, "ts": time.time(),
        }
        log.info("[cdp] prepared %s -> %s (%.1fs, %dch)", src, token, dur, channels or 1)
        return JSONResponse({
            "ok": True, "token": token, "durationSec": round(dur, 3),
            "channels": channels or 1, "sampleRate": 44100,
            "decodedBytes": decoded,
        })

    @router.get("/asset/{token}")
    async def cdp_asset(token: str):
        """Serve the prepared bytes (canonical WAV or pass-through .ana)."""
        v = _PREPARED.get(token)
        if not v or not Path(v["wav"]).is_file():
            return _fail("unknown or expired token — run Prepare again")
        media_type = "application/octet-stream" if v.get("spectral") else "audio/wav"
        return FileResponse(v["wav"], media_type=media_type)

    @router.post("/artifact")
    async def cdp_artifact(request: Request) -> JSONResponse:
        """Ingest rendered bytes: write beside the source, stamp the catalog."""
        token = request.headers.get("x-cdp-token", "")
        v = _PREPARED.get(token)
        if not v:
            return _fail("unknown or expired token — run Prepare again")
        tool = (request.headers.get("x-cdp-tool") or "cdp").strip()[:80]
        name = (request.headers.get("x-cdp-name") or "").strip()
        name = re.sub(r"[^A-Za-z0-9._-]", "_", name)[:120]
        body = await request.body()
        if not body:
            return _fail("empty artifact body")
        if len(body) > MAX_INPUT_BYTES * 2:
            return _fail(f"artifact too large ({len(body)} bytes)")

        src = Path(v["src"])
        out_dir = src.parent
        stem = src.stem or "cdp"
        base = name or f"{stem}_cdp_{re.sub(r'[^a-z0-9]+', '', tool.lower())}.wav"
        # Only two artifact types exist in Phase 1: listenable WAV and the
        # pvoc spectral intermediate. Anything else is refused, not guessed.
        if not base.lower().endswith((".wav", ".ana")):
            base += ".wav"
        from ..pathutil import finalize_output_path

        try:
            # default_ext must be explicit: the helper's generic default is
            # .png, which would rename audio artifacts behind our back.
            out = finalize_output_path(out_dir / base, default_ext="")
            out.write_bytes(body)
        except OSError as exc:
            return _fail(f"artifact write failed: {exc}")

        # Media Catalog stamp: real audio this app generated → mine + AI-involved
        # (same rule as every op output, spec §6.1/§6.3). .ana intermediates are
        # derived artifacts, not pool/catalog citizens (spec §6.3 asset model).
        catalog_ok = False
        catalog_error = None
        if out.suffix.lower() == ".wav":
            try:
                audio_db.catalog_upsert(
                    str(out), origin="generated", generated_flag=True, status="pending",
                    batch_id=None, owned_dirs=None, is_video_fn=None, is_image_fn=None,
                )
                catalog_ok = True
            except sqlite3.Error as exc:
                catalog_error = str(exc)
                log.warning("[cdp] catalog stamp failed for %s: %s", out, exc)

        log.info("[cdp] artifact %s (%d bytes, tool=%s)", out, len(body), tool)
        return JSONResponse({
            "ok": True, "path": str(out), "size": out.stat().st_size,
            "tool": tool, "catalogStamped": catalog_ok,
            "catalogError": catalog_error,
        })

    # Registering the router also registers the artifact store cleanup on
    # shutdown is unnecessary — tokens are process-local and TTL-swept.
