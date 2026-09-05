// Extracted from pool/sequence.js — see sequence.js barrel. Vanilla ES6, no framework.
import { state } from '/app.js';
import { formatDurationExact } from '/js/utils.js';

function findPoolItem(path) {
  return state.pool.items.find(i => i.path === path) || null;
}

/** Play length of one sequence entry: Time override if set, else native meta. */
function seqEntryPlayDuration(entry) {
  if (!entry) return 0;
  if (entry.targetDuration != null && Number.isFinite(entry.targetDuration) && entry.targetDuration > 0) {
    return Number(entry.targetDuration);
  }
  const native = findPoolItem(entry.path)?.meta?.duration;
  if (native != null && Number(native) > 0) return Number(native);
  return 0;
}

function sequenceTotalDuration() {
  return (state.pool.sequence || []).reduce((sum, entry) => sum + seqEntryPlayDuration(entry), 0);
}

function updateSeqTotalTime() {
  const el = document.getElementById('seqTotalTime');
  if (!el) return;
  const n = state.pool.sequence?.length || 0;
  if (!n) {
    el.textContent = '';
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const total = sequenceTotalDuration();
  const unknown = (state.pool.sequence || []).filter((e) => seqEntryPlayDuration(e) <= 0).length;
  el.textContent = unknown
    ? `${formatDurationExact(total)} total · ${unknown} unknown`
    : `${formatDurationExact(total)} total`;
  el.title = 'Sum of clip times (Time override if set, else native duration)';
}

function _getNativeMeta(path) {
  const item = findPoolItem(path);
  return item?.meta || null;
}

export { findPoolItem, seqEntryPlayDuration, sequenceTotalDuration, updateSeqTotalTime, _getNativeMeta };
