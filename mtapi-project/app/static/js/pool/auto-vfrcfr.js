/** Import-time VFR healing. Detection is opt-in and event-driven. */
import { state } from '/app.js';
import { isVideoPath } from '/js/utils.js';
import { runOpWithCancel } from '/js/job-control.js';

const _results = new Map();

function enabled() { return !!state?.settings?.autoVfrToCfr; }
function fps() {
  const n = Number(state?.settings?.vfrCfrFps || 0);
  return Number.isFinite(n) && n > 0 ? Math.min(240, Math.max(1, Math.round(n))) : null;
}
function log(msg, kind) {
  try { import('/app.js').then(m => m.logConsole(msg, kind)).catch(() => {}); } catch (_) { /* best effort */ }
}

async function normalizeOne(path) {
  if (!path || !isVideoPath(path) || !enabled()) return path;
  if (_results.has(path)) return _results.get(path);
  try {
    // Use the dedicated VFR scan route. The legacy /api/probe response does
    // not expose is_vfr_guess, so it cannot drive this decision.
    const probe = await fetch('/api/vfr_scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [path] }),
    });
    if (!probe.ok) { _results.set(path, path); return path; }
    const scan = await probe.json();
    const info = (scan.vfr || [])[0];
    if (!scan.ok || !info?.is_vfr_guess) { _results.set(path, path); return path; }
    log(`[AUTO CFR]: VFR detected → ${path}`);
    const result = await runOpWithCancel('cfr', {
      input_path: path,
      target_fps: fps(),
      use_rife: false,
      dry_run: false,
    }, { label: `CFR normalize · ${path.split('/').pop()}` });
    if (result?.ok && result.output_path) {
      log(`[AUTO CFR]: normalized → ${result.output_path}`);
      _results.set(path, result.output_path);
      return result.output_path;
    }
    log(`[AUTO CFR]: kept original after failure → ${path}`, 'error');
  } catch (err) {
    log(`[AUTO CFR]: kept original after error → ${path} — ${err.message}`, 'error');
  }
  _results.set(path, path);
  return path;
}

async function normalizeImportsForPool(paths) {
  if (!enabled()) return (paths || []).filter(Boolean);
  const out = [];
  for (const path of paths || []) out.push(await normalizeOne(path));
  return out;
}

function maybeAutoVfrCfrForImport(paths) {
  normalizeImportsForPool(paths).catch(() => {});
}

async function batchNormalizePool() {
  const paths = (state?.pool?.items || []).map(it => typeof it === 'string' ? it : it.path).filter(Boolean);
  if (!paths.length) { log('[AUTO CFR]: pool is empty — nothing to process'); return { done: 0, skipped: 0 }; }
  const previous = state.settings.autoVfrToCfr;
  state.settings.autoVfrToCfr = true;
  let changed = 0;
  try {
    for (const path of paths) {
      const normalized = await normalizeOne(path);
      if (normalized !== path) {
        const { addPathsToPool } = await import('/js/pool/items.js');
        const old = state.pool.items.find(it => it.path === path);
        if (old) { state.pool.items = state.pool.items.filter(it => it.path !== path); }
        await addPathsToPool([normalized]);
        changed += 1;
      }
    }
  } finally { state.settings.autoVfrToCfr = previous; }
  log(`[AUTO CFR]: batch done — ${changed} normalized`);
  return { done: changed, skipped: paths.length - changed };
}

async function scanCurrentMedia() {
  const paths = [...new Set([
    ...(state?.pool?.items || []).map(it => typeof it === 'string' ? it : it.path),
    ...(state?.pool?.sequence || []).map(it => it.path),
  ].filter(Boolean))];
  if (!paths.length) { log('[VFR SCAN]: pool and sequence are empty'); return { vfr: [], cfr: [], failed: [] }; }
  log(`[VFR SCAN]: checking ${paths.length} clip(s)…`);
  const res = await fetch('/api/vfr_scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) throw new Error(`scan HTTP ${res.status}`);
  const data = await res.json();
  const vfr = data.vfr || [];
  const cfr = data.cfr || [];
  const failed = data.failed || [];
  log(`[VFR SCAN]: ${vfr.length} VFR, ${cfr.length} CFR, ${failed.length} failed`);
  for (const row of vfr) log(`[VFR]: ${row.path} (${row.fps_avg} avg vs ${row.fps_r} nominal)`);
  for (const row of failed) log(`[VFR SCAN ERROR]: ${row.path} — ${row.error}`, 'error');
  return data;
}

async function batchNormalizeSequence() {
  const entries = state?.pool?.sequence || [];
  if (!entries.length) { log('[AUTO CFR]: sequence is empty — nothing to process'); return { done: 0, skipped: 0 }; }
  const previous = state.settings.autoVfrToCfr;
  state.settings.autoVfrToCfr = true;
  let changed = 0;
  log(`[AUTO CFR]: checking ${entries.length} sequence clip(s)…`);
  try {
    for (const entry of entries) {
      const oldPath = entry?.path;
      if (!oldPath) continue;
      const normalized = await normalizeOne(oldPath);
      if (normalized === oldPath) continue;
      entry.path = normalized;
      entry.name = normalized.split('/').pop();
      if (entry.variantPath === oldPath) entry.variantPath = normalized;
      const item = (state.pool.items || []).find(it => it.path === oldPath);
      if (item) { item.path = normalized; item.name = entry.name; }
      changed += 1;
      // This is an existing Sequence entry, not a new addPathsToSequence
      // event. Re-run the normal armed RIFE handoff so CFR replacement does
      // not strand the entry before Instant RIFE/conform.
      try {
        const rife = await import('/js/pool/sequence-rife.js');
        rife._maybeAutoRifeEntry(entry);
      } catch (_) { /* the CFR replacement remains valid if RIFE is unavailable */ }
      try {
        const conform = await import('/js/pool/sequence-conform.js');
        conform.maybeAutoConformEntry(entry);
      } catch (_) { /* conform follows the existing feature gate */ }
    }
  } finally { state.settings.autoVfrToCfr = previous; }
  try {
    const p = await import('/js/pool/persistence.js');
    p.scheduleSavePoolState();
    const s = await import('/js/pool/sequence.js');
    s.renderSequenceBox({ skipInstantKick: true });
  } catch (_) { /* state is still updated */ }
  log(`[AUTO CFR]: sequence done — ${changed} normalized`);
  return { done: changed, skipped: entries.length - changed };
}

export { enabled as autoVfrCfrEnabled, normalizeImportsForPool, maybeAutoVfrCfrForImport, scanCurrentMedia, batchNormalizePool, batchNormalizeSequence };
