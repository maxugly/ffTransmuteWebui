# Trackers Updater spec (shipped 8.147)

Fetches [ngosang/trackerslist](https://github.com/ngosang/trackerslist) into the
WebUI as a Library tab, verifies which trackers actually answer, filters out
dead and authentication-gated ones, and pushes the survivors into qBittorrent.

## Server (`app/routes/trackers.py`, router `/api/trackers`)

- `GET  /status` — counts by status, busy flags, last-run times, armed cron
  time, current settings, last 60 log lines. Never fails silently (invariant 10).
- `GET/POST /settings` — toggles persisted in `data/trackers/settings.json`:
  `verify_enabled`, `auto_refresh`, `interval_hours` (1–168, clamped),
  `auto_push`, `push_existing`, `sources` (validated against repo file map),
  `blacklist` (substring tokens), qBittorrent `qb_url`/`qb_user`/`qb_pass`.
- `POST /refresh` — background `_cycle`: fetch all enabled sources, normalise,
  dedupe (by scheme+host:port+path), drop comments/non-schemes/private-loopback
  hosts (.onion/.local included), drop blacklisted URLs and credential-bearing
  announce paths (`passkey=`, `uid=`, `auth=`, long path tokens), keep
  webtorrent (`wss/ws`) entries visible but never pushed, then persist to
  `data/trackers/trackers.json`. Known statuses from previous verifies carry
  forward for unchanged URLs.
- `POST /verify` — background: probe every http/https/udp tracker with a
  ThreadPool of 32, 5 s per probe:
  * **UDP** = the real BitTorrent connect handshake (magic `0x41727101980`,
    action 0, random transaction id); any 16-byte answer with action 0 and our
    transaction id ⇒ `alive`.
  * **HTTP(S)** = GET the announce endpoint with a synthetic info_hash and
    peer_id (a harmless "unregistered torrent" for the tracker); 2xx/4xx/5xx
    answer ⇒ `alive`; 401/403 ⇒ `auth`; timeouts/refused/DNS failures ⇒ `dead`.
- `GET  /trackers` — table rows (`status=`, `q=`, `limit≤1000`).
- `POST /push` — login to the qBittorrent WebUI, then `setPreferences` with
  `add_trackers_enabled: true` + `add_trackers` (newline list) and, when
  `push_existing`, `addTrackers` per torrent hash (≤200).

Push list semantics: verify ON ⇒ only `alive`. Verify OFF ⇒ everything static
filters allowed, minus entries a previous verify proved `dead`/`auth` (old
evidence still applies). Failed pushes answer 200 + `ok:false` with the exact
reason (e.g. "cannot reach qBittorrent webui — is the WebUI enabled?").

## Cron

`auto_refresh` runs inside the mtapi process — a daemon loop wakes every 60 s,
fires refresh (+ verify + optional push) when `last_refresh + interval` has
elapsed, and re-arms after every run. No OS crontab; killing the server stops
it. The tab prints the next fire time in the pills.

## Reality note (what verification can and cannot prove)

A tracker cannot be queried for the torrents it hosts and pieces cannot be
pulled by a client outside the swarm — the tracker only answers announces for
hashes it knows. Verifications here prove *tracker liveness*, which is exactly
what the settings is for: dead trackers can't announce, auth trackers refuse
before any peer exchange happens.

## WebUI (`js/tabs/trackers.js` · `css/trackers.css`)

Library tab `trackers` (bare workspace, house density standard): pills row
(pushable/alive/dead/auth/pending/webtorrent/total + last runs + cron eta)，
action row (Refresh/Verify/Push, disabled while busy), three settings cards,
filterable status-stamped tracker table (URL/scheme/status/checked), server
log panel. 4 s status+rows poll while the tab is active. All controls carry
the house `data-help-*` law.
