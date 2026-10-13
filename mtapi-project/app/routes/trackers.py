"""Trackers Updater — ngosang/trackerslist fetcher, verifier, qBittorrent push.

House rules honoured here:
- Invariant 10: every failure is HTTP 200 with ``{"ok": false, "error": ...}``.
- Pure stdlib networking (urllib + raw UDP sockets); no subprocess (invariant 2).
- Data under ``mtapi-project/data/trackers/``.

Endpoints (router ``/api/trackers``):
- ``GET  /status``    — counts, busy flags, last-run times, cron schedule, log tail
- ``GET/POST /settings`` — the toggle surface: verify, cron, interval, sources,
                        blacklist, auto-push, qBittorrent connection
- ``POST /refresh``   — fetch + normalise + dedupe + filter the lists
- ``POST /verify``    — live-probe every http/udp tracker
- ``GET  /trackers``  — table data for the tab (status= / q= filters, capped)
- ``POST /push``      — log into the qBittorrent WebUI and install the list
                        globally (add_trackers) + optionally to existing torrents

What "verify" honestly means: a tracker cannot be queried for the torrents it
hosts and you cannot pull pieces of a torrent you are not in a swarm for.
What *is* provable is tracker liveness:
* UDP trackers answer the BitTorrent UDP announce handshake (magic
  0x41727101980, action 0 = connect). A 16-byte response with our transaction
  id proves a live, speaking tracker.
* HTTP(S) trackers answer the announce endpoint; any HTTP response proves the
  host speaks, 401/403 strongly suggests an authentication-gated tracker. A
  synthetic info_hash keeps the request legal; the response is a harmless
  bencoded error ("torrent not registered").
DNS failures / timeouts / connection refused = dead. Those are exactly the
statuses the verify toggle and the push list consume.
"""
from __future__ import annotations

import json
import logging
import random
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from fastapi import APIRouter, FastAPI
from starlette.responses import JSONResponse

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/trackers", tags=["trackers"])

TRACKERSLIST_BASE = "https://raw.githubusercontent.com/ngosang/trackerslist/master"

SUPPORTED_SCHEMES = ("http", "https", "udp")
WEB_SCHEMES = {"wss", "ws"}   # webtorrent-only trackers: kept visible, never pushed
SOURCE_FILES = ("best", "all", "http", "udp", "i2p", "yggdrasil", "ws")
_SOURCE_FILES = {
    "best": "trackers_best.txt",
    "all": "trackers_all.txt",
    "http": "trackers_all_http.txt",
    "udp": "trackers_all_udp.txt",
    "i2p": "trackers_all_i2p.txt",
    "yggdrasil": "trackers_all_yggdrasil.txt",
    "ws": "trackers_all_ws.txt",
}

DEFAULT_SETTINGS: dict = {
    "verify_enabled": True,        # the verify mechanism toggle
    "auto_refresh": True,          # the cron toggle
    "interval_hours": 6,           # cron period
    "auto_push": False,            # push to qBittorrent after each cycle
    "push_existing": False,        # also addTrackers onto every existing torrent
    "sources": ["best", "all"],
    "blacklist": ["rutracker", "animebytes", "gazellegames", "hdbits",
                  "cinemageddon", "torrentleech", "alpharatio",
                  "passkey=", "uid=", "auth="],
    "qb_url": "http://127.0.0.1:8080",
    "qb_user": "admin",
    "qb_pass": "adminadmin",
}

VERIFY_CONCURRENCY = 32
VERIFY_TIMEOUT = 5.0
FAKE_INFO_HASH = bytes.fromhex("A1" * 20)
FAKE_PEER_ID = "-qT4200-tku" + "".join(random.choices("abcdefgh0123456789", k=10))
_POLICY_KEYS = set(DEFAULT_SETTINGS)


def set_data_dir(path: str | Path) -> None:
    """Pin storage (tests pin this like audio_db.set_db_path)."""
    global _DATA_DIR
    _DATA_DIR = Path(path)


_DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "trackers"

_mutex = threading.Lock()
_entries: list[dict] = []
_busy = {"refresh": False, "verify": False}
_last_runs: dict[str, float] = {}
_logring: deque[str] = deque(maxlen=250)
_next_refresh: float = 0.0
_timer_thread: threading.Thread | None = None
_timer_stop = threading.Event()


def _lg(msg: str) -> None:
    line = time.strftime("%H:%M:%S ") + msg
    _logring.append(line)
    log.info("trackers: %s", msg)


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")


