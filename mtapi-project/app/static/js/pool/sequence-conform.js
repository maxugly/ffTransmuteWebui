// Sequence Conform state + badges + stitch prediction (vanilla ES6).
// Spec: docs/sequence-conform-copy-spec.md. Conform is Video Sequence-only,
// cache-fill beside the source, never a replacement for path/variantPath.
import { state, logConsole } from '/app.js?v=4';
import { basename } from '/js/utils.js';
import { peekVariants } from '/js/pool/sequence-variants.js';
import { isInstantArmed, armInstantRife } from '/js/pool/sequence-rife.js';
import { resolveRange, rangeLabel, rangeClipCount } from '/js/pool/sequence-range.js';

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

/**
 * Stitch button prediction (backend authoritative; never blocks fallback).
 * Scoped to the render range (clip N → M) when one is set — the conform
 * cache state of clips outside the window must not change the label.
 */
export function stitchPrediction() {
  const seq = state.pool.sequence || [];
  const range = resolveRange(state.pool.renderRange, seq.length);
  const label = rangeLabel(range);
  const base = label ? `Stitch ${label}` : 'Stitch Sequence';
  if (!isConformEnabled()) return { label: base, mode: 'plain' };
  if (seq.length < 2) return { label: base, mode: 'plain' };
  // Only the clips inside the window decide copy vs re-encode.
  const windowSeq = (range.active && !range.error)
    ? seq.slice(range.from - 1, range.to)
    : seq;
  if (windowSeq.length < 2) return { label: base, mode: 'plain' };
  if (windowSeq.some((e) => e.conformStatus === 'pending' || e.conformStatus === 'running')) {
    return { label: 'Conforming…', mode: 'working' };
  }
  const allOk = windowSeq.length > 0 && windowSeq.every((e) => e.conformedPath && e.conformStatus !== 'stale' && e.conformStatus !== 'invalid');
  if (allOk) return { label: `${base} (copy)`, mode: 'copy' };
  return { label: `${base} (re-encode)`, mode: 'reencode' };
}

export function updateStitchButton() {
  const btn = document.getElementById('btnPoolStitch');
  if (!btn) return;
  const pred = stitchPrediction();
  // Keep the play icon; swap only the text node after it.
  const svg = btn.querySelector('svg');
  const label = pred.label;
  btn.dataset.conformMode = pred.mode;
  // The button follows the render range: a window with <2 clips cannot stitch.
  const range = resolveRange(state.pool.renderRange, (state.pool.sequence || []).length);
  btn.disabled = rangeClipCount(range) < 2;
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
  const _rangeLabel = rangeLabel(range);
  btn.setAttribute('data-help-title', pred.mode === 'copy'
    ? `Every clip has a valid conformed sibling — Stitch will try the concat-copy fast path (falls back to re-encode if the gate fails).${_rangeLabel ? ` Range: clips ${_rangeLabel}.` : ''}`
    : pred.mode === 'reencode'
      ? `Conform is on but some clips lack a valid conform — Stitch regenerates them first, else re-encodes.${_rangeLabel ? ` Range: clips ${_rangeLabel}.` : ''}`
      : pred.mode === 'working'
        ? 'Conform cache-fill running…'
        : `Stitch clips end-to-end${_rangeLabel ? ` — render range: clips ${_rangeLabel}` : ''}`);
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
    import('/js/pool/sequence-composer.js?v=3').then((m) => {
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
