"""AI Rapper tab backend: saved-track library store + HTTP surface.

Spec: docs/airapper-spec.md §4 (two persistence layers), §8 (track ordering).

Layer B (the library) is what these tests cover. Layer A — the workspace tiles —
rides the existing desk form-state snapshot and is proven in the browser by the
Playwright script, not here.

Invariant 10 is asserted on every failure path: an op failure is HTTP 200 with
{"ok": false, "error": ...}, never 4xx/5xx. That includes "not found" and a
rejected payload.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import airapper_store as store  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv("MTAPI_AIRAPPER_ROOT", str(tmp_path / "airapper-home"))
    yield tmp_path


@pytest.fixture()
def client(isolated_store):
    return TestClient(app)


def _body(**over):
    base = {
        "title": "Tight Word",
        "description": "boom bap, grimy loop",
        "lyrics": "[Verse 1]\nTight word, slight urge",
        "tags": ["perlp_v1", "boom_bap"],
        "tempo": 95.0,
        "key": "C# minor",
        "swing": 58.0,
        "meter": "4/4",
    }
    base.update(over)
    return base


# ── store: validation ─────────────────────────────────────────────────────────

def test_normalize_clamps_ranges(isolated_store):
    out = store.normalize_track(_body(tempo=9999, swing=-40, meter="7/9"))
    assert out["tempo"] == 200.0
    assert out["swing"] == 0.0
    assert out["meter"] == "4/4"          # only 4/4, 3/4, 6/8 survive


def test_normalize_tempo_and_swing_lower_bounds(isolated_store):
    out = store.normalize_track(_body(tempo=1, swing=500))
    assert out["tempo"] == 40.0
    assert out["swing"] == 100.0


def test_normalize_rejects_nan_and_inf(isolated_store):
    out = store.normalize_track(_body(tempo=float("nan"), swing=float("inf")))
    assert out["tempo"] == 95.0
    assert out["swing"] == 0.0


def test_normalize_dedupes_tags_and_caps(isolated_store):
    tags = ["A", "a", "  ", "B"] + [f"t{i}" for i in range(60)]
    out = store.normalize_track(_body(tags=tags))
    assert out["tags"][:2] == ["A", "B"]     # case-insensitive dedupe
    assert len(out["tags"]) <= store.MAX_TAGS


def test_normalize_rejects_oversized_lyrics(isolated_store):
    with pytest.raises(ValueError):
        store.normalize_track(_body(lyrics="x" * (store.MAX_LYRICS_BYTES + 1)))


def test_normalize_drops_unknown_keys(isolated_store):
    """A posted payload cannot smuggle extra keys onto disk."""
    out = store.normalize_track(_body(evil="/etc/passwd", id="spoofed"))
    assert "evil" not in out and "id" not in out


# ── store: CRUD ───────────────────────────────────────────────────────────────

def test_save_then_list_and_detail(isolated_store):
    saved = store.save_track(_body())
    assert saved["id"] and saved["title"] == "Tight Word"
    assert saved["lyrics_bytes"] > 0

    listed = store.list_tracks()
    assert len(listed) == 1
    assert listed[0]["id"] == saved["id"]

    detail = store.find_by_id(saved["id"])
    assert detail["lyrics"] == _body()["lyrics"]
    assert detail["key"] == "C# minor"


def test_list_rows_omit_the_lyrics_body(isolated_store):
    """The list is a card feed — shipping every lyric would be a payload trap."""
    store.save_track(_body())
    assert "lyrics" not in store.list_tracks()[0]


def test_save_updates_in_place(isolated_store):
    first = store.save_track(_body())
    second = store.save_track(_body(title="Renamed"), track_id=first["id"])
    assert second["id"] == first["id"]
    assert second["created_at"] == first["created_at"]   # created_at is stable
    assert second["updated_at"] >= first["updated_at"]
    assert len(store.list_tracks()) == 1
    assert store.find_by_id(first["id"])["title"] == "Renamed"


def test_save_with_unknown_id_creates_rather_than_duplicates(isolated_store):
    store.save_track(_body(), track_id="does-not-exist")
    assert len(store.list_tracks()) == 1


def test_delete_removes_index_and_file(isolated_store):
    saved = store.save_track(_body())
    path = store.track_path(saved["id"])
    assert path.is_file()

    assert store.delete_track(saved["id"]) is True
    assert store.list_tracks() == []
    assert not path.exists()
    assert store.delete_track(saved["id"]) is False


def test_list_is_newest_first_not_title_length(isolated_store):
    """§8: created_at descending. A title-length sort would reshuffle these."""
    store.save_track(_body(title="aaa"))
    time.sleep(0.002)                      # created_at is ms-resolution
    store.save_track(_body(title="bbbbbbbbbbbb"))
    time.sleep(0.002)
    store.save_track(_body(title="cc"))

    listed = store.list_tracks()
    titles = [t["title"] for t in listed]
    stamps = [t["created_at"] for t in listed]
    assert stamps == sorted(stamps, reverse=True)        # the real contract
    assert titles == ["cc", "bbbbbbbbbbbb", "aaa"]
    assert titles != sorted(titles, key=len)              # not a title-length sort


def test_library_cap_raises_on_new_track(isolated_store, monkeypatch):
    monkeypatch.setattr(store, "MAX_TRACKS", 2)
    store.save_track(_body())
    store.save_track(_body())
    with pytest.raises(ValueError):
        store.save_track(_body())


def test_corrupt_index_reads_blank_and_never_raises(isolated_store):
    store.airapper_dir().mkdir(parents=True, exist_ok=True)
    store.index_path().write_text("{ not json", encoding="utf-8")
    assert store.list_tracks() == []
    assert store.load_index()["version"] == store.INDEX_VERSION


def test_traversal_id_cannot_escape_the_library(isolated_store):
    """A crafted id must not resolve to a path outside the airapper directory."""
    base = store.airapper_dir().resolve()
    for hostile in ("../../../etc/evil", "/etc/passwd", "..", "a/b/c"):
        resolved = store.track_path(hostile).resolve()
        assert base == resolved or base in resolved.parents
        assert store.track_path(hostile).name.endswith(".json")


def test_write_is_atomic_no_tmp_left_behind(isolated_store):
    store.save_track(_body())
    leftovers = list(store.airapper_dir().glob("*.tmp"))
    assert leftovers == []


# ── routes (invariant 10) ────────────────────────────────────────────────────

def test_routes_are_registered(client):
    paths = {r.path for r in app.routes if hasattr(r, "path")}
    assert "/api/airapper/tracks" in paths


def test_list_empty_is_ok(client):
    res = client.get("/api/airapper/tracks")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "tracks": []}


def test_post_get_delete_round_trip(client):
    res = client.post("/api/airapper/tracks", json=_body())
    assert res.status_code == 200
    created = res.json()
    assert created["ok"] is True and created["created"] is True
    track_id = created["track"]["id"]

    detail = client.get(f"/api/airapper/tracks/{track_id}")
    assert detail.status_code == 200
    assert detail.json()["track"]["lyrics"] == _body()["lyrics"]

    assert len(client.get("/api/airapper/tracks").json()["tracks"]) == 1

    gone = client.delete(f"/api/airapper/tracks/{track_id}")
    assert gone.status_code == 200 and gone.json()["ok"] is True
    assert client.get("/api/airapper/tracks").json()["tracks"] == []


def test_missing_track_is_200_not_404(client):
    res = client.get("/api/airapper/tracks/nope")
    assert res.status_code == 200
    assert res.json() == {"ok": False, "error": "Track not found"}


def test_delete_missing_is_200_not_404(client):
    res = client.delete("/api/airapper/tracks/nope")
    assert res.status_code == 200
    assert res.json()["ok"] is False


def test_payload_rejection_is_200_not_422(client):
    """A genuinely rejected payload is an op failure, not an HTTP error."""
    res = client.post("/api/airapper/tracks", json=_body(lyrics="x" * 600_000))
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "Lyrics too large" in body["error"]


def test_garbage_shapes_are_all_200(client):
    """Invariant 10 holds for every body shape — FastAPI must not answer 422."""
    for payload in (_body(tempo="not-a-number"), _body(tags="not-a-list"),
                    _body(tempo=None), {"unexpected": 1}, []):
        res = client.post("/api/airapper/tracks", json=payload)
        assert res.status_code == 200, payload
        assert res.json()["ok"] in (True, False)

    not_json = client.post("/api/airapper/tracks", content=b"<<<not json",
                           headers={"Content-Type": "application/json"})
    assert not_json.status_code == 200
    assert not_json.json() == {"ok": False, "error": "Body must be a JSON object"}

    not_object = client.post("/api/airapper/tracks", json=[1, 2, 3])
    assert not_object.status_code == 200
    assert not_object.json() == {"ok": False, "error": "Body must be a JSON object"}


def test_clamped_values_are_accepted_not_rejected(client):
    """Out-of-range numbers are clamped by the store — they are not failures."""
    res = client.post("/api/airapper/tracks", json=_body(tempo=5000, swing=-5))
    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert res.json()["track"]["tempo"] == 200.0
    assert res.json()["track"]["swing"] == 0.0


def test_oversized_lyrics_is_200_not_500(client):
    res = client.post("/api/airapper/tracks", json=_body(lyrics="x" * 600_000))
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False and "Lyrics too large" in body["error"]


def test_post_updates_when_id_present(client):
    track_id = client.post("/api/airapper/tracks", json=_body()).json()["track"]["id"]
    again = client.post("/api/airapper/tracks", json={**_body(title="V2"), "id": track_id})
    assert again.status_code == 200
    assert again.json()["created"] is False
    assert again.json()["track"]["id"] == track_id
    assert again.json()["track"]["title"] == "V2"
    assert len(client.get("/api/airapper/tracks").json()["tracks"]) == 1


def test_store_never_writes_into_a_project_file(client, tmp_path):
    """Orthogonality (§4.2): the library is not a project citizen."""
    client.post("/api/airapper/tracks", json=_body())
    project = tmp_path / "song.ffproject.json"
    project.write_text(json.dumps({"items": [], "images": []}), encoding="utf-8")
    client.get("/api/airapper/tracks")
    assert json.loads(project.read_text(encoding="utf-8")) == {"items": [], "images": []}