def _load_memory() -> None:
    global _entries, _last_runs
    with _mutex:
        _entries = _read_json(_DATA_DIR / "trackers.json", [])
        _last_runs = {k: float(v) for k, v in
                      _read_json(_DATA_DIR / "last_runs.json", {}).items()}


def _persist() -> None:
    _write_json(_DATA_DIR / "trackers.json", _entries)
    _write_json(_DATA_DIR / "last_runs.json", _last_runs)


# ── settings ──────────────────────────────────────────────────────────────

def settings() -> dict:
    s = dict(DEFAULT_SETTINGS)
    s.update(_read_json(_DATA_DIR / "settings.json", {}))
    return s


def save_settings(update: dict) -> dict:
    s = settings()
    for key, val in (update or {}).items():
        if key not in _POLICY_KEYS:
            continue
        if key == "sources":
            val = [x for x in (val or []) if x in SOURCE_FILES]
            if not val:
                val = list(DEFAULT_SETTINGS["sources"])
        elif key == "interval_hours":
            base = DEFAULT_SETTINGS["interval_hours"] if val in (None, "") else val
            val = max(1, min(int(base), 168))
        s[key] = val
    _write_json(_DATA_DIR / "settings.json", s)
    _lg("settings saved: " + ", ".join(sorted((update or {}).keys())))
    return s


# ── fetch + normalise ─────────────────────────────────────────────────────

def _fetch_text(url: str, timeout: float = 20.0) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "fftransmute-trackers/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def fetch_lists(sources: list[str]) -> tuple[list[str], list[str]]:
    urls, errors = [], []
    for src in sources:
        try:
            text = _fetch_text(f"{TRACKERSLIST_BASE}/{_SOURCE_FILES.get(src, src + '.txt')}")
            lines = [ln.strip() for ln in text.splitlines()
                     if ln.strip() and not ln.strip().startswith("#")]
            urls.extend(lines)
            _lg(f"fetched {src}.txt: {len(lines)} lines")
        except Exception as e:
            errors.append(f"{src}: {e}")
            _lg(f"fetch {src}.txt failed: {e}")
    return urls, errors


_SCHEME_RE = re.compile(r"^([a-z]+)://", re.I)


def _private_host(host: str) -> bool:
    h = (host or "").lower().strip("[]")
    if h in ("", "localhost", "::1", "0.0.0.0", "127.0.0.1"):
        return True
    if "." not in h and ":" not in h:
        return True
    if h.startswith(("127.", "10.", "192.168.", "169.254.", "100.64.")):
        return True
    m = re.match(r"^172\.(\d+)\.", h)
    if m and 16 <= int(m.group(1)) <= 31:
        return True
    if h.startswith(("fe80:", "fc", "fd")):
        return True
    if h.endswith((".onion", ".local")):
        return True
    return False


def normalize_urls(raw: list[str], blacklist: list[str] | None = None) -> dict:
    """Dedupe + static-filter → {'entries', 'skipped'} (never network calls)."""
    skip: dict[str, int] = {}
    seen: set[str] = set()
    entries: list[dict] = []
    bl = [x.lower() for x in (blacklist or [])]

    def _skip(reason: str) -> None:
        skip[reason] = skip.get(reason, 0) + 1

    for raw_url in raw:
        line = raw_url.strip()
        if not line or line.startswith("#"):
            _skip("comment")
            continue
        m = _SCHEME_RE.match(line)
        if not m and re.match(r"^[\d.]+:\d+/announce$", line):
            line = "udp://" + line          # bare ip:port (best_ip/all_ip style)
            m = _SCHEME_RE.match(line)
        if not m:
            _skip("no_scheme")
            continue
        scheme = m.group(1).lower()
        if scheme not in SUPPORTED_SCHEMES and scheme not in WEB_SCHEMES:
            _skip("scheme_" + scheme)
            continue
        if any(tok in line.lower() for tok in bl):
            _skip("blacklisted")
            continue
        p = urllib.parse.urlsplit(line)
        if _private_host(p.hostname or ""):
            _skip("private_or_local")
            continue
        norm = urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(),
                                        p.path or "/announce", "", ""))
        if norm in seen:
            _skip("duplicate")
            continue
        seen.add(norm)
        entries.append({
            "url": line,
            "scheme": scheme,
            "status": "pending" if scheme in SUPPORTED_SCHEMES else "webtorrent",
            "checked": 0.0,
        })
    return {"entries": entries, "skipped": skip}


