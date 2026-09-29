/**
 * Calendar Dart tab — "throw a dart at 2015-2024" event finder.
 *
 * Kind E: UI-only research workspace. No media, no /ops call, no subprocess.
 * Client-side fetch of Wikipedia OnThisDay (both public endpoints are
 * CORS-open: `access-control-allow-origin: *`), keyword scoring for POC
 * suitability, and a 10-throw history in localStorage.
 *
 * Spec: docs/Calendar-Dart-Spec.md
 */
import { elements, logConsole } from '/app.js';
import { escapeHtml } from '/js/utils.js';

const STORAGE_KEY = 'mtapi.dart.history.v1';
const YEAR_MIN = 2015;
const YEAR_MAX = 2024;
const MAX_SHOWN = 30;
const HISTORY_MAX = 10;
const FETCH_TIMEOUT_MS = 12000;

const ENDPOINTS = [
  'https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/',
  'https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/',
];

// Small, global, quickly-resolved events score HIGH. US-domestic and
// big-league-noise score LOW. Keyword heuristic by design (spec §Risks) —
// the LLM scorer replaces it later.
const HIGH_VALUE = [
  'trade pact', 'trade deal', 'trade agreement', 'rcep', 'license plate', 'licence plate',
  'border', 'border incident', 'gas', 'pipeline', 'submarine', 'tanker', 'vessel',
  'freighter', 'ferry', 'port', 'blockade', 'sanctions', 'tariff', 'treaty', 'embargo',
  'customs', 'strike', 'coup', 'earthquake', 'volcano', 'typhoon', 'cyclone', 'crash',
  'collision', 'seizure', 'detained', 'mine', 'hydro', 'dam', 'oil', 'lng',
  'asean', 'kosovo', 'serbia', 'myanmar', 'ethiopia', 'nagorno', 'armenia', 'azerbaijan',
  'sudan', 'venezuela', 'sri lanka', 'thailand', 'indonesia', 'vietnam', 'taiwan',
];
const LOW_VALUE = [
  'u.s. election', 'us election', 'presidential election', 'donald trump', 'joe biden',
  'supreme court', 'senate', 'house of representatives', 'presidential primary',
  'democratic party', 'republican party', 'impeachment', 'nba', 'nfl', 'super bowl',
  'oscars', 'grammys', 'met gala', 'thanksgiving', 'black friday',
];
const COUNTRY_HINTS = [
  'china', 'russia', 'india', 'turkey', 'iran', 'brazil', 'indonesia', 'serbia', 'kosovo',
  'ethiopia', 'myanmar', 'armenia', 'azerbaijan', 'taiwan', 'japan', 'korea', 'france',
  'germany', 'nigeria', 'sudan', 'chile', 'vietnam', 'philippines', 'pakistan', 'egypt',
  'venezuela', 'colombia', 'peru', 'mexico', 'canada', 'thailand', 'bangladesh', 'kenya',
];

/**
 * Word-boundary matchers, compiled once. Plain `includes` on these lists was
 * wrong: "port" fires inside airPORT and rePORT, "mine" inside underMINE, "dam"
 * inside AmSTERDAM, "oil" inside cOIL — so half the "global signal" credit went
 * to write-ups that merely mentioned an airport or a report.
 */
function _matchers(list) {
  return list.map((kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
}
const HIGH_MATCH = _matchers(HIGH_VALUE);
const LOW_MATCH = _matchers(LOW_VALUE);

const CURATED = [
  {
    date: 'Nov 15 2020 · RCEP',
    title: 'RCEP trade pact signed',
    body: '15 Asia-Pacific nations sign the world’s largest trade deal — 2.2B people, ~30% of global GDP. Coverage runs in Mandarin, Vietnamese, Bahasa, Japanese and Korean, and it landed in the same week as the US election, so it never got the coverage it deserved.',
  },
  {
    date: 'Sep 26 2021 · Kosovo–Serbia',
    title: 'License plate crisis at the border',
    body: 'Kosovo bans Serbian plates, Serbia retaliates with roadblocks, NATO KFOR mediates. A tiny object triggers geopolitics. Narratives live in Albanian, Serbian and Russian, and the story is fully completable in one sitting.',
  },
];

// Module state — the tab is re-rendered on every switch (uncached tab), so the
// last throw lives here, not in the DOM.
let _current = null;   // Date the last throw landed on
let _result = null;    // { total, sameYear, thrownIso, rows }
let _busy = false;
let _history = [];
let _abort = null;
let _copyPacks = [];   // rows[i].pack, kept out of the DOM (no attribute escaping)

function _readHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const list = Array.isArray(raw)
      ? raw.filter((h) => h && typeof h.iso === 'string')
      : [];
    _history = list.slice(0, HISTORY_MAX);
    // Self-heal an oversized store (older build, hand-edited, or seeded):
    // write the trimmed list back once instead of trimming on every read.
    if (list.length !== _history.length) _saveHistory();
  } catch (_) {
    _history = [];
  }
  return _history;
}

