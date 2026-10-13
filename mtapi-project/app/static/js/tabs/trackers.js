// Trackers Updater tab — ngosang/trackerslist fetch → verify → qBittorrent push.
// Server surface: /api/trackers/* (routes/trackers.py). Pure fetch() client:
// the verification toolkit (UDP handshake / HTTP announce) lives server-side.
import { logConsole, elements } from '/app.js?v=2';

let _poll = null;
let _lastBusy = { refresh: false, verify: false };
let _status = null;
let _rows = [];
let _hydratedSettings = '';

function _el(id) { return document.getElementById(id); }
function _log(msg, kind) { try { logConsole(msg, kind); } catch (_) { /* ignore */ } }

function _ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function _eta(ts) {
  if (!ts) return 'cron off';
  const s = Math.round(ts - Date.now() / 1000);
  if (s <= 0) return 'due now';
  if (s < 3600) return 'in ' + Math.round(s / 60) + 'm';
  if (s < 86400) return 'in ' + Math.round(s / 3600) + 'h';
  return 'in ' + Math.round(s / 86400) + 'd';
}

/* ── render ─────────────────────────────────────────────────────────── */

export function renderTrackersForm() {
  const host = elements.actionPanel;
  if (!host) { _log('trackers: no action panel', 'error'); return; }
  host.innerHTML = `
  <div class="trk-workspace">
    <div class="trk-topbar">
      <span class="panel-title-desc dense">Trackers Updater — ngosang/trackerslist fetch · live verify · qBittorrent push</span>
      <span class="trk-actions">
        <button type="button" id="trk-btn-refresh" class="btn trk-btn" data-help-title="Refresh trackers" data-help-text="Fetch the selected ngosang/trackerslist sources now, dedupe and static-filter them (blacklist, private/loopback addresses, unsupported schemes).">↻ Refresh list</button>
        <button type="button" id="trk-btn-verify" class="btn trk-btn" data-help-title="Verify now" data-help-text="Probe every http/udp tracker: UDP gets the real BitTorrent connect handshake, HTTP gets an announce hit with a synthetic info-hash. dead = timeout/DNS fail, auth = 401/403-gated.">✓ Verify now</button>
        <button type="button" id="trk-btn-push" class="btn trk-btn-primary" data-help-title="Push to qBittorrent" data-help-text="Log into the qBittorrent WebUI and set its 'Automatically add these trackers to new downloads' list (plus existing torrents when enabled below).">⇧ Push to qBittorrent</button>
      </span>
    </div>

    <div class="trk-pills" id="trk-pills"><span class="trk-pill">loading…</span></div>
    <div class="trk-note" id="trk-note" hidden></div>

    <div class="trk-grid">
      <div class="trk-card">
        <div class="trk-card-title">Verification</div>
        <label class="trk-opt" data-help-title="Verify mechanism" data-help-text="ON: only trackers that answer a live probe reach qBittorrent. OFF: everything that passes the static filters is pushed; dead/auth rows stay visible in the table so you can see what you are adding.">
          <input type="checkbox" id="trk-opt-verify">
          <span>Verify before pushing (dead &amp; auth excluded)</span>
        </label>
        <label class="trk-opt" data-help-title="Auto refresh (cron)" data-help-text="The server re-fetches the lists on a period. Runs inside the mtapi process — no OS crontab needed. The next refresh time is shown in the pills.">
          <input type="checkbox" id="trk-opt-auto">
          <span>Cron auto-refresh</span>
          <select id="trk-opt-interval" class="trk-inline-select" data-help-title="Cron period" data-help-text="How often an auto-refresh fires while the cron toggle is on.">
            <option value="1">every hour</option>
            <option value="6">every 6h</option>
            <option value="12">every 12h</option>
            <option value="24">every day</option>
          </select>
        </label>
        <label class="trk-opt" data-help-title="Auto push" data-help-text="After each refresh/verify cycle, push the result straight to qBittorrent without pressing the button.">
          <input type="checkbox" id="trk-opt-autopush">
          <span>Auto-push after each cycle</span>
        </label>
      </div>

      <div class="trk-card">
        <div class="trk-card-title">Sources <span class="trk-dim">· ngosang/trackerslist</span></div>
        <div class="trk-optrow">
          <label class="trk-chip"><input type="checkbox" class="trk-src" value="best">best</label>
          <label class="trk-chip"><input type="checkbox" class="trk-src" value="all">all</label>
          <label class="trk-chip"><input type="checkbox" class="trk-src" value="http">http</label>
          <label class="trk-chip"><input type="checkbox" class="trk-src" value="udp">udp</label>
        </div>
        <div class="trk-card-title">Blacklist <span class="trk-dim">· substring match, one per line</span></div>
        <textarea id="trk-blacklist" rows="6" spellcheck="false" class="trk-textarea" data-help-title="Blacklist" data-help-text="Any tracker whose URL contains one of these substrings is dropped at refresh time. Preloaded with the obvious login-only trackers plus passkey/uid/auth credential markers."></textarea>
      </div>

      <div class="trk-card">
        <div class="trk-card-title">qBittorrent WebUI</div>
        <label class="trk-field" data-help-title="qBittorrent URL" data-help-text="Base URL of the qBittorrent WebUI. Enable it inside qBittorrent first: Tools → Options → Web UI.">
          <span>URL</span><input id="trk-qb-url" type="text" spellcheck="false">
        </label>
        <label class="trk-field" data-help-title="qBittorrent user" data-help-text="WebUI username configured inside qBittorrent itself.">
          <span>User</span><input id="trk-qb-user" type="text" spellcheck="false" autocomplete="off">
        </label>
        <label class="trk-field" data-help-title="qBittorrent password" data-help-text="WebUI password — stored beside the server's other local data files, never transmitted anywhere else.">
          <span>Pass</span><input id="trk-qb-pass" type="password" autocomplete="off">
        </label>
        <label class="trk-opt" data-help-title="Existing torrents" data-help-text="Also POST addTrackers onto every torrent currently in qBittorrent (capped at 200), not just future downloads.">
          <input type="checkbox" id="trk-opt-existing">
          <span>Apply to existing torrents</span>
        </label>
        <button type="button" id="trk-btn-save" class="btn trk-btn" data-help-title="Save settings" data-help-text="Persist toggles + qBittorrent credentials server-side and re-arm the cron schedule.">Save settings</button>
      </div>
    </div>

    <div class="trk-card">
      <div class="trk-card-title">Tracker table <span id="trk-shown" class="trk-dim"></span></div>
      <div class="trk-filters">
        <select id="trk-filter-status" class="trk-inline-select" data-help-title="Status filter" data-help-text="alive: answered a probe. dead: timeout/DNS/refused. auth: 401/403 gated. pending: not verified yet. webtorrent: wss/ws trackers — kept for reference, never pushed.">
          <option value="">any status</option>
          <option value="alive">alive</option>
          <option value="dead">dead</option>
          <option value="auth">auth</option>
          <option value="pending">pending</option>
          <option value="webtorrent">webtorrent</option>
        </select>
        <input id="trk-filter-q" type="text" placeholder="filter by url…" spellcheck="false" data-help-title="Url filter" data-help-text="Case-insensitive substring filter over the tracker URL.">
      </div>
      <div class="trk-tablewrap">
        <table class="trk-table">
          <thead><tr><th>URL</th><th>Scheme</th><th>Status</th><th>Checked</th></tr></thead>
          <tbody id="trk-tbody"></tbody>
        </table>
      </div>
    </div>

    <div class="trk-card">
      <div class="trk-card-title">Server log</div>
      <pre id="trk-log" class="trk-log"></pre>
    </div>
  </div>`;

  _el('trk-btn-refresh').addEventListener('click', () => _fireAction('refresh'));
  _el('trk-btn-verify').addEventListener('click', () => _fireAction('verify'));
  _el('trk-btn-push').addEventListener('click', _push);
  _el('trk-btn-save').addEventListener('click', _saveSettings);
  _el('trk-filter-status').addEventListener('change', _renderTable);
  _el('trk-filter-q').addEventListener('input', _renderTable);

  _status = null;
  _hydratedSettings = '';
  _pollStatus();
  if (_poll) clearInterval(_poll);
  _poll = setInterval(_pollStatus, 4000);
}