def refresh_entries(sources: list[str] | None = None) -> dict:
    """Full refresh: fetch, normalise, keep known statuses, persist."""
    s = settings()
    sources = list(sources or s.get("sources") or ["best"])
    raw, errors = fetch_lists(sources)
    norm = normalize_urls(raw, list(s.get("blacklist") or []))
    known = {e["url"]: e for e in _entries}
    fresh: list[dict] = []
    for e in norm["entries"]:
        old = known.get(e["url"])
        if old and old.get("checked"):
            e["status"] = old["status"]
            e["checked"] = old["checked"]
        fresh.append(e)
    fresh.sort(key=lambda x: (x["scheme"], x["url"]))
    with _mutex:
        _entries.clear()
        _entries.extend(fresh)
    _last_runs["refresh"] = time.time()
    _persist()
    _lg(f"refresh: {len(fresh)} kept, skipped={norm['skipped']}, errors={len(errors)}")
    return {"ok": True, "entries": len(fresh), "fetched": len(raw),
            "skipped": norm["skipped"], "errors": errors}


# ── verification ──────────────────────────────────────────────────────────

_UDP_CONNECT_MAGIC = (0x41727101980).to_bytes(8, "big")


def udp_probe(url: str, timeout: float = VERIFY_TIMEOUT) -> str:
    p = urllib.parse.urlsplit(url)
    tx = random.getrandbits(32)
    req = _UDP_CONNECT_MAGIC + (0).to_bytes(4, "big") + tx.to_bytes(4, "big")
    try:
        infos = socket.getaddrinfo(p.hostname, p.port or 80, proto=socket.IPPROTO_UDP)
    except Exception:
        return "dead"
    for af, _kind, _proto, _cn, sockaddr in infos[:2]:
        try:
            with socket.socket(af, socket.SOCK_DGRAM) as s:
                s.settimeout(timeout)
                s.sendto(req, sockaddr)
                resp, _addr = s.recvfrom(256)
            if len(resp) >= 16 and resp[:4] == bytes(4):
                return "alive"
        except OSError:
            continue
    return "dead"


_SYNTH_QS = (
    "&info_hash=" + urllib.parse.quote(FAKE_INFO_HASH, safe="") +
    "&peer_id=" + urllib.parse.quote(FAKE_PEER_ID, safe="") +
    "&port=51413&uploaded=0&downloaded=0&left=0&event=started&numwant=0&compact=1"
)


