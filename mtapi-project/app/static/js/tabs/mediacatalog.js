/** Media Catalog tab (spec §10): scan a directory, filter the whole library.
 *
 * Reads the shipped `GET /api/media-catalog/query` (server-side facets + paging)
 * and renders a virtualized table so a 100k-row library doesn't lock the DOM.
 * Scan runs through the standard job machinery (`runOpWithCancel`), so progress
 * and cancel come for free — this tab owns no job plumbing of its own.
 *
 * Everything is opt-in about *analysis*, never about *indexing*: turning every
 * analysis toggle off still indexes the directory, which is the honest default
 * for a huge library you just want browsable.
 */
import { state, elements, switchTab, logConsole } from '/app.js?v=2';
import { runOpWithCancel } from '/js/job-control.js';
import { escapeHtml, shortKey } from '/js/utils.js';

const KEY_OPTIONS = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
].flatMap((t) => [`${t} major`, `${t} minor`]);

const ROW_H_FALLBACK = 35;
// Measured from the DOM after first render — rows must be a fixed height for
// the virtualization math, and CSS is the authority, not this constant.
let rowHPx = ROW_H_FALLBACK;
const OVERSCAN = 6;

let audio = null;            // single <audio> element, reused per row
let playingPath = null;
let lastQuery = '';
let rowsCache = [];
let pageOffset = 0;
const PAGE = 200;

const facets = {
  q: '', type: '', mine: '', hand: '', ai: '', origin: '', site: '',
  key: '', tempoMin: '', tempoMax: '', status: '',
};

function _log(msg, kind) {
  logConsole(msg, kind);
}

function _el(id) { return document.getElementById(id); }

function _esc(s) { return escapeHtml(String(s == null ? '' : s)); }

