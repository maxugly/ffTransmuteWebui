/** Auto-add op outputs: success-only, never breaks preview/render. */
import { state } from '/app.js';
import { isVideoPath, isImagePath } from '/js/utils.js';

function _log(msg, kind) {
  try {
    const fn = window.__mtapiLog || null;
    if (fn) fn(msg, kind);
  } catch (_) { /* ignore */ }
  try {
    import('/app.js').then((m) => m.logConsole(msg, kind)).catch(() => {});
  } catch (_) { /* ignore */ }
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
          import('/js/pool/sequence-composer.js').then((s) => {
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
