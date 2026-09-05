/** Auto first/last: event-delta only. Never scans on load/restore/render. */
import { state } from '/app.js';

const _done = new Set(); // `${path}::${which}` verified ok this session

function autoFLEnabled() {
  return !!window.state?.settings?.autoFirstLast && !!state?.settings?.autoFirstLast;
}

function autoFLMode() {
  const m = state?.settings?.autoFirstLastMode || window.state?.settings?.autoFirstLastMode;
  return m === 'sequence' ? 'sequence' : 'import';
}

function _log(msg, kind) {
  try {
    const fn = window.__mtapiLog || null;
    if (fn) fn(msg, kind);
  } catch (_) { /* ignore */ }
  try {
    import('/app.js').then((m) => m.logConsole(msg, kind)).catch(() => {});
  } catch (_) { /* ignore */ }
}

async function _exportOne(path, which) {
  const key = `${path}::${which}`;
  if (_done.has(key)) return { ok: true, skipped: true };
  const res = await fetch('/api/export_frame', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, which, skip_if_exists: true }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'export failed');
  _done.add(key);
  return data;
}

async function extractFirstLast(path) {
  if (!path) return { ok: false };
  let made = 0;
  let skipped = 0;
  for (const which of ['first', 'last']) {
    try {
      const r = await _exportOne(path, which);
      if (r.skipped) skipped += 1;
      else {
        made += 1;
        _log(`[AUTO F/L]: ${which} → ${r.output_path}`);
      }
    } catch (err) {
      _log(`[AUTO F/L ERROR]: ${which} ${path} — ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  }
  if (skipped === 2) _log(`[AUTO F/L]: skipped (exists) → ${path}`);
  return { ok: true, made, skipped };
}

function maybeAutoFLForImport(paths) {
  if (!autoFLEnabled() || autoFLMode() !== 'import') return;
  for (const p of paths || []) {
    if (!p) continue;
    extractFirstLast(p).catch(() => {});
  }
}

function maybeAutoFLForSequence(paths) {
  if (!autoFLEnabled() || autoFLMode() !== 'sequence') return;
  for (const p of paths || []) {
    if (!p) continue;
    extractFirstLast(p).catch(() => {});
  }
}

async function batchAutoFirstLast() {
  const items = (window.state?.pool?.items || state?.pool?.items || []);
  if (!items.length) {
    _log('[AUTO F/L]: pool is empty — nothing to process');
    return { done: 0, skipped: 0 };
  }
  let done = 0;
  let skipped = 0;
  let failed = 0;
  _log(`[AUTO F/L]: batch ${items.length} clip(s)…`);
  for (const it of items) {
    const path = typeof it === 'string' ? it : it.path;
    if (!path) continue;
    const r = await extractFirstLast(path);
    if (r.ok) {
      done += 1;
      skipped += (r.skipped === 2 ? 1 : 0);
    } else {
      failed += 1;
    }
  }
  _log(`[AUTO F/L]: batch done — ${done} ok, ${skipped} already existed, ${failed} failed`);
  return { done, skipped, failed };
}

export { autoFLEnabled, autoFLMode, extractFirstLast, maybeAutoFLForImport, maybeAutoFLForSequence, batchAutoFirstLast };
