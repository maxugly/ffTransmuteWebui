/** Auto-add op outputs: success-only, never breaks preview/render. */
import { state } from '/app.js?v=2';
import { isVideoPath, isImagePath } from '/js/utils.js';

function _log(msg, kind) {
  try {
    const fn = window.__mtapiLog || null;
    if (fn) fn(msg, kind);
  } catch (_) { /* ignore */ }
  try {
    import('/app.js?v=2').then((m) => m.logConsole(msg, kind)).catch(() => {});
  } catch (_) { /* ignore */ }
}


/** Extensions this app treats as catalogable media (audio included: Music and
 *  Stems outputs are .wav even though audio never enters a pool). */
const CATALOG_AUDIO_EXTS = ['.wav', '.mp3', '.aif', '.aiff', '.flac', '.m4a', '.ogg', '.opus'];

function isCatalogableMedia(path) {
  if (!path || typeof path !== 'string') return false;
  const lower = path.toLowerCase();
  if (CATALOG_AUDIO_EXTS.some((ext) => lower.endsWith(ext))) return true;
  if (isVideoPath(path) || isImagePath(path)) return true;
  return false;
}

/** Stamp an op-generated output in the Media Catalog (spec §5 path 3).
 *  Server owns the provenance rule: is_mine=1, ai_involved=1,
 *  mine_source='generated'. Fire-and-forget; throws nothing. */
function markGeneratedInCatalog(path, operation, meta) {
  // Only real media: an op whose output_path is a directory (the catalog scan
  // returns its target dir) must not be recorded as a generated *file*.
  if (!isCatalogableMedia(path)) return;
  const settings = window.state?.settings || state?.settings || {};
  if (settings.catalogAutoIndex === false) return;
  const payload = { path, generated_by: operation || null };
  if (meta && typeof meta === 'object') {
    const interesting = {};
    for (const key of ['model', 'engine', 'prompt', 'seed']) {
      if (meta[key] != null) interesting[key] = meta[key];
    }
    if (Object.keys(interesting).length) payload.meta = interesting;
  }
  fetch('/api/media-catalog/generated', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'generated stamp failed');
      _log(`[CATALOG]: generated ✦ AI — ${operation || 'op'} → ${path.split('/').pop()}`);
    })
    .catch((err) => _log(`[CATALOG] generated stamp skipped: ${err.message}`, 'error'));
}

/**
 * Add a finished op output to the right pool (and optionally the Sequence).
 * Video outputs need the master switch; image outputs need master + image switch.
 * Sequence appends are video-only + deduped (see sequence-composer).
 * Fire-and-forget safe: throws nothing.
 *
 * 2026-09-14 — RIFE variant outputs (autorife / Instant RIFE) are NOT pool
 * items: `rife_ops.register_rifed_output` registers the file as a `rifed`
 * variant on the source clip (and on the ultimate parent for dnxhr proxies).
 * The sequence entry then auto-switches via `variantPath`/`_variantHash` and
 * its dropdown (see `sequence-rife.js`). Auto-adding a duplicate Pool/Sequence
 * entry broke that flow after 8.019 (`maybeAutoAddOpOutput` wired into
 * `displayOpResult`). We now skip any `rife` result that carries
 * `meta.variant_hash` — plain single-clip RIFE (no variant) still auto-adds
 * when the toggles are on. Keep this guard if you touch auto-add again.
 */
export function maybeAutoAddOpOutput(outputPath, opts = {}) {
  if (!outputPath || typeof outputPath !== 'string') return;
  const path = outputPath.trim();
  if (!path) return;
  // Autorife / variant RIFE: stays on the original's dropdown, not a new card.
  // Detect via explicit opts from displayOpResult (operation + meta.variant_hash).
  // This is the autorife path (register_as_variant=true → meta.variant_hash).
  const opId = opts && typeof opts.operation === 'string' ? opts.operation : null;
  const meta = opts && opts.meta && typeof opts.meta === 'object' ? opts.meta : null;
  if (opId === 'rife' && meta && meta.variant_hash) return;

  // Media Catalog (spec §5 path 3): anything this app generated is the user's
  // output. Runs BEFORE the autoAddOpOutputs gate so rows exist even when
  // auto-add is off. The AI half is asserted here; "made by me" stays the
  // user's call (cover mode starts from their own audio). Never throws.
  try {
    markGeneratedInCatalog(path, opId, meta);
  } catch (_) { /* catalog indexing must not break results */ }

  // Belt-and-suspenders: if caller passed only a path but it is clearly a
  // variant hash-bearing result, the displayOpResult guard already skipped;
  // no heuristic path check here — variant identity lives in meta, not filename.
  const settings = state?.settings || window.state?.settings || {};
  if (!settings.autoAddOpOutputs) return;
  try {
    if (isVideoPath(path)) {
      import('/js/pool/items.js').then(async (m) => {
        try {
          const before = (state?.pool?.items || []).length;
          await m.addPathsToPool([path]);
          const after = (state?.pool?.items || []).length;
          _log(`[AUTO-ADD]: pool ${after > before ? '+' : '(dup)'} ${path}`);
        } catch (_) { /* pool render must not break results */ }
        if (settings.autoAddOpOutputsToSequence) {
          import('/js/pool/sequence-composer.js?v=2').then((s) => {
            try { s.addPathsToSequence([path]); } catch (_) { /* ignore */ }
          }).catch(() => {});
        }
      }).catch(() => {});
    } else if (isImagePath(path)) {
      if (!settings.autoAddOpImageOutputs) return;
      import('/js/pool/image-pool.js').then((m) => {
        try {
          m.addPathsToImagePool([path]);
          _log(`[AUTO-ADD]: image pool + ${path}`);
        } catch (_) { /* ignore */ }
      }).catch(() => {});
    }
    // Non-media outputs (json, logs, dirs): silently ignored.
  } catch (_) { /* auto-add must not break results */ }
}
