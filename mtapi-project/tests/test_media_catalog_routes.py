"""Route-level checks for the Media Catalog HTTP surface (spec §9, §6.6).

Uses the real FastAPI app via TestClient, but pins the database at a temp file
so nothing touches ~/.ffTransmute. Every failure must be HTTP 200 + ok:false
(invariant 10).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from starlette.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.database import audio_db  # noqa: E402
from app.media import performance as media_perf  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(tmp_path / "catalog.db"))
    audio_db.init_db()
    monkeypatch.setattr(media_perf, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(media_perf, "_settings_cache", None)
    yield TestClient(app)
    audio_db.set_db_path(prev)


@pytest.fixture
def db_only(tmp_path, monkeypatch):
    prev = audio_db.DB_PATH
    audio_db.set_db_path(str(tmp_path / "catalog.db"))
    audio_db.init_db()
    yield
    audio_db.set_db_path(prev)


def _wav(path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\0\0" * 4096)
    return str(path)


def _set_owned(monkeypatch, dirs):
    monkeypatch.setattr(media_perf, "load_settings", lambda: {"owned_dirs": list(dirs)})


# ── status ────────────────────────────────────────────────────────────────
def test_status_shape(client):
    res = client.get("/api/media-catalog/status")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "total" in data and "by_type" in data and "by_status" in data
    assert set(data["engines_present"]) == {"essentia", "mido", "librosa", "madmom", "aubio", "basic_pitch"}


# ── ingest ────────────────────────────────────────────────────────────────
def test_ingest_indexes_files_and_skips_missing(client, tmp_path, monkeypatch):
    monkeypatch.setattr(media_perf, "load_settings", lambda: {"owned_dirs": []})
    good = _wav(tmp_path / "a.wav")
    res = client.post("/api/media-catalog/ingest", json={
        "paths": [good, str(tmp_path / "missing.wav")]})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["upserted"] == 1
    assert data["skipped"] == 1
    assert audio_db.get_row(good)["type"] == "audio"


def test_ingest_rejects_bad_payloads(client):
    for payload in ({}, {"paths": []}, {"paths": "nope"}, {"paths": [1, 2]}):
        res = client.post("/api/media-catalog/ingest", json=payload)
        assert res.status_code == 200
        assert res.json()["ok"] is False


def test_ingest_applies_owned_dir_rule_with_containment(client, tmp_path, monkeypatch):
    (tmp_path / "music").mkdir()
    (tmp_path / "music2").mkdir()
    inside = _wav(tmp_path / "music" / "inside.wav")
    sibling = _wav(tmp_path / "music2" / "sibling.wav")
    _set_owned(monkeypatch, [str(tmp_path / "music")])
    client.post("/api/media-catalog/ingest", json={"paths": [inside, sibling]})
    assert audio_db.get_row(inside)["is_mine"] == 1
    assert audio_db.get_row(inside)["mine_source"] == "dir_rule"
    assert audio_db.get_row(sibling)["is_mine"] == 0


# ── generated stamp ───────────────────────────────────────────────────────
def test_generated_stamp_sets_mine_and_ai(client, tmp_path):
    out = _wav(tmp_path / "gen.wav")
    res = client.post("/api/media-catalog/generated",
                      json={"path": out, "generated_by": "music_generate"})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    row = data["row"]
    assert row["is_mine"] is True
    assert row["ai_involved"] is True
    assert row["made_by_me"] is False  # the op never claims human authorship
    assert row["mine_source"] == "generated"
    assert row["origin"] == "generated"


def test_generated_requires_path(client):
    res = client.post("/api/media-catalog/generated", json={})
    assert res.status_code == 200
    assert res.json()["ok"] is False


# ── mark + undo ───────────────────────────────────────────────────────────
def test_mark_roundtrip_and_invariant(client, tmp_path):
    p = _wav(tmp_path / "m.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [p]})
    res = client.post("/api/media-catalog/mark", json={
        "path": p, "is_mine": False, "made_by_me": True, "ai_involved": False})
    data = res.json()
    assert data["ok"] is True
    assert data["row"]["is_mine"] is True   # hand ⇒ mine (write-time invariant)
    assert data["row"]["made_by_me"] is True
    assert data["row"]["mine_source"] == "manual"


def test_mark_requires_path(client):
    assert client.post("/api/media-catalog/mark", json={}).json()["ok"] is False


def test_undo_restores_previous_provenance(client, tmp_path):
    a = _wav(tmp_path / "u1.wav")
    b = _wav(tmp_path / "u2.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [a, b]})
    batch = client.post("/api/media-catalog/mark", json={
        "path": a, "is_mine": True, "batch_id": "bulk-1"}).json()["batch_id"]
    client.post("/api/media-catalog/mark", json={
        "path": b, "is_mine": True, "batch_id": "bulk-1"})

    res = client.post("/api/media-catalog/undo", json={"batch_id": "bulk-1"})
    data = res.json()
    assert data["ok"] is True
    assert data["restored"] == 2
    assert audio_db.get_row(a)["is_mine"] == 0
    assert audio_db.get_row(b)["is_mine"] == 0
    assert batch


def test_undo_requires_batch_id(client):
    assert client.post("/api/media-catalog/undo", json={}).json()["ok"] is False


def test_undo_unknown_batch_is_ok_zero(client):
    data = client.post("/api/media-catalog/undo", json={"batch_id": "ghost"}).json()
    assert data["ok"] is True
    assert data["restored"] == 0


def test_history_lists_changes_newest_first(client, tmp_path):
    p = _wav(tmp_path / "h.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [p]})
    client.post("/api/media-catalog/mark", json={"path": p, "is_mine": True})
    rows = client.get(f"/api/media-catalog/history?path={p}").json()["rows"]
    assert len(rows) == 1
    assert rows[0]["mechanism"] == "manual"
    assert rows[0]["new_is_mine"] == 1
    assert client.get("/api/media-catalog/history").json()["ok"] is False


# ── query ─────────────────────────────────────────────────────────────────
def test_query_facets_and_pagination(client, tmp_path):
    a = _wav(tmp_path / "q1.wav")
    b = _wav(tmp_path / "q2.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [a, b]})
    client.post("/api/media-catalog/mark", json={
        "path": a, "is_mine": True, "made_by_me": True, "ai_involved": True})

    assert client.get("/api/media-catalog/query?limit=100").json()["total"] == 2
    assert client.get("/api/media-catalog/query?mine=1").json()["total"] == 1
    assert client.get("/api/media-catalog/query?hand=1").json()["total"] == 1
    assert client.get("/api/media-catalog/query?ai=1").json()["total"] == 1
    assert client.get("/api/media-catalog/query?type=video").json()["total"] == 0
    assert client.get("/api/media-catalog/query?mine=0").json()["total"] == 1
    page = client.get("/api/media-catalog/query?limit=1&offset=0").json()
    assert len(page["rows"]) == 1 and page["limit"] == 1
    assert page["rows"][0]["name"] == "q1.wav"


def test_query_key_normalization(client, tmp_path):
    p = _wav(tmp_path / "k.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [p]})
    with audio_db.get_db() as db:
        db.execute("UPDATE media SET key_name = 'C major', tempo = 128.4 WHERE path = ?", (p,))
    assert client.get("/api/media-catalog/query?key=Cmaj").json()["total"] == 1
    assert client.get("/api/media-catalog/query?key=c%20major").json()["total"] == 1
    assert client.get("/api/media-catalog/query?key=C").json()["total"] == 1
    assert client.get("/api/media-catalog/query?key=F%23min").json()["total"] == 0
    assert client.get("/api/media-catalog/query?tempo_min=120&tempo_max=130").json()["total"] == 1
    assert client.get("/api/media-catalog/query?tempo_min=200").json()["total"] == 0


def test_query_origin_site_and_text(client, tmp_path):
    p = _wav(tmp_path / "w.mp4")
    client.post("/api/media-catalog/ingest", json={"paths": [p]})
    with audio_db.get_db() as db:
        db.execute(
            "UPDATE media SET origin='web', site='youtube', is_youtube=1, author='Chan', publish_date='2024-02-14' WHERE path=?",
            (p,))
    assert client.get("/api/media-catalog/query?origin=web").json()["total"] == 1
    assert client.get("/api/media-catalog/query?site=youtube").json()["total"] == 1
    assert client.get("/api/media-catalog/query?after=2024-01-01").json()["total"] == 1
    assert client.get("/api/media-catalog/query?after=2025-01-01").json()["total"] == 0
    assert client.get("/api/media-catalog/query?before=2024-12-31").json()["total"] == 1
    assert client.get("/api/media-catalog/query?q=Chan").json()["total"] == 1


def test_query_ignores_garbage_params(client):
    data = client.get("/api/media-catalog/query?limit=abc&offset=xyz&type=bogus&origin=bogus").json()
    assert data["ok"] is True
    assert data["limit"] == 200 and data["offset"] == 0


def test_upsert_is_idempotent_across_ingest_calls(client, tmp_path):
    p = _wav(tmp_path / "dup.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [p]})
    client.post("/api/media-catalog/ingest", json={"paths": [p]})
    assert client.get("/api/media-catalog/query").json()["total"] == 1

def test_source_meta_whitelist_keeps_provenance_and_analysis(db_only):
    """The pool's source_meta carrier must survive key/tempo + provenance."""
    from app.media.pool import _normalize_source_meta
    out = _normalize_source_meta({
        "origin": "import", "is_mine": True, "made_by_me": True, "ai_involved": False,
        "key_name": "C major", "tempo": 120.03, "tempo_conf": 1.0,
        "site": "youtube", "is_youtube": True,
        "definitely_not_a_key": "drop me",
    })
    assert out["origin"] == "import"
    assert out["is_mine"] is True
    assert out["made_by_me"] is True
    assert out["ai_involved"] is False
    assert out["key_name"] == "C major"
    assert out["tempo"] == 120.03
    assert out["tempo_conf"] == 1.0
    assert out["site"] == "youtube"
    assert "definitely_not_a_key" not in out


