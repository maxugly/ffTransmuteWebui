"""Trackers Updater route + engine checks.

The engine is pure stdlib networking — here all probes/fetches are stubbed so
the tests pin the *contract*: static filtering (blacklist/private/credential
schemes), dedupe, the verify toggle's effect on the push list, the qBittorrent
push flow, and invariant 10 (failures are HTTP 200 + ok:false).
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

from app.main import app  # noqa: E402
from app.routes import trackers as tk  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    tk.set_data_dir(tmp_path)
    tk._entries.clear()
    tk._last_runs.clear()
    tk._logring.clear()
    tk._busy.update(refresh=False, verify=False)
    tk.save_settings({"auto_refresh": False})   # no cron ticks during tests
    yield TestClient(app)
    tk.set_data_dir(ROOT / "data")   # project root data dir (matches production default)


# ── normalize / filter ────────────────────────────────────────────────

def test_normalize_dedupe_and_static_filters():
    raw = [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://tracker.opentrackr.org:1337/announce",          # duplicate
        "http://good.example.com/announce?passkey=abc123",     # blacklisted
        "http://127.0.0.1:6969/announce",                      # private
        "wss://tracker.webtorrent.dev/announce",               # kept, not pushed
        "https://fine.example.org:443/announce",
        "not-a-url",
        "# comment line",
        "dht://1024",                                          # unsupported scheme
    ]
    out = tk.normalize_urls(raw, blacklist=["passkey="])
    skipped = out["skipped"]
    assert skipped["duplicate"] == 1
    assert skipped["blacklisted"] == 1
    assert skipped["private_or_local"] == 1
    assert skipped["no_scheme"] == 1
    assert skipped["comment"] == 1
    assert skipped["scheme_dht"] == 1
    assert [e["scheme"] for e in out["entries"]] == ["udp", "wss", "https"]
    assert out["entries"][1]["status"] == "webtorrent"
    assert out["entries"][2]["status"] == "pending"


def test_normalize_bare_ip_becomes_udp():
    out = tk.normalize_urls(["1337.42.9.7:1337/announce"], [])
    assert out["entries"][0]["scheme"] == "udp"
    assert out["entries"][0]["url"].startswith("udp://")


def test_manual_refresh_persists_entries(client, monkeypatch):
    monkeypatch.setattr(tk, "fetch_lists", lambda srcs: ([
        "udp://a.example.com:1337/announce",
        "http://b.example.com/announce",
    ], []))
    client.post("/api/trackers/settings", json={"verify_enabled": False,
                                                "auto_push": False})
    r = client.post("/api/trackers/refresh")
    assert r.json().get("started") is True
    for _ in range(100):
        if not tk._busy["refresh"]:
            break
        time.sleep(0.05)
    assert len(tk._entries) == 2
    stored = json.loads((tk._DATA_DIR / "trackers.json").read_text())
    assert {e["url"] for e in stored} == {
        "udp://a.example.com:1337/announce", "http://b.example.com/announce"}
    assert stored[0]["status"] == "pending"   # verify off → never probed


# ── verify + push list ────────────────────────────────────────────────

def test_verify_toggle_controls_push_list(client):
    tk._entries.extend([
        {"url": "udp://a.example.com:1337/announce", "scheme": "udp",
         "status": "alive", "checked": 1.0},
        {"url": "http://dead.example.com/announce", "scheme": "http",
         "status": "dead", "checked": 1.0},
        {"url": "http://auth.example.com/announce", "scheme": "http",
         "status": "auth", "checked": 1.0},
        {"url": "wss://wt.example.com/announce", "scheme": "wss",
         "status": "webtorrent", "checked": 0.0},
        {"url": "http://un.example.com/announce", "scheme": "http",
         "status": "pending", "checked": 0.0},
    ])
    tk.save_settings({"verify_enabled": True})
    assert tk.push_list() == ["udp://a.example.com:1337/announce"]
    tk.save_settings({"verify_enabled": False})
    got = tk.push_list()
    assert "udp://a.example.com:1337/announce" in got
    assert "http://un.example.com/announce" in got
    assert "wss://wt.example.com/announce" not in got     # never pushed
    assert "http://auth.example.com/announce" not in got  # auth never pushed


def test_verify_all_classifies(client, monkeypatch):
    tk._entries.extend([
        {"url": "udp://a.example.com/announce", "scheme": "udp",
         "status": "pending", "checked": 0.0},
        {"url": "http://b.example.com/announce", "scheme": "http",
         "status": "pending", "checked": 0.0},
        {"url": "wss://c.example.com/announce", "scheme": "wss",
         "status": "webtorrent", "checked": 0.0},
    ])
    monkeypatch.setattr(tk, "udp_probe", lambda url, timeout=5: "alive")
    monkeypatch.setattr(tk, "http_probe", lambda url, timeout=5: "auth")
    out = tk.verify_all()
    assert out["checked"] == 2          # wss is not probed
    assert tk._entries[0]["status"] == "alive"
    assert tk._entries[1]["status"] == "auth"
    assert tk._entries[2]["status"] == "webtorrent"


def test_udp_probe_dead_on_nxdomain():
    # no mocking: an unresolvable host must classify as dead, never raise
    assert tk.udp_probe("udp://definitely.invalid.qbt.test:1337/announce") == "dead"


def test_http_probe_dead_on_nxdomain():
    assert tk.http_probe("http://definitely.invalid.qbt.test/announce") == "dead"


# ── qBittorrent push ──────────────────────────────────────────────────

class _FakeResp:
    def __init__(self, body=b"", set_cookie=None):
        self._body = body
        if set_cookie is None:
            set_cookie = []

        class _H:
            def get_all(_self, k):
                return set_cookie if k == "Set-Cookie" else None
        self.headers = _H()

    def read(self, n=-1):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_qb_push_sends_preferences(monkeypatch):
    calls = []

    def fake_urlopen(req, timeout=10):
        url = req.get_full_url()
        if url.endswith("/auth/login"):
            return _FakeResp(b"Ok.", ["SID=abc123; path=/"])
        calls.append(url)
        return _FakeResp(b"[]")

    monkeypatch.setattr(tk.urllib.request, "urlopen", fake_urlopen)
    out = tk.qb_push(["udp://a.example.com/announce"], {
        "qb_url": "http://127.0.0.1:8080", "qb_user": "admin",
        "qb_pass": "adminadmin", "push_existing": False,
    })
    assert out == {"global": 1, "existing": 0, "torrent_count": 0}
    assert any(u.endswith("/app/setPreferences") for u in calls)


def test_qb_push_login_refused_is_error(monkeypatch):
    monkeypatch.setattr(tk.urllib.request, "urlopen",
                        lambda req, timeout=10: _FakeResp(b"Fails."))
    with pytest.raises(RuntimeError, match="login refused"):
        tk.qb_push(["udp://a.example.com/announce"], {
            "qb_url": "http://127.0.0.1:8080", "qb_user": "admin",
            "qb_pass": "wrong", "push_existing": False,
        })


def test_push_route_reports_login_failure_honestly(client, monkeypatch):
    monkeypatch.setattr(tk.urllib.request, "urlopen",
                        lambda req, timeout=10: _FakeResp(b"Fails."))
    tk._entries.append({"url": "udp://a.example.com/announce", "scheme": "udp",
                        "status": "alive", "checked": 1.0})
    r = client.post("/api/trackers/push")
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is False
    assert "login" in j["error"].lower()


# ── routes: invariant 10 ──────────────────────────────────────────────

def test_push_with_no_entries_is_ok_false(client):
    r = client.post("/api/trackers/push")
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is False
    assert "push" in j["error"].lower() or "refresh" in j["error"].lower()


def test_status_reports_default_settings_and_empty_counts(client):
    r = client.get("/api/trackers/status")
    j = r.json()
    assert r.status_code == 200 and j["ok"] is True
    assert j["total"] == 0
    assert j["settings"]["verify_enabled"] is True   # house default
    assert j["settings"]["auto_refresh"] is False    # test fixture disabled it
    assert j["pushable"] == 0


def test_settings_roundtrip_validation(client):
    r = client.post("/api/trackers/settings",
                    json={"interval_hours": 0, "sources": ["nonsense", "best"],
                          "bogus_key": 1})
    j = r.json()
    assert j["ok"] is True
    s = j["settings"]
    assert s["interval_hours"] == 1        # clamped
    assert s["sources"] == ["best"]        # filtered
    assert "bogus_key" not in s


def test_trackers_route_filters(client):
    tk._entries.extend([
        {"url": "udp://a.example.com/announce", "scheme": "udp",
         "status": "alive", "checked": 0.0},
        {"url": "http://b.example.com/announce", "scheme": "http",
         "status": "dead", "checked": 0.0},
    ])
    r = client.get("/api/trackers/trackers?status=alive").json()
    assert r["total"] == 1 and r["rows"][0]["url"].startswith("udp")
    r = client.get("/api/trackers/trackers?q=b.example").json()
    assert r["total"] == 1 and "http" in r["rows"][0]["url"]