def http_probe(url: str, timeout: float = VERIFY_TIMEOUT) -> str:
    probe = url + ("&" if "?" in url else "?") + _SYNTH_QS
    req = urllib.request.Request(probe, headers={"User-Agent": "fftransmute-trackers/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read(512)
            return "alive"
    except urllib.error.HTTPError as e:
        try:
            e.read(512)
        except Exception:
            pass
        return "auth" if e.code in (401, 403) else "alive"
    except Exception:
        return "dead"


def verify_one(entry: dict) -> str:
    scheme = entry.get("scheme")
    if scheme == "udp":
        return udp_probe(entry["url"])
    if scheme in ("http", "https"):
        return http_probe(entry["url"])
    return entry.get("status") or "pending"


def verify_all(concurrency: int = VERIFY_CONCURRENCY,
               progress_every: int = 250) -> dict:
    targets = [e for e in _entries if e.get("scheme") in SUPPORTED_SCHEMES]
    _lg(f"verify start: {len(targets)} eligible")
    done = 0
    counts: dict[str, int] = {}
    entry_by_fut = {}
    with ThreadPoolExecutor(max_workers=min(concurrency, 64)) as pool:
        for e in targets:
            entry_by_fut[pool.submit(verify_one, e)] = e
        for fut in as_completed(entry_by_fut):
            e = entry_by_fut[fut]
            try:
                st = fut.result()
                e["status"] = st
                e["checked"] = time.time()
            except Exception as exc:   # never let one bad probe kill the run
                e["status"] = "dead"
                e["checked"] = time.time()
                log.debug("trackers probe error %s: %s", e["url"], exc)
            done += 1
            if done % progress_every == 0:
                _lg(f"verify progress {done}/{len(targets)}")

    for e in _entries:
        st = e.get("status", "pending")
        counts[st] = counts.get(st, 0) + 1
    _last_runs["verify"] = time.time()
    _persist()
    _lg(f"verify done: {counts}")
    return {"ok": True, "checked": done, "counts": counts}


def push_list() -> list[str]:
    """Engine-worthy URLs. Verify ON → only probe-passed trackers are pushed.
    Verify OFF → everything still passes the static filters, except entries a
    previous verify already flagged dead/auth (that result is still evidence)."""
    s = settings()
    if s.get("verify_enabled"):
        return [e["url"] for e in _entries
                if e.get("scheme") in SUPPORTED_SCHEMES
                and e.get("status") == "alive"]
    return [e["url"] for e in _entries
            if e.get("scheme") in SUPPORTED_SCHEMES
            and e.get("status") not in ("dead", "auth")]


# ── qBittorrent push ──────────────────────────────────────────────────────

def qb_push(urls: list[str], s: dict) -> dict:
    mgmt = s.get("qb_url", "").rstrip("/")
    if not mgmt:
        raise RuntimeError("qb_url not configured")
    data = urllib.parse.urlencode(
        {"username": s.get("qb_user", ""), "password": s.get("qb_pass", "")}).encode()
    req = urllib.request.Request(mgmt + "/api/v2/auth/login", data=data, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read(64).decode("utf-8", "replace").strip()
        cookies = resp.headers.get_all("Set-Cookie") or []
    # qBt answers "Ok." (older builds) or an empty 204 (newer builds and the
    # LocalHostAuth=false bypass path) on success — the SID cookie decides.
    # Cookie name is build-dependent: SID or QBT_SID_<port>.
    sid = None
    for c in cookies:
        name_value = c.split(";", 1)[0]
        name = name_value.partition("=")[0].strip().lower()
        if name == "sid" or name.startswith("qbt_sid"):
            sid = name_value.partition("=")[2]
            break
    if not sid or body == "Fails.":
        raise RuntimeError(f"qBittorrent login refused ({body or 'no SID cookie'})")
    headers = {"Cookie": f"SID={sid}"}

    prefs_data = urllib.parse.urlencode(
        {"json": json.dumps({"add_trackers_enabled": True,
                             "add_trackers": "\n".join(urls)})}).encode("utf-8")
    req = urllib.request.Request(mgmt + "/api/v2/app/setPreferences",
                                 data=prefs_data, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded",
                                          **headers})
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read(64)

    pushed_existing = 0
    torrent_count = 0
    if s.get("push_existing"):
        req = urllib.request.Request(mgmt + "/api/v2/torrents/info", headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            torrents = json.loads(resp.read().decode("utf-8") or "[]")
        torrent_count = len(torrents)
        for t in torrents[:200]:
            body = urllib.parse.urlencode(
                {"hash": t.get("hash", ""), "urls": "\n".join(urls)}).encode()
            req = urllib.request.Request(
                mgmt + "/api/v2/torrents/addTrackers", data=body, method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded", **headers})
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    resp.read(64)
                pushed_existing += 1
            except urllib.error.HTTPError:
                _lg(f"addTrackers refused for {t.get('hash', '?')[:8]} (maybe deduped)")
                continue
    return {"global": len(urls), "existing": pushed_existing,
            "torrent_count": torrent_count}


# ── cron (in-app scheduler, not OS crontab) ───────────────────────────────

def _compute_next(now: float | None = None) -> float:
    s = settings()
    if not s.get("auto_refresh"):
        return 0.0
    base = now or _last_runs.get("refresh") or time.time()
    return base + float(s.get("interval_hours", 6)) * 3600.0


def arm_timer() -> None:
    global _next_refresh
    _next_refresh = _compute_next()


def _cycle(trigger: str, force: bool = False) -> None:
    with _mutex:
        if _busy["refresh"] and not force:
            return
        _busy["refresh"] = True
    try:
        refresh_entries()
        s = settings()
        if s.get("verify_enabled"):
            verify_all()
        if s.get("auto_push"):
            urls = push_list()
            if urls:
                try:
                    qb_push(urls, s)
                    _lg(f"auto push ok: {len(urls)} trackers")
                except Exception as e:
                    _lg(f"auto push failed: {e}")
    except Exception as e:
        _lg(f"cycle error: {e}")
    finally:
        with _mutex:
            _busy["refresh"] = False
            _busy["verify"] = False
        arm_timer()


def _timer_loop() -> None:
    while not _timer_stop.is_set():
        try:
            if (settings().get("auto_refresh") and _next_refresh
                    and time.time() >= _next_refresh
                    and not _busy.get("refresh")):
                _lg("cron tick: refresh due")
                _cycle("cron")
        except Exception as e:
            log.error("trackers timer error: %s", e)
        _timer_stop.wait(60.0)


def _ensure_timer() -> None:
    global _timer_thread
    if _timer_thread is None or not _timer_thread.is_alive():
        arm_timer()
        _timer_stop.clear()
        _timer_thread = threading.Thread(target=_timer_loop, name="trackers-cron",
                                         daemon=True)
        _timer_thread.start()


# ── routes ────────────────────────────────────────────────────────────────

def register(app: FastAPI) -> None:
    @router.get("/status")
    async def trackers_status() -> JSONResponse:
        try:
            counts: dict[str, int] = {}
            for e in _entries:
                counts[e.get("status", "pending")] = \
                    counts.get(e.get("status", "pending"), 0) + 1
            return JSONResponse({
                "ok": True,
                "counts": counts,
                "total": len(_entries),
                "pushable": len(push_list()),
                "busy": dict(_busy),
                "last": dict(_last_runs),
                "next_refresh": _next_refresh or None,
                "settings": settings(),
                "log": list(_logring)[-60:],
            })
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})

    @router.post("/refresh")
    async def trackers_refresh() -> JSONResponse:
        try:
            with _mutex:
                if _busy["refresh"]:
                    return JSONResponse({"ok": False, "error": "refresh already running"})
                _busy["refresh"] = True
            _lg("refresh started (manual)")
            threading.Thread(target=_cycle, args=("manual", True), daemon=True).start()
            return JSONResponse({"ok": True, "started": True})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})

    @router.post("/verify")
    async def trackers_verify() -> JSONResponse:
        try:
            with _mutex:
                if _busy["verify"] or _busy["refresh"]:
                    return JSONResponse({"ok": False, "error": "another job is running"})
                _busy["verify"] = True
            _lg("verify started (manual)")
            threading.Thread(target=_verify_thread_job, daemon=True).start()
            return JSONResponse({"ok": True, "started": True})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})

    @router.get("/trackers")
    async def trackers_list(status: str = "", q: str = "", limit: int = 300) -> JSONResponse:
        try:
            ql = q.lower()
            rows = [e for e in _entries
                    if (not status or e.get("status") == status)
                    and (not ql or ql in e.get("url", "").lower())]
            total = len(rows)
            rows = rows[: max(1, min(int(limit), 1000))]
            return JSONResponse({"ok": True, "total": total, "rows": rows})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})

    @router.get("/settings")
    async def trackers_get_settings() -> JSONResponse:
        try:
            return JSONResponse({"ok": True, "settings": settings(),
                                 "next_refresh": _next_refresh or None})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})

    @router.post("/settings")
    async def trackers_post_settings(body: dict) -> JSONResponse:
        try:
            s = save_settings(body or {})
            arm_timer()
            return JSONResponse({"ok": True, "settings": s,
                                 "next_refresh": _next_refresh or None})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})

    @router.post("/push")
    async def trackers_push() -> JSONResponse:
        try:
            urls = push_list()
            if not urls:
                return JSONResponse(
                    {"ok": False, "error": "nothing to push — refresh/verify first"})
            s = settings()
            result = qb_push(urls, s)
            _lg(f"push ok: {result['global']} global, "
                f"{result['existing']} torrents touched")
            return JSONResponse({"ok": True, "pushed": len(urls), **result})
        except urllib.error.URLError as e:
            msg = (f"cannot reach qBittorrent webui ({e}) — is the WebUI enabled "
                   "(Tools -> Options -> Web UI)?")
            _lg("push failed: " + msg)
            return JSONResponse({"ok": False, "error": msg})
        except Exception as e:
            _lg(f"push failed: {e}")
            return JSONResponse({"ok": False, "error": str(e)})

    app.include_router(router)
    _load_memory()
    _ensure_timer()


def _verify_thread_job() -> None:
    try:
        verify_all()
        s = settings()
        if s.get("auto_push"):
            urls = push_list()
            if urls:
                try:
                    qb_push(urls, s)
                    _lg(f"auto push ok: {len(urls)} trackers")
                except Exception as e:
                    _lg(f"auto push failed: {e}")
    except Exception as e:
        _lg(f"verify failed: {e}")
    finally:
        with _mutex:
            _busy["verify"] = False
        arm_timer()