def test_source_meta_whitelist_drops_bad_types(db_only):
    from app.media.pool import _normalize_source_meta
    out = _normalize_source_meta({
        "is_mine": "maybe", "tempo": "fast", "key_name": 12345, "origin": "",
    })
    # bool("maybe") is True — SQLite-style coercion is the existing house rule.
    assert out.get("is_mine") is True
    assert "tempo" not in out
    assert "key_name" not in out
    assert "origin" not in out


def test_status_reports_real_engine_roles(client):
    """/status must expose the engines the scanner actually uses (incl. mido),
    not a stale hardcoded list."""
    data = client.get("/api/media-catalog/status").json()
    engines = data["engines_present"]
    assert set(engines) == {"essentia", "mido", "librosa", "madmom", "aubio", "basic_pitch"}
    assert engines["essentia"] is True   # key/tempo/beats/onsets


def test_source_endpoint_switches_and_keeps_both_values(client, tmp_path):
    src = _wav(tmp_path / "sw.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [src]})
    with audio_db.get_db() as db:
        db.execute("UPDATE media SET tempo=120.4, tempo_detected=120.4, key_name='C major',"
                   " key_detected='C major' WHERE path=?", (src,))
    audio_db.save_tags(src, {"bpm": 141.0, "initial_key_canonical": "G# minor"})

    row = client.get(f"/api/media-catalog/query?q={Path(src).name}").json()["rows"][0]
    assert row["tempo"] == 141.0 and row["tempo_source"] == "tagged"
    assert row["tempo_detected"] == 120.4 and row["tag_bpm"] == 141.0

    res = client.post("/api/media-catalog/source",
                      json={"path": src, "field": "tempo", "source": "detected"})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True and data["value"] == 120.4

    row = client.get(f"/api/media-catalog/query?q={Path(src).name}").json()["rows"][0]
    assert row["tempo"] == 120.4
    assert row["tempo_detected"] == 120.4      # nothing lost
    assert row["tag_bpm"] == 141.0             # the tag is still stored


def test_source_endpoint_refuses_bad_input(client, tmp_path):
    src = _wav(tmp_path / "bad.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [src]})
    assert client.post("/api/media-catalog/source", json={}).json()["ok"] is False
    r = client.post("/api/media-catalog/source",
                    json={"path": src, "field": "nope", "source": "tagged"}).json()
    assert r["ok"] is False and "unknown field" in r["error"]
    r2 = client.post("/api/media-catalog/source",
                     json={"path": src, "field": "tempo", "source": "tagged"}).json()
    assert r2["ok"] is False  # no tagged tempo on this file


def test_query_filters_disagreements_and_source(client, tmp_path):
    a = _wav(tmp_path / "dis.wav")
    b = _wav(tmp_path / "ok.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [a, b]})
    with audio_db.get_db() as db:
        db.execute("UPDATE media SET tempo=120.0, tempo_detected=120.0 WHERE path=?", (a,))
        db.execute("UPDATE media SET tempo=100.0, tempo_detected=100.0 WHERE path=?", (b,))
    audio_db.save_tags(a, {"bpm": 164.0})       # big disagreement
    audio_db.save_tags(b, {"bpm": 100.5})      # agrees

    disagree = client.get("/api/media-catalog/query?disagree=1").json()
    assert disagree["total"] == 1
    tagged = client.get("/api/media-catalog/query?source=tagged").json()
    assert tagged["total"] == 2


def test_order_grammar_sorts_every_column(client, tmp_path):
    """Every sortable column must order server-side with NULLs last in both
    directions (the reference-table house rule), and unknown orders must fall
    back instead of breaking."""
    alpha = _wav(tmp_path / "alpha.wav")
    zeta = _wav(tmp_path / "zeta.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [alpha, zeta]})
    with audio_db.get_db() as db:
        db.execute("UPDATE media SET tempo=100.0, key_name='D minor', tag_bpm=90, is_mine=1 WHERE path=?", (zeta,))
    rows_of = lambda q: [r["name"] for r in
                         client.get(f"/api/media-catalog/query?{q}").json()["rows"]]

    assert rows_of("order=name_asc") == ["alpha.wav", "zeta.wav"]
    assert rows_of("order=name_desc") == ["zeta.wav", "alpha.wav"]
    # zeta is the only one with tempo/key/tags: empties must sort last in ASC…
    assert rows_of("order=tempo_asc")[0] == "zeta.wav"
    assert rows_of("order=key_asc")[0] == "zeta.wav"
    assert rows_of("order=tag_bpm_asc")[0] == "zeta.wav"
    assert rows_of("order=mine_desc")[0] == "zeta.wav"
    # …and still last in DESC (mine is a 0/1 flag, so desc shows it first).
    assert rows_of("order=tempo_desc")[0] == "zeta.wav"
    # Unknown/legacy orders fall back to the default without error.
    data = client.get("/api/media-catalog/query?order=bogus").json()
    assert data["ok"] is True and data["total"] == 2
    assert client.get("/api/media-catalog/query").json()["total"] == 2


def test_order_source_uses_chosen_source_of_truth(client, tmp_path):
    a = _wav(tmp_path / "a.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [a]})
    with audio_db.get_db() as db:
        db.execute("UPDATE media SET tag_bpm=140.0, tempo_detected=120.0,"
                   " tempo=140.0, tempo_source='tagged' WHERE path=?", (a,))
    rows = client.get("/api/media-catalog/query?order=source_asc").json()["rows"]
    assert rows[0]["tempo_source"] == "tagged"


# ── content class + implausible tempo facets (8.133) ──────────────────────
def test_query_content_and_implausible_filters(client, tmp_path):
    a = _wav(tmp_path / "silent.wav")
    b = _wav(tmp_path / "good.wav")
    c = _wav(tmp_path / "impl.wav")
    client.post("/api/media-catalog/ingest", json={"paths": [a, b, c]})
    with audio_db.get_db() as db:
        db.execute("UPDATE media SET content_class='silent', level_db=-91.0, peak_db=-90.0 WHERE path=?", (a,))
        db.execute("UPDATE media SET tempo_implausible=1, tempo_detected=NULL WHERE path=?", (c,))

    names_of = lambda q: sorted(r["name"] for r in
                                client.get(f"/api/media-catalog/query?{q}").json()["rows"])
    assert names_of("content=silent") == ["silent.wav"]
    assert names_of("content=ok") == ["good.wav", "impl.wav"]  # unanalysed is not suspicious
    assert names_of("implausible=1") == ["impl.wav"]
    row = client.get("/api/media-catalog/query?implausible=1").json()["rows"][0]
    assert row["tempo_implausible"] is True
    assert row["tempo"] is None
