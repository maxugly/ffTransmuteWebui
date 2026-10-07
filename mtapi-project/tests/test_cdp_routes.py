"""Route-level checks for the CDP HTTP surface (spec: docs/cdp-integration-spec.md §7).

Uses the real FastAPI app via TestClient with the catalog DB pinned at a temp
file. The DSP itself runs in the browser Worker — here we prove the server
contract: limits enforced with concrete numbers (§7.3), canonical WAV decode
(binary-safe asset serving), artifact ingest beside the source with the
catalog stamp (§6.3: audio only, .ana intermediates are not catalog citizens),
and invariant 10 (every failure HTTP 200 + ok:false).
"""
from __future__ import annotations

import io
import struct
import sys
import wave
from pathlib import Path

import pytest
from starlette.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.database import audio_db  # noqa: E402
from app.main import app  # noqa: E402
from app.routes import cdp as cdp_routes  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(tmp_path / "catalog.db"))
    audio_db.init_db()
    yield TestClient(app)
    audio_db.set_db_path(prev)


def _write_wav(path: Path, secs: float = 2.0, rate: int = 44100, channels: int = 1) -> str:
    """Small real PCM wav — enough for ffprobe to read real duration."""
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(rate * secs)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        # a quiet sine so the file is real audio, not silence-as-corner-case
        for i in range(0, frames, 1000):
            chunk = b"".join(
                struct.pack("<h", int(8000 * ((i + j) % 1000) / 1000))
                for j in range(min(1000, frames - i))
            )
            w.writeframes(chunk)
    return str(path)


# ── status ────────────────────────────────────────────────────────────────
def test_status_reports_vendored_state(client, tmp_path, monkeypatch):
    monkeypatch.setattr(cdp_routes, "vendor_dir", lambda: tmp_path / "nope")
    res = client.get("/api/cdp/status")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["vendored"] is False
    assert "update_cdp_wasm.sh" in data["hint"]

    (tmp_path / "v" / "wasm").mkdir(parents=True)
    (tmp_path / "v" / "wasm" / "manifest.json").write_text("{}")
    monkeypatch.setattr(cdp_routes, "vendor_dir", lambda: tmp_path / "v")
    data = client.get("/api/cdp/status").json()
    assert data["vendored"] is True
    assert data["version"] == cdp_routes.CDP_WASM_VERSION


# ── prepare: validation + limits (spec §7.3, numbers in the refusal) ──────
def test_prepare_missing_file_ok_false(client, tmp_path):
    res = client.post("/api/cdp/prepare", json={"path": str(tmp_path / "nope.wav")})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert "not found" in data["error"]


def test_prepare_non_audio_ok_false(client, tmp_path):
    f = tmp_path / "text.txt"
    f.write_text("not audio")
    res = client.post("/api/cdp/prepare", json={"path": str(f)})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False


def test_prepare_accepts_real_wav_and_serves_asset(client, tmp_path):
    src = Path(_write_wav(tmp_path / "in" / "clip.wav", secs=2.0))
    res = client.post("/api/cdp/prepare", json={"path": str(src)})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["durationSec"] == pytest.approx(2.0, abs=0.2)
    assert data["channels"] == 1
    assert data["sampleRate"] == 44100

    asset = client.get(f"/api/cdp/asset/{data['token']}")
    assert asset.status_code == 200
    assert asset.content[:4] == b"RIFF"
    assert len(asset.content) > 44


def test_prepare_over_duration_blocked_with_numbers(client, tmp_path, monkeypatch):
    monkeypatch.setattr(cdp_routes, "MAX_INPUT_SEC", 1.0)
    src = Path(_write_wav(tmp_path / "long.wav", secs=2.0))
    res = client.post("/api/cdp/prepare", json={"path": str(src)})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    # the refusal must carry the real numbers, not a generic message (§7.3)
    assert "2.0" in data["error"] or "2" in data["error"]
    assert "1" in data["error"]


def test_prepare_spectral_passthrough(client, tmp_path):
    ana = tmp_path / "spec.ana"
    ana.write_bytes(b"\x01\x02" * 512)
    res = client.post("/api/cdp/prepare", json={"path": str(ana)})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["spectral"] is True
    asset = client.get(f"/api/cdp/asset/{data['token']}")
    assert asset.content == ana.read_bytes()


# ── artifact ingest (spec §6.3: beside source, catalog stamps audio only) ─
def _prepare(client, path):
    res = client.post("/api/cdp/prepare", json={"path": str(path)})
    data = res.json()
    assert data["ok"] is True, data
    return data["token"]


def test_artifact_writes_beside_source_and_stamps_catalog(client, tmp_path):
    src = Path(_write_wav(tmp_path / "in" / "clip.wav"))
    token = _prepare(client, src)
    payload = b"RIFFxxxxWAVEfake-but-nonempty" + b"\0" * 64
    res = client.post(
        "/api/cdp/artifact",
        content=payload,
        headers={"X-Cdp-Token": token, "X-Cdp-Tool": "blur.blur", "X-Cdp-Name": "cdp_blur_blur.wav"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    out = Path(data["path"])
    assert out.parent == src.parent           # written beside the source
    assert out.name.startswith("cdp_blur_blur")
    assert out.read_bytes() == payload
    assert data["catalogStamped"] is True
    row = audio_db.get_row(str(out))
    assert row is not None
    assert row["origin"] == "generated"


def test_artifact_never_overwrites(client, tmp_path):
    src = Path(_write_wav(tmp_path / "clip.wav"))
    token = _prepare(client, src)
    payload = b"RIFF-fake" + b"\0" * 32
    for _ in range(2):
        res = client.post(
            "/api/cdp/artifact", content=payload,
            headers={"X-Cdp-Token": token, "X-Cdp-Tool": "modify.speed", "X-Cdp-Name": "cdp_modify_speed.wav"})
        assert res.json()["ok"] is True
    paths = sorted(p.name for p in src.parent.glob("cdp_modify_speed*.wav"))
    assert len(paths) == 2  # _0001 suffix allocated, nothing overwritten


def test_artifact_ana_not_stamped_in_catalog(client, tmp_path):
    src = Path(_write_wav(tmp_path / "clip.wav"))
    token = _prepare(client, src)
    res = client.post(
        "/api/cdp/artifact", content=b"ANALYSIS-BYTES" * 8,
        headers={"X-Cdp-Token": token, "X-Cdp-Tool": "pvoc.anal", "X-Cdp-Name": "cdp_pvoc_anal.ana"})
    data = res.json()
    assert data["ok"] is True
    assert Path(data["path"]).suffix == ".ana"
    assert data["catalogStamped"] is False    # §6.3: derived artifact, not a citizen


def test_artifact_bad_token_ok_false(client):
    res = client.post(
        "/api/cdp/artifact", content=b"x",
        headers={"X-Cdp-Token": "deadbeef", "X-Cdp-Tool": "blur.blur", "X-Cdp-Name": "a.wav"})
    assert res.status_code == 200
    assert res.json()["ok"] is False


def test_prepared_tokens_do_not_leak_between_names(client, tmp_path):
    src = Path(_write_wav(tmp_path / "clip.wav"))
    token = _prepare(client, src)
    assert token in cdp_routes._PREPARED
    cdp_routes._cleanup_tokens()
    assert token in cdp_routes._PREPARED  # fresh token survives the sweep
    cdp_routes._PREPARED[token]["ts"] -= cdp_routes.TOKEN_TTL_SEC + 10
    cdp_routes._cleanup_tokens()
    assert token not in cdp_routes._PREPARED