function _saveHistory() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_history.slice(0, HISTORY_MAX)));
  } catch (_) { /* quota / private mode — history is a convenience, not state */ }
}

function _randomDate() {
  const start = new Date(YEAR_MIN, 0, 1, 12, 0, 0).getTime();
  const end = new Date(YEAR_MAX, 11, 31, 12, 0, 0).getTime();
  return new Date(start + Math.random() * (end - start));
}

function _fmtLong(d) {
  try {
    return d.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    });
  } catch (_) {
    return d.toDateString();
  }
}

function _isoDay(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return { mm, dd, iso: `${d.getFullYear()}-${mm}-${dd}` };
}

/** Plain-text article title. titles.display is HTML; canonical is not. */
function _pageTitle(p) {
  const t = p && p.titles;
  const raw = (t && (t.canonical || t.normalized))
    || (p && p.title)
    || (t && t.display)
    || 'Wiki';
  return String(raw)
    .replace(/<[^>]*>/g, '')      // defensive: any markup wrapper
    .replace(/_/g, ' ')
    .trim() || 'Wiki';
}

/** Keyword scoring — HIGH for small/international/quick, LOW for US-domestic/big. */
function _scoreEvent(ev, thrownYear) {
  const text = `${ev.text} ${ev.year}`.toLowerCase();
  let score = 0;
  const reasons = [];

  if (ev.year === thrownYear) {
    score += 3;
    reasons.push({ t: 'same year', s: 1 });
  } else if (Math.abs(ev.year - thrownYear) <= 2) {
    score += 1;
  }

  let hits = 0;
  for (const re of HIGH_MATCH) {
    if (re.test(text)) { score += 2; hits += 1; }
  }
  if (hits) {
    score += Math.min(2, hits - 1);   // breadth bonus, capped
    reasons.push({ t: `+${hits} global/short signal${hits > 1 ? 's' : ''}`, s: 1 });
  }
  let lows = 0;
  for (const re of LOW_MATCH) {
    if (re.test(text)) { score -= 3; lows += 1; }
  }
  if (lows) reasons.push({ t: `−${lows} US-domestic/big signal${lows > 1 ? 's' : ''}`, s: -1 });

  const intl = COUNTRY_HINTS.filter((c) => text.includes(c)).length;
  if (intl >= 1) score += 1;
  if (intl >= 2) score += 1;
  if (intl >= 2) reasons.push({ t: `${intl} countries named`, s: 1 });

  if (ev.text.length < 160 && !text.includes('continues')) {
    score += 1;
    reasons.push({ t: 'concise', s: 1 });
  }

  const label = score >= 4 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
  const cls = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
  return { score, label, cls, reasons: reasons.slice(0, 3) };
}

/** Fetch OnThisDay events. Dual endpoints (both CORS-open) + timeout + abort. */
async function _fetchEvents(date, signal) {
  const { mm, dd } = _isoDay(date);
  let lastErr = null;

  for (const base of ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const relay = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      signal.addEventListener('abort', relay, { once: true });
    }
    try {
      const res = await fetch(`${base}${mm}/${dd}`, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
        cache: 'default',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const raw = (json && json.events) || (json && json.onthisday && json.onthisday.events) || [];
      if (!Array.isArray(raw) || !raw.length) throw new Error('no events returned');
      return raw
        .filter((e) => e && typeof e.text === 'string' && e.year)
        .map((e) => ({
          text: e.text,
          year: e.year,
          links: (Array.isArray(e.pages) ? e.pages : [])
            .slice(0, 2)
            .map((p) => ({
              // titles.display is raw HTML (<span class="mw-page-title-main">…</span>);
              // canonical/normalized are plain text with underscores.
              title: _pageTitle(p),
              url: (p && p.content_urls && p.content_urls.desktop && p.content_urls.desktop.page) || '',
            }))
            .filter((l) => l.url),
        }));
    } catch (err) {
      if (err && err.name === 'AbortError' && signal && signal.aborted) throw err;  // user-driven abort
      lastErr = err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', relay);
    }
  }
  throw lastErr || new Error('no events returned');
}

