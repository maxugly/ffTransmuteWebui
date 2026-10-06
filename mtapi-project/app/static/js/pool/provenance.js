/** Pool provenance editor + badges (spec §11, §6.6).
 *
 * The pool carries provenance on `item.source_meta` (is_mine, made_by_me,
 * ai_involved, origin); the Media Catalog database is the durable store. Every
 * write goes through the server so the rule (write-time invariant, manual
 * precedence, audit log) lives in exactly one place, then mirrors the returned
 * row back onto the pool item so badges and filters never lag the database.
 */
import { state } from '/app.js?v=2';
import { basename, escapeHtml } from '/js/utils.js';

function _log(msg, kind) {
  try {
    const fn = window.__mtapiLog || null;
    if (fn) fn(msg, kind);
  } catch (_) { /* ignore */ }
  try {
    import('/app.js?v=2').then((m) => m.logConsole(msg, kind)).catch(() => {});
  } catch (_) { /* ignore */ }
}

/** Every pool item that carries `path`, across video + image pools. */
function findAnyPoolItem(path) {
  const video = (state?.pool?.items || []).find((i) => i && i.path === path);
  if (video) return video;
  const images = (state?.imagePool?.items || window.state?.imagePool?.items || []);
  return images.find((i) => i && i.path === path) || null;
}

/** Mirror the catalog row's provenance onto the live pool item. */
function applyProvenanceToItem(item, row) {
  if (!item || !row) return;
  item.source_meta = item.source_meta || {};
  item.source_meta.origin = row.origin || item.source_meta.origin || null;
  item.source_meta.is_mine = !!row.is_mine;
  item.source_meta.made_by_me = !!row.made_by_me;
  item.source_meta.ai_involved = !!row.ai_involved;
  // Analysis results ride along so the key:/bpm: pool tokens and the key·tempo
  // chip have something to match for files a scan has already analysed.
  if (row.key_name) item.source_meta.key_name = row.key_name;
  if (row.tempo != null) item.source_meta.tempo = row.tempo;
  if (row.tempo_conf != null) item.source_meta.tempo_conf = row.tempo_conf;
}

/**
 * Write provenance for one item.
 * `bits` uses null for "leave alone"; booleans to set. Omitted bits are
 * resolved from the item's current state before the call.
 */
async function setProvenance(path, bits = {}, { batchId = null } = {}) {
  if (!path) return { ok: false };
  const item = findAnyPoolItem(path);
  const sm = item?.source_meta || {};
  const body = {
    path,
    is_mine: bits.is_mine != null ? !!bits.is_mine : !!sm.is_mine,
    made_by_me: bits.made_by_me != null ? !!bits.made_by_me : !!sm.made_by_me,
    ai_involved: bits.ai_involved != null ? !!bits.ai_involved : !!sm.ai_involved,
  };
  if (batchId) body.batch_id = batchId;
  try {
    const res = await fetch('/api/media-catalog/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'mark failed');
    applyProvenanceToItem(item, data.row);
    try { window.globalMediaIndex?.put(item); } catch (_) { /* ignore */ }
    try { window.scheduleSavePoolState?.(); } catch (_) { /* ignore */ }
    window.dispatchEvent(new CustomEvent('mtapi.provenanceChanged', { detail: { path, row: data.row } }));
    _log(`[CATALOG]: ${basename(path)} — ✦${data.row?.is_mine ? ' mine' : ''}${data.row?.made_by_me ? ' HAND' : ''}${data.row?.ai_involved ? ' AI' : ''}`);
    return { ok: true, row: data.row, batchId: data.batch_id };
  } catch (err) {
    _log(`[CATALOG] provenance write failed: ${err.message}`, 'error');
    return { ok: false, error: err.message };
  }
}

/** Clear all three bits — guarded by a confirm (spec §6.6). */
async function clearProvenance(path) {
  const name = basename(path);
  if (!window.confirm(`Clear mine + Made-by-me + AI-involved on "${name}"?\n\nUndo is available afterwards from the Media Catalog.`)) {
    return { ok: false, cancelled: true };
  }
  return setProvenance(path, { is_mine: false, made_by_me: false, ai_involved: false });
}

async function undoLastProvenance(path) {
  try {
    const res = await fetch(`/api/media-catalog/history?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'history failed');
    const rows = data.rows || [];
    if (!rows.length) {
      _log('[CATALOG]: nothing to undo for this item');
      return { ok: false, error: 'no provenance history' };
    }
    const latest = rows[0];
    const undo = await fetch('/api/media-catalog/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch_id: latest.batch_id }),
    });
    if (!undo.ok) throw new Error(await undo.text());
    const undone = await undo.json();
    if (!undone.ok) throw new Error(undone.error || 'undo failed');
    const item = findAnyPoolItem(path);
    const row = await fetchCatalogRow(path);
    applyProvenanceToItem(item, row);
    try { window.globalMediaIndex?.put(item); } catch (_) { /* ignore */ }
    try { window.scheduleSavePoolState?.(); } catch (_) { /* ignore */ }
    window.dispatchEvent(new CustomEvent('mtapi.provenanceChanged', { detail: { path, row } }));
    _log(`[CATALOG]: undone provenance for ${basename(path)} (${undone.restored} item(s))`);
    return { ok: true, restored: undone.restored };
  } catch (err) {
    _log(`[CATALOG] undo failed: ${err.message}`, 'error');
    return { ok: false, error: err.message };
  }
}

async function fetchCatalogRow(path) {
  try {
    const res = await fetch(`/api/media-catalog/query?limit=1&q=${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const row = (data.rows || []).find((r) => r.path === path);
    return row || null;
  } catch (_) {
    return null;
  }
}

/** Badge HTML for a pool card meta block (spec §11.4). */
function provenanceBadgesHtml(item) {
  const sm = item?.source_meta || {};
  const bits = [];
  if (sm.is_mine) bits.push('<span class="pool-badge-mine" data-help-title="Mine" data-help-text="Marked as yours. Set by an owned-directory rule, this app\'s generators, or your own toggle.">✦ mine</span>');
  if (sm.made_by_me) bits.push('<span class="pool-badge-hand" data-help-title="Made by me" data-help-text="You authored this by hand — drew it, recorded it, composed it.">HAND</span>');
  if (sm.ai_involved) bits.push('<span class="pool-badge-ai" data-help-title="AI involved" data-help-text="AI you ran generated or processed some part of this file.">AI</span>');
  if (sm.origin === 'generated') bits.push('<span class="pool-badge-gen" data-help-title="Generated here" data-help-text="Produced by this app.">GEN</span>');
  if (!bits.length && !(sm.key_name || sm.tempo != null)) return '';
  const musical = [];
  if (sm.key_name) musical.push(escapeHtml(sm.key_name));
  if (sm.tempo != null) musical.push(`${Number(sm.tempo).toFixed(1)} BPM`);
  if (musical.length) {
    bits.push(`<span class="pool-badge-musical" data-help-title="Analysis" data-help-text="Key and tempo extracted by the Media Catalog scan (Essentia). Filter with key:c major or bpm:90-120.">${musical.join(' · ')}</span>`);
  }
  if (!bits.length) return '';
  return `<div class="pool-provenance-badges">${bits.join('')}</div>`;
}

export {
  findAnyPoolItem,
  applyProvenanceToItem,
  setProvenance,
  clearProvenance,
  undoLastProvenance,
  fetchCatalogRow,
  provenanceBadgesHtml,
};