/* ── polling ────────────────────────────────────────────────────────── */

function _stopped() {
  return !document.body.classList.contains('trackers-tab-active');
}

async function _pollStatus() {
  if (_stopped()) return;
  try {
    const [sr, tr] = await Promise.all([
      fetch('/api/trackers/status').then(r => r.json()),
      fetch('/api/trackers/trackers?limit=1000').then(r => r.json()),
    ]);
    if (!sr.ok) { _log('trackers status: ' + (sr.error || 'unknown'), 'error'); return; }
    _status = sr;
    _rows = tr.ok ? (tr.rows || []) : [];
    _renderPills(sr);
    _hydrateSettings(sr.settings || {});
    _renderTable();
    _renderLog(sr.log || []);
    const busy = sr.busy || {};
    if (busy.refresh !== _lastBusy.refresh) {
      _log('trackers: refresh ' + (busy.refresh ? 'started' : 'finished'));
    }
    if (busy.verify !== _lastBusy.verify) {
      _log('trackers: verify ' + (busy.verify ? 'started' : 'finished'));
    }
    _lastBusy = busy;
    _el('trk-btn-refresh').disabled = !!busy.refresh;
    _el('trk-btn-verify').disabled = !!busy.verify || !!busy.refresh;
    _el('trk-btn-push').disabled = !!busy.refresh || !!busy.verify;
  } catch (e) {
    _log('trackers poll failed: ' + e, 'error');
  }
}