async function _loadDate(date, fromHistory) {
  if (_abort) { try { _abort.abort(); } catch (_) { /* ignore */ } }
  const ctrl = new AbortController();
  _abort = ctrl;
  _busy = true;
  _current = date;
  _paint({ busy: true });

  try {
    const events = await _fetchEvents(date, ctrl.signal);
    if (ctrl.signal.aborted) return;

    const thrownYear = date.getFullYear();
    const thrownIso = `${thrownYear}-${_isoDay(date).mm}-${_isoDay(date).dd}`;
    const forYear = events.filter((e) => e.year === thrownYear);
    // The whole day stays in play. Same-year events carry the +3 year bonus, so
    // they sort to the top on their own — filtering the day down to them threw
    // away 77 of 78 events whenever a throw landed on a quiet date.
    const rows = events
      .map((ev) => ({ ev, sc: _scoreEvent(ev, thrownYear) }))
      .sort((a, b) => (b.sc.score - a.sc.score)
        || (Math.abs(a.ev.year - thrownYear) - Math.abs(b.ev.year - thrownYear))
        || (a.ev.text.length - b.ev.text.length))
      .slice(0, MAX_SHOWN)
      .map((r) => ({
        ...r,
        sameYear: r.ev.year === thrownYear,
        // Query pack: the event text plus the date it resolves to. Same-year
        // events get the exact thrown day; older ones just the year.
        pack: `${r.ev.text.replace(/\s+/g, ' ').trim()} (${r.ev.year === thrownYear ? thrownIso : r.ev.year})`,
      }));

    _result = {
      total: events.length,
      sameYear: forYear.length,
      thrownIso,
      rows,
    };

    // Only successful throws are recorded — a failed fetch has no top event,
    // and Retry puts the same date back on screen anyway.
    if (!fromHistory) {
      const top = rows[0];
      _history = _history.filter((h) => h.iso !== thrownIso);
      _history.unshift({
        iso: thrownIso,
        dateStr: _fmtLong(date),
        topEvent: top ? top.ev.text : '',
        badge: top ? top.sc.label : '—',
        count: events.length,
      });
      _history = _history.slice(0, HISTORY_MAX);
      _saveHistory();
    }

    // Paint last: the history strip is part of the render, and the push above
    // is what feeds it.
    _busy = false;
    _paint();

    logConsole(`[DART]: ${_fmtLong(date)} — ${events.length} events, ${rows.length} shown`
      + `, ${forYear.length} from ${thrownYear}`);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    _busy = false;
    _result = null;
    _paint({ error: (err && err.message) || 'network error' });
    logConsole(`[DART]: fetch failed — ${(err && err.message) || err}`, 'error');
  }
}

function _renderEventRow(row, i) {
  const ev = row.ev;
  const reasons = row.sc.reasons
    .map((r) => `<span class="dart-reason${r.s < 0 ? ' is-minus' : (r.s > 0 ? ' is-plus' : '')}">${escapeHtml(r.t)}</span>`)
    .join('');
  const links = ev.links
    .map((l) => `<a class="dart-wiki-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer" data-help-title="Wikipedia — ${escapeHtml(l.title)}" data-help-text="Opens the article in a new tab. Read the event in its own-language coverage before querying GDELT.">${escapeHtml(l.title)}</a>`)
    .join('');
  return `
    <div class="dart-event is-${row.sc.cls}">
      <div class="dart-event-top">
        <span class="dart-badge dart-badge-${row.sc.cls}">${row.sc.label}</span>
        <span class="dart-year">${escapeHtml(String(ev.year))}${row.sameYear ? ' · thrown year' : ''}</span>
        <span class="dart-reasons">${reasons}</span>
      </div>
      <div class="dart-text">${escapeHtml(ev.text)}</div>
      <div class="dart-links">
        ${links}
        <button type="button" class="btn" data-copy="${i}" data-help-title="Copy query pack" data-help-text="Puts &quot;&lt;event text&gt; (YYYY-MM-DD)&quot; on the clipboard for the next tool. Falls back to a hidden textarea when the clipboard API is unavailable (http origins are not a secure context).">Copy query</button>
      </div>
    </div>`;
}

