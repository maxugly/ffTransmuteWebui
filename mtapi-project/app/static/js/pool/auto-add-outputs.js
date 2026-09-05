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
 */
export function maybeAutoAddOpOutput(outputPath) {
  if (!outputPath || typeof outputPath !== 'string') return;
  const path = outputPath.trim();
  if (!path) return;
  const settings = state?.settings || window.state?.settings || {};
  if (!settings.autoAddOpOutputs) return;
  try {
    if (isVideoPath(path)) {
      import('/js/pool/items.js').then((m) => {
        try {
          const before = (state?.pool?.items || []).length;
          m.addPathsToPool([path]);
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
