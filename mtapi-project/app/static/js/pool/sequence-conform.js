// Sequence Conform state + badges + stitch prediction (vanilla ES6).
// Spec: docs/sequence-conform-copy-spec.md. Conform is Video Sequence-only,
// cache-fill beside the source, never a replacement for path/variantPath.
import { state, logConsole } from '/app.js';
import { basename } from '/js/utils.js';
import { peekVariants } from '/js/pool/sequence-variants.js';
import { isInstantArmed, armInstantRife } from '/js/pool/sequence-rife.js';

export const CONFORM_PRESETS = ['h264_avc_hq', 'h265_hevc', 'dnxhr_hq', 'prores_hq'];
export const CONFORM_DEFAULT = 'h264_avc_hq';

export function isConformEnabled() {
  return !!state.pool.conformEnabled;
}

export function conformSettings() {
  return {
    enabled: !!state.pool.conformEnabled,
    mode: state.pool.conformMode || state.pool.reconcile || 'pad',
    preset: state.pool.conformPreset || CONFORM_DEFAULT,
    targetFps: state.pool.conformTargetFps || null,
    autoAfterRife: state.pool.autoConformAfterRife !== false,
  };
}

/** Conform badge per entry: valid (OK) / stale / pending. Never a RIFE badge. */
export function conformBadgeForEntry(entry) {
  if (!isConformEnabled()) return null;
  if (entry.conformStatus === 'pending' || entry.conformStatus === 'running') {
    return {
      text: 'CONF…',
      cls: 'seq-conform-badge is-pending',
      title: 'STATE: conform pending — cache-fill running for this clip.',
    };
  }
  if (entry.conformStatus === 'stale' || entry.conformStatus === 'invalid') {
    return {
      text: 'CONF!',
      cls: 'seq-conform-badge is-stale',
      title: [
        'STATE: conform stale — mode/aspect/canvas/fps/duration/preset changed.',
        'Stitch will regenerate it first (or fall back to re-encode).',
      ].join('\n'),
    };
  }
  if (entry.conformedPath) {
    return {
      text: 'CONF',
      cls: 'seq-conform-badge is-done',
      title: [
        'STATE: conformed sibling ready (cache, not a replacement).',
        `Conformed: ${basename(entry.conformedPath)}`,
        `Source: ${basename(entry.path)}`,
        'Stitch may use the concat-copy fast path when every clip is CONF.',
      ].join('\n'),
    };
  }
  return {
    text: 'CONF?',
    cls: 'seq-conform-badge is-hint',
    title: 'STATE: no conformed sibling yet — Stitch will generate it first.',
  };
}

/** Stitch button prediction (backend authoritative; never blocks fallback). */
export function stitchPrediction() {
  if (!isConformEnabled()) return { label: 'Stitch Sequence', mode: 'plain' };
  const seq = state.pool.sequence || [];
  if (seq.length < 2) return { label: 'Stitch Sequence', mode: 'plain' };
  if (seq.some((e) => e.conformStatus === 'pending' || e.conformStatus === 'running')) {
    return { label: 'Conforming…', mode: 'working' };
  }
  const allOk = seq.length > 0 && seq.every((e) => e.conformedPath && e.conformStatus !== 'stale' && e.conformStatus !== 'invalid');
  if (allOk) return { label: 'Stitch (copy)', mode: 'copy' };
  return { label: 'Stitch (re-encode)', mode: 'reencode' };
}

export function updateStitchButton() {
  const btn = document.getElementById('btnPoolStitch');
  if (!btn) return;
  const pred = stitchPrediction();
  // Keep the play icon; swap only the text node after it.
  const svg = btn.querySelector('svg');
  const label = pred.label;
  btn.dataset.conformMode = pred.mode;
  if (svg) {
    const next = svg.nextSibling;
    const text = ` ${label}`;
    if (next && next.nodeType === 3) next.textContent = text;
    else btn.append(document.createTextNode(text));
    // Remove any stale extra text nodes beyond the first.
    let n = svg.nextSibling?.nextSibling;
    while (n) {
      const rm = n;
      n = n.nextSibling;
      rm.remove();
    }
  } else {
    btn.textContent = label;
  }
  btn.setAttribute('data-help-title', pred.mode === 'copy'
    ? 'Every clip has a valid conformed sibling — Stitch will try the concat-copy fast path (falls back to re-encode if the gate fails).'
    : pred.mode === 'reencode'
      ? 'Conform is on but some clips lack a valid conform — Stitch regenerates them first, else re-encodes.'
      : pred.mode === 'working'
        ? 'Conform cache-fill running…'
        : 'Stitch clips end-to-end');
}

/** Mark entries stale when conform inputs change (mode/aspect/fps/duration). */
export function invalidateConforms(reason) {
  let n = 0;
  for (const e of state.pool.sequence || []) {
    if (e.conformedPath && e.conformStatus !== 'pending' && e.conformStatus !== 'running') {
      e.conformStatus = 'stale';
      n += 1;
    }
  }
  if (n) {
    try { logConsole(`[CONFORM]: ${n} cached conform(s) stale — ${reason}`); } catch (_) {}
  }
  updateStitchButton();
  return n;
}

/**
 * Auto-conform hook sharing AutoRIFE's armed gate: no scan on open/restore,
 * only after an explicit arming gesture. Called after a completed RIFE item
 * and on new-clip add when Conform is enabled.
 */
export function maybeAutoConformEntry(entry) {
  if (!isConformEnabled()) return false;
  if (!conformSettings().autoAfterRife) return false;
  if (!isInstantArmed()) return false;
  if (!entry || entry.conformStatus === 'pending' || entry.conformStatus === 'running') return false;
  if (entry.conformedPath && entry.conformStatus !== 'stale' && entry.conformStatus !== 'invalid') return false;
  entry.conformStatus = 'pending';
  try {
    import('/js/pool/sequence-composer.js').then((m) => {
      try { m.renderSequenceBox({ skipInstantKick: true }); } catch (_) {}
    }).catch(() => {});
  } catch (_) {}
  updateStitchButton();
  return true;
}

export function noteConformDone(entry, conformedPath, signature) {
  if (!entry) return;
  entry.conformedPath = conformedPath || entry.conformedPath;
  entry.conformSignature = signature || entry.conformSignature || null;
  entry.conformStatus = 'valid';
  updateStitchButton();
}