/** Paint from module state. Safe to call on every switch. */
function _paint(opts = {}) {
  const dateEl = document.getElementById('dartDate');
  const statusEl = document.getElementById('dartStatus');
  const eventsEl = document.getElementById('dartEvents');
  const historyEl = document.getElementById('dartHistory');
  const throwBtn = document.getElementById('btnDartThrow');
  if (!eventsEl) return;

  if (throwBtn) {
    throwBtn.disabled = !!_busy;
    throwBtn.classList.toggle('is-throwing', !!_busy);
    throwBtn.textContent = _busy ? '🎯 In flight…' : '🎯 Throw Dart';
  }

  if (dateEl) {
    if (_current) {
      dateEl.textContent = _fmtLong(_current);
      dateEl.classList.remove('is-idle');
    } else {
      dateEl.textContent = 'No throw yet';
      dateEl.classList.add('is-idle');
    }
  }

  if (statusEl) {
    statusEl.classList.remove('is-error', 'is-busy');
    if (_busy || opts.busy) {
      statusEl.classList.add('is-busy');
      statusEl.textContent = 'Fetching Wikipedia OnThisDay…';
    } else if (opts.error) {
      statusEl.classList.add('is-error');
      statusEl.textContent = `Wikipedia API hiccup (${opts.error}). Retry, or throw a different date.`;
    } else if (_result) {
      const head = `${_result.total} events for ${_isoDay(_current).mm}/${_isoDay(_current).dd}`;
      const filter = _result.sameYear
        ? `, ${_result.sameYear} from ${_current.getFullYear()} (scored to the top)`
        : `, none from ${_current.getFullYear()} — this date has no coverage that year`;
      const cut = _result.rows.length < _result.total
        ? `truncated from ${_result.total}`
        : 'all shown';
      statusEl.textContent = `${head}${filter} · top ${_result.rows.length} (${cut}) HIGH→LOW.`;
    } else {
      statusEl.textContent = '';
    }
  }

  if (eventsEl) {
    if (_busy) {
      eventsEl.innerHTML = '<div class="dart-notice">🎯 Dart in flight…</div>';
    } else if (opts.error) {
      eventsEl.innerHTML = `<div class="dart-notice">Could not load events.<button type="button" class="btn" id="btnDartRetry" data-help-title="Retry this date" data-help-text="Re-issues the OnThisDay request for the same month/day, trying both public endpoints again.">Retry</button></div>`;
      document.getElementById('btnDartRetry')?.addEventListener('click', () => {
        if (_current) _loadDate(_current, true);
      });
    } else if (!_result) {
      eventsEl.innerHTML = '<div class="dart-notice">Throw your first dart — a random day between 2015 and 2024 — to get scored events to pick from.</div>';
    } else if (!_result.rows.length) {
      eventsEl.innerHTML = '<div class="dart-notice">No events returned for this date. Throw again.</div>';
    } else {
      _copyPacks = _result.rows.map((r) => r.pack);
      eventsEl.innerHTML = _result.rows.map(_renderEventRow).join('');
      eventsEl.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.getAttribute('data-copy'), 10);
          _copy(_copyPacks[i] || '', btn);
        });
      });
    }
  }

  if (historyEl) {
    const list = _readHistory();
    if (!list.length) {
      historyEl.innerHTML = '<span class="form-row-hint">No throws yet — the last 10 land here, click one to reload it.</span>';
    } else {
      historyEl.innerHTML = list.map((h, i) => {
        const isCurrent = _result && _result.thrownIso === h.iso;
        return `<button type="button" class="dart-history-item${isCurrent ? ' is-current' : ''}" data-hist="${i}" data-help-title="Reload ${escapeHtml(h.dateStr)}" data-help-text="Loads this throw again — same month/day, re-scored and re-sorted. Not re-added to history.">
          <span class="dart-h-date">${escapeHtml(h.dateStr)}</span>
          <span class="dart-h-top">${escapeHtml(h.topEvent || '(no top event)')}</span>
        </button>`;
      }).join('') + '<button type="button" class="btn dart-history-clear" id="btnDartClearHist" data-help-title="Clear dart history" data-help-text="Empties the 10-throw list from localStorage. Throws you already copied are unaffected.">Clear</button>';
      historyEl.querySelectorAll('[data-hist]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const item = _history[parseInt(btn.getAttribute('data-hist'), 10)];
          if (!item) return;
          const [y, m, d] = item.iso.split('-').map((n) => parseInt(n, 10));
          if (!y || !m || !d) return;
          _loadDate(new Date(y, m - 1, d, 12, 0, 0), true);
        });
      });
      document.getElementById('btnDartClearHist')?.addEventListener('click', () => {
        _history = [];
        _saveHistory();
        _paint();
        logConsole('[DART]: history cleared');
      });
    }
  }
}

function _copy(text, btn) {
  if (!text) return;
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { if (btn.isConnected) btn.textContent = old; }, 1200);
    logConsole(`[DART]: copied query pack — ${text}`);
  };
  // navigator.clipboard is undefined on http:// origins (not a secure context),
  // which is how the WebUI is normally reached. Fall back before giving up.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => _copyFallback(text, done));
  } else {
    _copyFallback(text, done);
  }
}