function _renderPills(j) {
  const c = j.counts || {};
  const next = j.next_refresh ? _eta(j.next_refresh) : 'cron off';
  const lines = [
    `pushable: ${j.pushable ?? '—'}`,
    `alive: ${c.alive ?? 0}`,
    `dead: ${c.dead ?? 0}`,
    `auth: ${c.auth ?? 0}`,
    `pending: ${c.pending ?? 0}`,
    `webtorrent: ${c.webtorrent ?? 0}`,
    `total: ${j.total ?? 0}`,
    `refreshed: ${_ago((j.last || {}).refresh)}`,
    `verified: ${_ago((j.last || {}).verify)}`,
    `cron: ${next}`,
  ];
  if ((j.busy || {}).refresh) lines.push('refreshing…');
  if ((j.busy || {}).verify) lines.push('verifying…');
  _el('trk-pills').innerHTML = lines.map((t, i) =>
    `<span class="trk-pill" data-help-title="Status ${i + 1}" data-help-text="${t}">${t}</span>`
  ).join('');
}

/* ── settings hydration / save ──────────────────────────────────────── */

function _hydrateSettings(s) {
  if (!s) return;
  const sig = JSON.stringify(s);
  if (sig === _hydratedSettings) return;
  _hydratedSettings = sig;
  _el('trk-opt-verify').checked = !!s.verify_enabled;
  _el('trk-opt-auto').checked = !!s.auto_refresh;
  _el('trk-opt-interval').value = String(s.interval_hours || 6);
  _el('trk-opt-autopush').checked = !!s.auto_push;
  for (const cb of document.querySelectorAll('.trk-src')) {
    cb.checked = (s.sources || []).includes(cb.value);
  }
  _el('trk-blacklist').value = (s.blacklist || []).join('\n');
  _el('trk-qb-url').value = s.qb_url || '';
  _el('trk-qb-user').value = s.qb_user || '';
  _el('trk-qb-pass').value = s.qb_pass || '';
  _el('trk-opt-existing').checked = !!s.push_existing;
}

