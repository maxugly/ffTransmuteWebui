// Sequence clip-range UI — inputs, hint line, chip dimming for the
// "render clip N → M" window.
//
// Pure math lives in sequence-range.js; this file owns the DOM wiring.
// The range scopes the Sequence RENDER (Stitch) only — Instant RIFE and
// Erase keep covering the whole sequence.

import { state } from '/app.js?v=4';
import { resolveRange, rangeHint, rangeIncludes } from '/js/pool/sequence-range.js';

const FROM_ID = 'seqRangeFrom';
const TO_ID = 'seqRangeTo';
const HINT_ID = 'seqRangeHint';

/** Raw range bounds as typed (null = unset). */
function seqRange() {
  const r = (state.pool && state.pool.renderRange) || null;
  if (!r || typeof r !== 'object') return { from: null, to: null };
  return { from: r.from ?? null, to: r.to ?? null };
}

/** Range resolved against the current sequence length. */
function seqRangeResolved() {
  const seq = (state.pool && state.pool.sequence) || [];
  return resolveRange(seqRange(), seq.length);
}

/** Write the stored range back into the inputs (no events fired). */
export function syncSeqRangeInputs() {
  const r = seqRange();
  const fromEl = document.getElementById(FROM_ID);
  const toEl = document.getElementById(TO_ID);
  const fromVal = isBlankBound(r.from) ? '' : String(r.from);
  const toVal = isBlankBound(r.to) ? '' : String(r.to);
  if (fromEl && fromEl.value !== fromVal) fromEl.value = fromVal;
  if (toEl && toEl.value !== toVal) toEl.value = toVal;
}

function isBlankBound(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Bind the range inputs (idempotent — safe to call on every build). */
export function bindSeqRangeInputs() {
  const fromEl = document.getElementById(FROM_ID);
  const toEl = document.getElementById(TO_ID);
  if (!fromEl || !toEl) return;
  const onEdit = () => {
    if (!state.pool) return;
    state.pool.renderRange = {
      from: fromEl.value.trim() === '' ? null : fromEl.value.trim(),
      to: toEl.value.trim() === '' ? null : toEl.value.trim(),
    };
    updateSeqRangeUI();
    try {
      import('/js/pool/persistence.js?v=3')
        .then((m) => m.scheduleSavePoolState())
        .catch(() => {});
    } catch (_) { /* autosave is best-effort */ }
  };
  [fromEl, toEl].forEach((el) => {
    if (el.dataset.seqRangeBound === '1') return;
    el.dataset.seqRangeBound = '1';
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);
  });
}

/** Refresh hint text, chip dimming and the Stitch button. */
export function updateSeqRangeUI() {
  const resolved = seqRangeResolved();
  const hint = document.getElementById(HINT_ID);
  if (hint) {
    hint.textContent = rangeHint(resolved);
    hint.classList.toggle('is-error', !!resolved.error);
  }
  // Keep the "to" placeholder on the live clip count.
  const toEl = document.getElementById(TO_ID);
  if (toEl) toEl.placeholder = String(resolved.total || 'N');
  applySeqRangeChipClasses(resolved);
  try {
    import('/js/pool/sequence-conform.js?v=1')
      .then((m) => m.updateStitchButton())
      .catch(() => {});
  } catch (_) { /* button label is optional */ }
  try {
    import('/js/pool/sequence-export.js?v=3')
      .then((m) => m.updateExportButtons())
      .catch(() => {});
  } catch (_) { /* export buttons optional */ }
}

/**
 * Dim chips outside the range. Class toggle only — never re-render the strip
 * (a full rebuild of 300+ chips per keystroke is seconds of forced reflow).
 */
function applySeqRangeChipClasses(resolved = null) {
  const box = document.getElementById('poolSequenceBox');
  if (!box) return;
  const r = resolved || seqRangeResolved();
  const tokens = box.querySelectorAll('.seq-token');
  tokens.forEach((tok, i) => {
    tok.classList.toggle('is-out-of-range', !rangeIncludes(r, i + 1));
  });
}