function _copyFallback(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) done();
    else _copyPrompt(text);
  } catch (_) {
    _copyPrompt(text);
  }
}

function _copyPrompt(text) {
  logConsole(`[DART]: clipboard blocked — copy this manually: ${text}`);
  try { window.prompt('Copy the query pack:', text); } catch (_) { /* ignore */ }
}

function renderDartForm() {
  _readHistory();
  elements.actionPanel.innerHTML = `
    <div class="dart-workspace">
      <div class="panel-title-desc dense">
        <h3>Calendar Dart · forgotten global events</h3>
        <p class="dream-hint">
          <strong>Research tool — no video, image, or Run needed.</strong>
          Throws a random day between ${YEAR_MIN} and ${YEAR_MAX}, pulls that day from
          Wikipedia OnThisDay, and scores every event for research-POC suitability:
          HIGH for small, international, multilingual, quickly-resolved; LOW for US-domestic
          and big-league noise. Pick one, copy its query pack, move on to the next tool.
        </p>
      </div>

      <div class="dart-throw-row">
        <button type="button" class="btn dart-throw-btn" id="btnDartThrow"
          data-help-title="Throw Dart"
          data-help-text="Picks a random date between ${YEAR_MIN}-01-01 and ${YEAR_MAX}-12-31 and fetches that day from Wikipedia OnThisDay. Disabled while a request is in flight; throws are remembered locally.">🎯 Throw Dart</button>
        <span class="dart-date-readout is-idle" id="dartDate">No throw yet</span>
      </div>

      <div class="dart-status" id="dartStatus" role="status"></div>

      <div class="dart-events" id="dartEvents"></div>

      <div>
        <h4 class="dream-section-title">Last throws</h4>
        <div class="dart-history" id="dartHistory"></div>
      </div>

      <div>
        <h4 class="dream-section-title">Good POC examples · calibration</h4>
        <div class="dart-cards">
          ${CURATED.map((c) => `
            <div class="dart-card">
              <div class="dart-card-top">
                <span class="dart-badge dart-badge-high">HIGH · IDEAL</span>
                <span class="dart-card-date">${escapeHtml(c.date)}</span>
              </div>
              <h4>${escapeHtml(c.title)}</h4>
              <p>${escapeHtml(c.body)}</p>
            </div>`).join('')}
        </div>
      </div>

      <section class="tool-docs" aria-label="About Calendar Dart">
        <h4 class="tool-docs-title">About · Calendar Dart</h4>
        <p class="tool-docs-lede">
          Throws land in the ${YEAR_MIN}–${YEAR_MAX} window because that is where
          multilingual digital coverage (and therefore queryable archives) exists. The feed
          is a calendar-day list, so the same date returns the same events every time —
          reloading history is deterministic, the scoring is not.
        </p>
        <p class="tool-docs-h">How the score works</p>
        <ul class="tool-docs-ul">
          <li>Same year as the throw: <code>+3</code>; within two years: <code>+1</code>.</li>
          <li>Each global/short-lived signal (trade pact, border, tanker, port, embargo, quake): <code>+2</code>, plus a capped breadth bonus.</li>
          <li>Two or more countries named: <code>+1/+2</code>. Concise write-up: <code>+1</code>.</li>
          <li>Each US-domestic/big signal (election, Senate, league, awards): <code>−3</code>.</li>
          <li>Keywords match on word boundaries — <code>port</code> does not fire on <em>airport</em>, <code>dam</code> does not fire on <em>Amsterdam</em>.</li>
          <li><code>≥4 HIGH</code> · <code>≥2 MEDIUM</code> · below that <code>LOW</code>. Keyword heuristic on purpose — an LLM scorer replaces it later. Expect 0–7 HIGH per throw; a day with none is a real answer, throw again.</li>
        </ul>
        <p class="tool-docs-h">Limits</p>
        <ul class="tool-docs-ul">
          <li>Client-side fetch of two public endpoints (<code>en.wikipedia.org</code> then <code>api.wikimedia.org</code>); no backend, no proxy, nothing written to disk.</li>
          <li>History is the last 10 throws in <code>localStorage</code> only — not part of a saved project.</li>
          <li>GDELT URL retrieval, multilingual query packs, and article download are follow-ups, not in this tab.</li>
        </ul>
      </section>
    </div>`;

  document.getElementById('btnDartThrow')?.addEventListener('click', () => {
    if (_busy) return;
    _loadDate(_randomDate(), false);
  });

  _paint();
}

export { renderDartForm };