function _fmtDuration(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return '—';
  const s = Math.round(Number(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
}

/* ── query string ───────────────────────────────────────────────────── */
function buildQuery(extra = {}) {
  const p = new URLSearchParams();
  const merged = { ...facets, ...extra };
  for (const [k, v] of Object.entries(merged)) {
    if (v === '' || v == null) continue;
    p.set(k, String(v));
  }
  p.set('limit', String(PAGE));
  p.set('offset', String(extra.offset != null ? extra.offset : pageOffset));
  return p.toString();
}

async function fetchRows({ append = false } = {}) {
  const qs = buildQuery();
  lastQuery = qs;
  const res = await fetch(`/api/media-catalog/query?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'query failed');
  rowsCache = append ? [...rowsCache, ...data.rows] : data.rows;
  return { rows: data.rows, total: data.total };
}

/* sorting travels with the query (server-side — the table is paged) */
function mcApplyOrder() {
  const order = mcOrderParam();
  if (order) facets.order = order;
  else delete facets.order;
}

/* ── badges ─────────────────────────────────────────────────────────── */
function badgesHtml(row) {
  const out = [];
  if (row.is_mine) out.push('<span class="mc-badge mc-badge-mine">✦ mine</span>');
  if (row.made_by_me) out.push('<span class="mc-badge mc-badge-hand">HAND</span>');
  if (row.ai_involved) out.push('<span class="mc-badge mc-badge-ai">AI</span>');
  if (row.origin === 'generated') out.push('<span class="mc-badge mc-badge-gen">GEN</span>');
  if (row.is_youtube) out.push('<span class="mc-badge mc-badge-web">YouTube</span>');
  else if (row.site) out.push(`<span class="mc-badge mc-badge-web">${_esc(row.site)}</span>`);
  if (row.tempo_octave_split) {
    out.push('<span class="mc-badge mc-badge-split" data-help-title="Engines disagreed by an octave" data-help-text="At least one engine counted the pulse at double or half time. The majority reading is used.">½ octave</span>');
  }
  if (row.tag_acidized) out.push('<span class="mc-badge mc-badge-acid">ACID</span>');
  if (row.title) out.push(`<span class="mc-badge mc-badge-title" data-help-title="${_esc(row.title)}">♪ ${_esc(row.title.slice(0, 22))}</span>`);
  if (row.status === 'missing') out.push('<span class="mc-badge mc-badge-missing">missing</span>');
  if (row.status === 'error') out.push('<span class="mc-badge mc-badge-error">error</span>');
  // Single line, never wrapped — the row height is virtualized, so a wrapped
  // cell would silently break scroll math. Full text lives on the title.
  const plain = out.map((h) => h.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  return out.length ? `<div class="mc-badges" data-help-title="${_esc(plain.join(' · '))}">${out.join('')}</div>` : '';
}

/* ── column model (reference-table design) ──────────────────────────────
 * Every column: toggle checkbox + sort arrow in the header, rotated label,
 * faint dividers, collapsed columns shrink to a strip (never vanish), and all
 * sorting travels with the query (server-side, since the table is paged).
 * Visibility persists in localStorage, independent of the filter facets. */
const MC_COLS = [
  { key: 'play', label: 'Play', width: '26px', sortable: false },
  { key: 'type', label: 'Type', width: '44px', sortable: true, order: 'type' },
  // File is content-sized but capped: long paths truncate with the full path
  // on hover, and leftover space belongs to the trailing spacer, not here.
  { key: 'name', label: 'File', width: 'minmax(180px, 520px)', sortable: true, order: 'name' },
  { key: 'tags', label: 'Tags', width: 'minmax(0, 140px)', sortable: true, order: 'mine' },
  { key: 'dur', label: 'Dur', width: '48px', sortable: true, order: 'duration' },
  { key: 'key', label: 'Key', width: '52px', sortable: true, order: 'key' },
  { key: 'bpm', label: 'BPM', width: '58px', sortable: true, order: 'tempo' },
  { key: 'tag', label: 'Tag', width: '104px', sortable: true, order: 'tag_key' },
  { key: 'rel', label: 'Rel', width: '84px', sortable: true, order: 'key' },
  { key: 'src', label: 'Src', width: '88px', sortable: true, order: 'source' },
  { key: 'act', label: 'Act', width: '72px', sortable: false },
  // Trailing spacer: takes whatever space is left over — columns use only
  // what they need, no more, no less. Never toggled, never sorted.
  { key: 'gap', label: '', width: 'minmax(0, 1fr)', sortable: false, spacer: true },
];

const MC_VIS_KEY = 'mediacatalog-col-vis';

function mcLoadVis() {
  try {
    return JSON.parse(localStorage.getItem(MC_VIS_KEY) || '{}');
  } catch (_) {
    return {};
  }
}

let mcVis = mcLoadVis();
let mcSort = { key: null, dir: 1 };  // dir: 1 asc, -1 desc

function mcIsVisible(key) {
  return mcVis[key] !== false;
}

function mcSetVisible(key, visible) {
  mcVis[key] = visible;
  try {
    localStorage.setItem(MC_VIS_KEY, JSON.stringify(mcVis));
  } catch (_) { /* ignore */ }
}

function mcGridTemplate() {
  return MC_COLS.map((c) => (mcIsVisible(c.key) ? c.width : '12px')).join(' ');
}

function mcOrderParam() {
  if (!mcSort.key) return null;
  const col = MC_COLS.find((c) => c.key === mcSort.key);
  if (!col || !col.sortable) return null;
  return `${col.order}_${mcSort.dir === 1 ? 'asc' : 'desc'}`;
}

function mcToggleSort(key) {
  const col = MC_COLS.find((c) => c.key === key);
  if (!col || !col.sortable) return;
  if (mcSort.key === key) {
    mcSort.dir = mcSort.dir === 1 ? -1 : 1;
  } else {
    mcSort = { key, dir: 1 };
  }
  pageOffset = 0;
  const scroller = _el('mcScroll');
  if (scroller) scroller.scrollTop = 0;
  refresh();
}

function mcHeadHtml() {
  return `<div class="mc-headrow" style="grid-template-columns: ${mcGridTemplate()}">` +
    MC_COLS.map((c) => {
      if (c.spacer) return `<div class="mc-headcell mc-head-spacer"></div>`;
      const visible = mcIsVisible(c.key);
      const active = mcSort.key === c.key;
      const arrow = !c.sortable ? '' :
        `<span class="mc-sort-arrow${active ? '' : ' dim'}">${active ? (mcSort.dir === 1 ? ' ▲' : ' ▼') : ' ⇅'}</span>`;
      return `<div class="mc-headcell${visible ? '' : ' mc-col-collapsed'}" data-mc-col="${c.key}">`
        + `<span class="mc-head-top">`
        + `<label class="mc-col-toggle" data-help-title="Toggle column"><input type="checkbox"${visible ? ' checked' : ''} data-mc-toggle="${c.key}"></label>`
        + arrow
        + `</span>`
        + (visible ? `<span class="mc-head-label" data-help-title="${_esc(c.label)}">${_esc(c.label)}</span>` : '')
        + `</div>`;
    }).join('') + `</div>`;
}

function cellKey(row) {
  const short = _esc(row.short_key || shortKey(row.key_name) || '—');
  const full = row.key_name || '';
  const tip = [full, row.key_engine ? `detected: ${row.key_engine}` : '']
    .filter(Boolean).join(' · ');
  return `<span class="mc-key" data-help-title="${_esc(tip)}">${short}</span>`;
}

function cellBpm(row) {
  if (row.tempo == null) return '—';
  const spread = row.tempo_spread_bpm;
  const tip = [`engine: ${row.tempo_engine || 'scan'}`];
  if (spread != null && Number(spread) > 0.05) {
    tip.push(`engines disagreed by ${Number(spread).toFixed(1)} BPM — full breakdown in the sidecar .json`);
  }
  return `<span class="mc-bpm" data-help-title="${_esc(tip.join(' · '))}">${Number(row.tempo).toFixed(1)}</span>`;
}

function cellTag(row) {
  const bits = [];
  if (row.tag_camelot) bits.push(_esc(row.tag_camelot));
  if (row.tag_bpm != null) {
    const delta = row.tempo_vs_tag_bpm;
    const agree = row.tempo_agrees_with_tag;
    const oct = row.tempo_octave_equivalent && !agree;
    bits.push(`tag ${Number(row.tag_bpm).toFixed(0)}`
      + (delta != null ? ` (${delta > 0 ? '+' : ''}${Number(delta).toFixed(1)})` : '')
      + (oct ? ' ×½?' : (agree ? ' ✓' : '')));
  }
  if (!bits.length) return '—';
  const cam = row.tag_camelot ? `camelot: ${row.tag_camelot}` : '';
  const tagKey = row.tag_key ? `tagged key: ${row.tag_key}` : '';
  return `<span class="mc-cell-tag" data-help-title="${_esc([cam, tagKey].filter(Boolean).join(' · '))}">${bits.join(' · ')}</span>`;
}

function cellRel(row) {
  if (!row.relative_key) return '—';
  const short = shortKey(row.relative_key);
  const cam = row.relative_camelot ? ` · ${row.relative_camelot}` : '';
  const tip = row.key_name
    ? `Relative of ${row.key_name}: ${row.relative_key}`
    : `Relative key: ${row.relative_key}`;
  return `<span class="mc-rel" data-help-title="${_esc(tip)}">${_esc(short)}${_esc(cam)}</span>`;
}

function cellSrc(row) {
  const src = row.tempo_source;
  if (!(src && row.tag_bpm != null && row.tempo_detected != null)) return '—';
  const other = src === 'tagged' ? 'detected' : 'tagged';
  const otherValue = Number(other === 'tagged' ? row.tag_bpm : row.tempo_detected);
  return `<button type="button" class="mc-src mc-src-${src}" data-mc-source="${_esc(row.path)}" data-field="tempo" data-to="${other}" data-help-title="Tempo source of truth" data-help-text="Using the ${src} tempo (${Number(row.tempo).toFixed(1)} BPM). Click to use the ${other} one instead (${otherValue.toFixed(1)} BPM). Both numbers are always kept.">⚡ ${src.slice(0, 4)}</button>`;
}

function cellAct(row) {
  return `<div class="mc-actions-cell">`
    + `<button type="button" class="btn btn-sm" data-mc-provenance="${_esc(row.path)}" data-help-title="Provenance" data-help-text="Open the three-bit provenance editor for this file.">✦</button>`
    + `<button type="button" class="btn btn-sm" data-mc-send="${_esc(row.path)}" data-help-title="Send to Media In" data-help-text="Send this file to the global Media In box as the input.">→I</button>`
    + `</div>`;
}

function rowHtml(row) {
  const type = row.type || 'unknown';
  const playing = playingPath && playingPath === row.path;
  const playBtn = type === 'audio'
    ? `<button type="button" class="mc-cell-play" data-mc-play="${_esc(row.path)}" data-help-title="Play" data-help-text="Play or stop this audio file inline.">${playing ? '■' : '▶'}</button>`
    : '<span class="mc-cell-play">—</span>';
  return `
    <div class="mc-row${playing ? ' mc-row-playing' : ''}" data-mc-row="${_esc(row.path)}" style="grid-template-columns: ${mcGridTemplate()}">
      <div class="mc-cell">${playBtn}</div>
      <div class="mc-cell mc-cell-type mc-type-${type}">${_esc(type.slice(0, 4).toUpperCase())}</div>
      <div class="mc-cell mc-cell-name">
        <span class="mc-name" data-help-title="${_esc(row.path)}">${_esc(row.name || row.path)}</span>
        <span class="mc-cell-path" data-help-title="${_esc(row.path)}">${_esc(row.path)}</span>
      </div>
      <div class="mc-cell">${badgesCell(row)}</div>
      <div class="mc-cell mc-cell-dur">${_fmtDuration(row.duration)}</div>
      <div class="mc-cell">${cellKey(row)}</div>
      <div class="mc-cell">${cellBpm(row)}</div>
      <div class="mc-cell">${cellTag(row)}</div>
      <div class="mc-cell">${cellRel(row)}</div>
      <div class="mc-cell">${cellSrc(row)}</div>
      <div class="mc-cell">${cellAct(row)}</div>
      <div class="mc-cell mc-cell-gap"></div>
    </div>`;
}

function badgesCell(row) {
  const html = badgesHtml(row);
  return html || '—';
}

/* ── virtualized render ─────────────────────────────────────────────── */
function renderTable() {
  const scroller = _el('mcScroll');
  if (!scroller) return;
  const head = mcHeadHtml();
  const total = rowsCache.length;
  if (total === 0) {
    scroller.innerHTML = head + `<div class="mc-empty">
      No rows match these filters.<br />
      Try <code>Clear filters</code>, run a <b>Scan</b> on a folder, import media into a pool,
      or download something with the <code>yt-dlp</code> tab.
    </div>`;
    _updateCount(0, 0);
    bindHeadControls();
    return;
  }
  mcApplyOrder();
  const viewH = scroller.clientHeight || 480;
  const first = Math.max(0, Math.floor(scroller.scrollTop / rowHPx) - OVERSCAN);
  const visible = Math.ceil(viewH / rowHPx) + OVERSCAN * 2;
  const slice = rowsCache.slice(first, first + visible);
  const padTop = first * rowHPx;
  const padBottom = Math.max(0, (total - first - slice.length) * rowHPx);

  scroller.innerHTML = head +
    `<div style="height:${padTop}px"></div>` +
    slice.map(rowHtml).join('') +
    `<div style="height:${padBottom}px"></div>`;
  _updateCount(total, total);
  bindHeadControls();
  // Measure the real row height once — CSS owns it, the constant only falls back.
  const probe = scroller.querySelector('.mc-row');
  if (probe && probe.offsetHeight > 10) rowHPx = probe.offsetHeight;
}

/* Header sort + toggle clicks — rebound after every render (headers re-render). */
function bindHeadControls() {
  const scroller = _el('mcScroll');
  if (!scroller) return;
  scroller.querySelectorAll('[data-mc-toggle]').forEach((box) => {
    box.addEventListener('change', () => {
      mcSetVisible(box.dataset.mcToggle, box.checked);
      renderTable();
    });
  });
  scroller.querySelectorAll('.mc-headcell').forEach((cell) => {
    const key = cell.dataset.mcCol;
    const col = MC_COLS.find((c) => c.key === key);
    if (!col || !col.sortable) return;
    cell.style.cursor = 'pointer';
    cell.addEventListener('click', (e) => {
      // The checkbox has its own handler — don't sort when toggling.
      if (e.target.closest('[data-mc-toggle]')) return;
      mcToggleSort(key);
    });
  });
}

function _updateCount(shown, total) {
  const el = _el('mcCount');
  if (!el) return;
  const isPartial = total > rowsCache.length;
  el.textContent = isPartial
    ? `${rowsCache.length} of ${total} rows loaded — scroll for more`
    : `${total} row${total === 1 ? '' : 's'}`;
}

/* ── load more on scroll ────────────────────────────────────────────── */
function _onScroll() {
  const scroller = _el('mcScroll');
  if (!scroller) return;
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40) {
    maybeLoadMore();
  }
}

let loadingMore = false;
async function maybeLoadMore() {
  if (loadingMore) return;
  const res = _el('mcCount');
  if (!res || !/of \d+ rows loaded/.test(res.textContent)) return;
  loadingMore = true;
  try {
    pageOffset += PAGE;
    await fetchRows({ append: true });
    renderTable();
  } catch (err) {
    pageOffset -= PAGE;
  } finally {
    loadingMore = false;
  }
}

/* ── audio playback ─────────────────────────────────────────────────── */
function ensureAudio() {
  if (audio) return audio;
  const holder = _el('mcAudioHolder');
  audio = document.createElement('audio');
  audio.className = 'mc-audio';
  audio.controls = true;
  audio.addEventListener('ended', () => { playingPath = null; renderTable(); });
  if (holder) holder.appendChild(audio);
  return audio;
}

async function togglePlay(path) {
  const el = ensureAudio();
  if (playingPath === path) {
    el.pause();
    playingPath = null;
    renderTable();
    return;
  }
  el.src = `/api/video?path=${encodeURIComponent(path)}`;
  playingPath = path;
  renderTable();
  try {
    await el.play();
  } catch (err) {
    _log(`[CATALOG] playback failed: ${err.message}`, 'error');
    playingPath = null;
  }
}

/* ── actions ────────────────────────────────────────────────────────── */
async function sendToMediaIn(path) {
  const gi = document.getElementById('giMediaIn');
  if (!gi) { _log('[CATALOG] Media In box not found', 'error'); return; }
  gi.value = path;
  gi.dispatchEvent(new Event('input', { bubbles: true }));
  _log(`[CATALOG]: sent to Media In → ${path}`);
}

async function switchSource(btn) {
  const path = btn.dataset.mcSource;
  const field = btn.dataset.field;
  const to = btn.dataset.to;
  try {
    const res = await fetch('/api/media-catalog/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, field, source: to }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'switch failed');
    _log(`[CATALOG]: ${field} source for ${path.split('/').pop()} \u2192 ${to} (${data.value})`);
    await refresh();
  } catch (err) {
    _log(`[CATALOG] source switch failed: ${err.message}`, 'error');
  }
}

async function openProvenanceEditor(path) {
  const prov = await import('/js/pool/provenance.js');
  const row = rowsCache.find((r) => r.path === path) || null;
  const cur = row || { is_mine: false, made_by_me: false, ai_involved: false, name: path.split('/').pop() };
  const bits = [];
  const pick = (key, label) => bits.push(
    `- **${label}**: ${cur[key] ? 'yes' : 'no'} (click to toggle)`,
  );
  pick('is_mine', '✦ mine');
  pick('made_by_me', 'HAND (made by me)');
  pick('ai_involved', 'AI involved');
  const msg = bits.join('\n');
  if (!window.confirm(`${cur.name || path}\n\n${msg}\n\nOK = toggle ✦ mine · Cancel = close`)) {
    return;
  }
  await prov.setProvenance(path, { is_mine: !cur.is_mine });
  await refresh();
  switchTab('mediacatalog');
}

async function pickDirectory() {
  const res = await fetch('/api/picker?mode=dir');
  if (!res.ok) return;
  const data = await res.json();
  if (!data.path) return;
  const input = _el('mcDir');
  if (input) input.value = data.path;
}

/* ── scan ───────────────────────────────────────────────────────────── */
function scanParams() {
  const val = (id) => (_el(id)?.checked ?? false);
  const num = (id) => Number(_el(id)?.value || 0) || 0;
  return {
    target_directory: (_el('mcDir')?.value || '').trim(),
    recursive: val('mcRecursive'),
    analyze_key: val('mcAnalyzeKey'),
    analyze_tempo: val('mcAnalyzeTempo'),
    analyze_beats: val('mcAnalyzeBeats'),
    analyze_midi: val('mcAnalyzeMidi'),
    long_file_guard_sec: num('mcGuard'),
    reanalyze: val('mcReanalyze'),
    include_extra_opinions: val('mcExtraOpinions'),
  };
}

async function runScan(dryRun) {
  const params = scanParams();
  if (!params.target_directory) {
    _log('[CATALOG] Pick a directory first', 'error');
    return;
  }
  const status = _el('mcStatus');
  const btnScan = _el('btnMcScan');
  const btnDry = _el('btnMcDry');
  btnScan?.setAttribute('disabled', 'disabled');
  btnDry?.setAttribute('disabled', 'disabled');
  if (status) status.textContent = dryRun ? 'Dry run…' : 'Scanning…';
  try {
    const out = await runOpWithCancel('media_catalog_scan', params, {
      label: dryRun ? 'Catalog dry run' : 'Scanning catalog',
    });
    if (status) status.textContent = out?.ok === false ? 'Scan failed (see console)' : 'Scan complete';
    if (dryRun) {
      _log(`[CATALOG DRY RUN]:\n${out?.stdout || out?.command || ''}`);
    } else {
      _log(`[CATALOG]: scan finished\n${out?.stdout || ''}`);
      await refresh();
    }
  } catch (err) {
    if (status) status.textContent = `Scan failed: ${err.message}`;
    _log(`[CATALOG] scan error: ${err.message}`, 'error');
  } finally {
    btnScan?.removeAttribute('disabled');
    btnDry?.removeAttribute('disabled');
  }
}

async function loadEngineStatus() {
  const row = _el('mcEngines');
  if (!row) return;
  const res = await fetch('/api/media-catalog/status');
  if (!res.ok) { row.innerHTML = '<span class="mc-engine-pill mc-engine-missing">status unavailable</span>'; return; }
  const data = await res.json();
  if (!data.ok) { row.innerHTML = '<span class="mc-engine-pill mc-engine-missing">status unavailable</span>'; return; }
  const pills = Object.entries(data.engines_present || {}).map(([name, ok]) =>
    `<span class="mc-engine-pill ${ok ? 'mc-engine-ok' : 'mc-engine-missing'}" data-help-title="${_esc(name)}" data-help-text="${ok ? 'Installed.' : 'Not installed — the matching analysis toggle will refuse the scan.'}">${_esc(name)}</span>`);
  const counts = data.total ?? 0;
  row.innerHTML =
    `<span class="mc-count">${counts} row${counts === 1 ? '' : 's'} indexed</span>` + pills.join('');
  // Beat/MIDI toggles stay visible but disabled when their engine is absent —
  // the op refuses them anyway, so the UI says why up front. Beats/onsets are
  // Essentia (Slice 4); MIDI is the mido tempo map.
  const beats = _el('mcAnalyzeBeats');
  const midi = _el('mcAnalyzeMidi');
  if (beats) beats.disabled = !data.engines_present?.essentia;
  if (midi) midi.disabled = !data.engines_present?.mido;
}

/* ── refresh ────────────────────────────────────────────────────────── */
async function refresh() {
  try {
    pageOffset = 0;
    mcApplyOrder();
    await fetchRows();
    renderTable();
  } catch (err) {
    _log(`[CATALOG] query failed: ${err.message}`, 'error');
    const scroller = _el('mcScroll');
    if (scroller) scroller.innerHTML = `<div class="mc-empty">Query failed: ${_esc(err.message)}</div>`;
  }
}

/* ── facet wiring ───────────────────────────────────────────────────── */
function bindFacets() {
  const onChange = async (id, key, transform = (v) => v) => {
    const el = _el(id);
    if (!el) return;
    const handler = async () => {
      facets[key] = transform(el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value.trim());
      pageOffset = 0;
      await refresh();
    };
    el.addEventListener('change', handler);
    if (el.tagName === 'INPUT' && el.type === 'search') el.addEventListener('input', handler);
  };
  onChange('mcQ', 'q');
  onChange('mcType', 'type');
  onChange('mcMine', 'mine');
  onChange('mcHand', 'hand');
  onChange('mcAi', 'ai');
  onChange('mcOrigin', 'origin');
  onChange('mcSite', 'site');
  onChange('mcKey', 'key');
  onChange('mcTempoMin', 'tempoMin');
  onChange('mcTempoMax', 'tempoMax');
  onChange('mcStatusFilter', 'status');
  onChange('mcSourceFilter', 'source');
  onChange('mcDisagree', 'disagree');

  _el('mcReset')?.addEventListener('click', async () => {
    Object.keys(facets).forEach((k) => { facets[k] = ''; });
    _el('mcQ').value = '';
    _el('mcType').value = '';
    _el('mcMine').checked = false;
    _el('mcHand').checked = false;
    _el('mcAi').checked = false;
    _el('mcOrigin').value = '';
    _el('mcSite').value = '';
    _el('mcKey').value = '';
    _el('mcTempoMin').value = '';
    _el('mcTempoMax').value = '';
    _el('mcStatusFilter').value = '';
    _el('mcSourceFilter').value = '';
    _el('mcDisagree').checked = false;
    pageOffset = 0;
    await refresh();
  });
}

/* ── form render ────────────────────────────────────────────────────── */
export function renderMediaCatalogForm() {
  const keyOpts = ['<option value="">Any key</option>',
    ...KEY_OPTIONS.map((k) => `<option value="${_esc(k)}">${_esc(k)}</option>`)].join('');
  elements.actionPanel.innerHTML = `
    <div class="mc-workspace" id="mcWorkspace">
      <div class="mc-side">
        <section class="mc-scan-card">
          <div class="mc-scan-field" style="flex:1 1 100%">
            <label for="mcDir">Directory to scan</label>
            <div class="mc-dir-picker">
              <input type="text" id="mcDir" placeholder="/home/m/Music/Old Bounces"
                     data-help-title="Scan directory" data-help-text="Absolute path of the folder to index and analyze. The folder picker opens the in-app browser." />
              <button type="button" class="btn" id="btnMcPickDir" data-help-title="Browse" data-help-text="Open the in-app folder picker.">Browse…</button>
            </div>
          </div>
          <div class="mc-scan-field">
            <span class="mc-scan-label">Options</span>
            <label class="mc-toggle"><input type="checkbox" id="mcRecursive" checked /> Recursive</label>
            <label class="mc-toggle"><input type="checkbox" id="mcReanalyze" data-help-title="Force re-analysis" data-help-text="Ignore the hash fast path and re-analyze every file, even unchanged ones." /> Re-analyze</label>
            <label class="mc-toggle" data-help-title="Competing engine opinions" data-help-text="ON runs the secondary engines too (librosa + a legacy madmom venv) so several algorithms give competing tempo and beat answers — roughly 5x slower per file. OFF is Essentia only."><input type="checkbox" id="mcExtraOpinions" checked /> Extra opinions</label>
          </div>
          <div class="mc-scan-field">
            <span class="mc-scan-label">Analyze</span>
            <div class="mc-analyze-toggles">
              <label class="mc-toggle" data-help-title="Key" data-help-text="Essentia key detection. Uncheck to index without touching musical content."><input type="checkbox" id="mcAnalyzeKey" checked /> Key</label>
              <label class="mc-toggle" data-help-title="Tempo" data-help-text="Essentia BPM detection. Uncheck to index without touching musical content."><input type="checkbox" id="mcAnalyzeTempo" checked /> Tempo</label>
              <label class="mc-toggle" data-help-title="Beats (not yet)" data-help-text="Beat/downbeat grid. Needs madmom/aubio — lands with Slice 4."><input type="checkbox" id="mcAnalyzeBeats" /> Beats</label>
              <label class="mc-toggle" data-help-title="MIDI (not yet)" data-help-text="Audio to MIDI. Needs Basic Pitch — lands with Slice 4."><input type="checkbox" id="mcAnalyzeMidi" /> MIDI</label>
            </div>
          </div>
          <div class="mc-scan-field">
            <label for="mcGuard">Guard (sec)</label>
            <input type="number" id="mcGuard" value="300" min="0" max="3600" style="width:90px"
                   data-help-title="Long-file guard" data-help-text="Analyze only the first N seconds of each file. 0 = whole file. Keeps hour-long DJ mixes tractable." />
          </div>
          <div class="mc-scan-field">
            <span class="mc-scan-label">&nbsp;</span>
            <div class="mc-scan-actions">
              <button type="button" class="btn" id="btnMcScan" data-help-title="Scan" data-help-text="Index every media file in the directory, then run the enabled analyses.">Scan</button>
              <button type="button" class="btn" id="btnMcDry" data-help-title="Dry run" data-help-text="List what would be scanned and analyzed without writing anything.">Dry Run</button>
            </div>
          </div>
          <div class="mc-engine-row" id="mcEngines"></div>
        </section>

        <section class="mc-facets">
          <div class="mc-facet-group">
            <span class="mc-facet-title">Search</span>
            <input type="search" id="mcQ" placeholder="path or author" data-help-title="Search" data-help-text="Substring match on the file path or the recorded author/channel." />
          </div>
          <div class="mc-facet-group">
            <span class="mc-facet-title">Type</span>
            <select id="mcType" data-help-title="Media type" data-help-text="Restrict to audio, video, or image rows.">
              <option value="">Any type</option>
              <option value="audio">Audio</option>
              <option value="video">Video</option>
              <option value="image">Image</option>
            </select>
          </div>
          <div class="mc-facet-group">
            <span class="mc-facet-title">Provenance</span>
            <label class="mc-toggle"><input type="checkbox" id="mcMine" data-help-title="Mine only" data-help-text="Only rows marked as yours." /> ✦ Mine only</label>
            <label class="mc-toggle"><input type="checkbox" id="mcHand" data-help-title="Made by me" data-help-text="Only rows you authored by hand." /> HAND (made by me)</label>
            <label class="mc-toggle"><input type="checkbox" id="mcAi" data-help-title="AI involved" data-help-text="Only rows AI you ran touched." /> AI involved</label>
            <select id="mcOrigin" data-help-title="How it entered" data-help-text="generated = this app wrote it, web = downloaded, import = picked from disk.">
              <option value="">Any origin</option>
              <option value="generated">Generated here</option>
              <option value="web">Web / download</option>
              <option value="import">Imported</option>
            </select>
          </div>
          <div class="mc-facet-group">
            <span class="mc-facet-title">Musical</span>
            <select id="mcKey" data-help-title="Key" data-help-text="Filter by detected musical key (canonical 'C major' form).">${keyOpts}</select>
            <div class="mc-tempo-row">
              <input type="number" id="mcTempoMin" placeholder="min" step="0.1" data-help-title="Tempo min" data-help-text="Lower BPM bound of the tempo filter." />
              <span class="mc-tempo-sep">–</span>
              <input type="number" id="mcTempoMax" placeholder="max" step="0.1" data-help-title="Tempo max" data-help-text="Upper BPM bound of the tempo filter." />
            </div>
          </div>
          <div class="mc-facet-group">
            <span class="mc-facet-title">Site &amp; status</span>
            <input type="text" id="mcSite" placeholder="site (e.g. youtube)" data-help-title="Site" data-help-text="Filter by the platform a download came from." />
            <select id="mcSourceFilter" data-help-title="Source of truth" data-help-text="Only rows currently using a tagged value or a detected value as their authoritative tempo or key.">
              <option value="">Any source</option>
              <option value="tagged">Using my tag</option>
              <option value="detected">Using detection</option>
            </select>
            <label class="mc-toggle" data-help-title="Disagreements only" data-help-text="Only rows where the tagged and detected tempos differ by more than 1.5 BPM \u2014 the files worth checking."><input type="checkbox" id="mcDisagree" /> Tag/detect disagree</label>
            <select id="mcStatusFilter" data-help-title="Row status" data-help-text="error rows failed analysis; missing rows point at files that no longer exist on disk.">
              <option value="">Any status</option>
              <option value="analyzed">Analyzed</option>
              <option value="scanned">Scanned</option>
              <option value="pending">Pending</option>
              <option value="error">Error</option>
              <option value="missing">Missing</option>
            </select>
          </div>
          <button type="button" class="btn btn-sm mc-facet-reset" id="mcReset" data-help-title="Clear filters" data-help-text="Reset every facet back to Any and re-query.">Clear filters</button>
        </section>
      </div>

      <div class="mc-table-wrap">
        <div class="mc-table-head">
          <span class="mc-count" id="mcCount">…</span>
          <span class="mc-status-line" id="mcStatus"></span>
        </div>
        <div class="mc-scroll" id="mcScroll"></div>
        <div id="mcAudioHolder"></div>
      </div>
    </div>`;

  bindFacets();
  _el('btnMcPickDir')?.addEventListener('click', () => pickDirectory().catch(() => {}));
  _el('btnMcScan')?.addEventListener('click', () => runScan(false));
  _el('btnMcDry')?.addEventListener('click', () => runScan(true));
  _el('mcScroll')?.addEventListener('scroll', _onScroll, { passive: true });

  _el('mcScroll')?.addEventListener('click', async (e) => {
    // Every action attribute carries the full path, so read it from the
    // clicked control — never from the row (that is the directory in some
    // layouts and would put a folder into the Media In box).
    const play = e.target.closest('[data-mc-play]');
    if (play?.dataset.mcPlay) { togglePlay(play.dataset.mcPlay); return; }
    const send = e.target.closest('[data-mc-send]');
    if (send?.dataset.mcSend) { sendToMediaIn(send.dataset.mcSend); return; }
    const prov = e.target.closest('[data-mc-provenance]');
    if (prov?.dataset.mcProvenance) { openProvenanceEditor(prov.dataset.mcProvenance); return; }
    const srcBtn = e.target.closest('[data-mc-source]');
    if (srcBtn) { await switchSource(srcBtn); }
  });

  loadEngineStatus();
  refresh();
}

export { refresh as refreshMediaCatalog };