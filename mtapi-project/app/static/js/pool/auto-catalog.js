/** Media Catalog auto-index: pool imports become catalog rows (spec §5 path 4).
 *
 * Delta-only, event-driven, fire-and-forget. Never scans on load/restore/render,
 * never blocks an import, and never throws into the caller — the same shape as
 * `auto-firstlast.js`. The server owns provenance resolution (owned-dir rules,
 * origin='import'), so this module only ships the new paths.
 */
import { state } from '/app.js?v=2';

const _done = new Set(); // paths already offered to the catalog this session

function catalogEnabled() {
  return !!window.state?.settings?.catalogAutoIndex;
}

function _log(msg, kind) {
  try {
    const fn = window.__mtapiLog || null;
    if (fn) fn(msg, kind);
  } catch (_) { /* ignore */ }
  try {
    import('/app.js?v=2').then((m) => m.logConsole(msg, kind)).catch(() => {});
  } catch (_) { /* ignore */ }
}

async function catalogIngest(paths) {
  const fresh = [];
  for (const p of paths || []) {
    if (!p || typeof p !== 'string') continue;
    const path = p.trim();
    if (!path || _done.has(path)) continue;
    _done.add(path);
    fresh.push(path);
  }
  if (!fresh.length) return { ok: true, sent: 0 };

  try {
    const res = await fetch('/api/media-catalog/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: fresh }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'ingest failed');
    // Mirror provenance onto the pool items so badges match the database
    // immediately (owned-dir rules decide ✦ mine server-side).
    try {
      const prov = await import('/js/pool/provenance.js');
      for (const row of data.rows || []) {
        prov.applyProvenanceToItem(prov.findAnyPoolItem(row.path), row);
      }
      try { window.scheduleSavePoolState?.(); } catch (_) { /* ignore */ }
    } catch (_) { /* badges are chrome */ }
    _log(`[CATALOG]: indexed ${data.upserted} new file(s)${data.skipped ? `, ${data.skipped} skipped` : ''}`);
    return { ok: true, sent: fresh.length };
  } catch (err) {
    // Catalog is an index, never a gate on import.
    _log(`[CATALOG] ingest failed (import unaffected): ${err.message}`, 'error');
    return { ok: false, error: err.message };
  }
}

function maybeAutoCatalogForImport(paths) {
  if (!catalogEnabled()) return;
  catalogIngest(paths).catch(() => {});
}

export { catalogEnabled, catalogIngest, maybeAutoCatalogForImport };