async function _saveSettings() {
  const body = {
    verify_enabled: _el('trk-opt-verify').checked,
    auto_refresh: _el('trk-opt-auto').checked,
    interval_hours: Number(_el('trk-opt-interval').value) || 6,
    auto_push: _el('trk-opt-autopush').checked,
    push_existing: _el('trk-opt-existing').checked,
    sources: [...document.querySelectorAll('.trk-src:checked')].map(x => x.value),
    blacklist: _el('trk-blacklist').value.split(/\n+/).map(x => x.trim()).filter(Boolean),
    qb_url: _el('trk-qb-url').value.trim(),
    qb_user: _el('trk-qb-user').value.trim(),
    qb_pass: _el('trk-qb-pass').value,
  };
  try {
    const r = await fetch('/api/trackers/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) { _note('save failed: ' + (j.error || '?'), true); return; }
    _hydratedSettings = '';
    _note('settings saved · cron ' + (j.next_refresh ? _eta(j.next_refresh) : 'off'), false);
    _log('trackers: settings saved', 'ok');
  } catch (e) { _note('save failed: ' + e, true); }
}

function _note(msg, isErr) {
  const n = _el('trk-note');
  if (!n) return;
  n.hidden = false;
  n.textContent = msg;
  n.classList.toggle('trk-note-err', !!isErr);
}

/* ── actions ────────────────────────────────────────────────────────── */

async function _fireAction(kind) {
  try {
    const r = await fetch('/api/trackers/' + kind, { method: 'POST' });
    const j = await r.json();
    if (!j.ok) {
      _note(kind + ' refused: ' + (j.error || '?'), true);
      return;
    }
    _log('trackers: ' + kind + ' started', 'ok');
  } catch (e) { _note(kind + ' failed: ' + e, true); }
}

async function _push() {
  const btn = _el('trk-btn-push');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '⇧ pushing…';
  try {
    const r = await fetch('/api/trackers/push', { method: 'POST' });
    const j = await r.json();
    if (!j.ok) {
      _note('push failed: ' + (j.error || '?'), true);
      _log('trackers: push refused', 'error');
      return;
    }
    _note(`pushed ${j.pushed} trackers · existing torrents touched: ${j.existing}`, false);
    _log(`trackers: pushed ${j.pushed} to qBittorrent`, 'ok');
  } catch (e) {
    _note('push failed: ' + e, true);
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

/* ── table + log ────────────────────────────────────────────────────── */

function _row(e) {
  const st = e.status || 'pending';
  const ago = e.checked ? _ago(Math.round(e.checked)) : '—';
  return `<tr>
    <td class="trk-url" title="${e.url.replace(/"/g, '&quot;')}">${e.url.replace(/</g, '&lt;')}</td>
    <td><span class="trk-chip trk-chip-scheme">${e.scheme}</span></td>
    <td><span class="trk-chip trk-chip-status trk-st-${st}">${st}</span></td>
    <td class="trk-ago">${ago}</td>
  </tr>`;
}

function _renderTable() {
  if (!_el('trk-tbody')) return;
  const fs = _el('trk-filter-status').value;
  const q = _el('trk-filter-q').value.trim().toLowerCase();
  const rows = _rows.filter(e =>
    (!fs || (e.status || 'pending') === fs) &&
    (!q || (e.url || '').toLowerCase().includes(q)));
  const shown = rows.slice(0, 300);
  _el('trk-tbody').innerHTML = shown.length
    ? shown.map(_row).join('')
    : '<tr><td colspan="4" class="trk-empty">no trackers — press ↻ Refresh list</td></tr>';
  const shownEl = _el('trk-shown');
  if (shownEl) shownEl.textContent = `· showing ${shown.length} of ${rows.length}`;
}

function _renderLog(lines) {
  const pre = _el('trk-log');
  if (pre) pre.textContent = lines.join('\n');
}
