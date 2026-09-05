// Extracted from pool/sequence.js — see sequence.js barrel. Vanilla ES6, no framework.
import { state, sequencePositions } from '/app.js';
import { selectPoolItem } from '/js/pool/items.js';
import { basename, escapeHtml, formatDurationExact } from '/js/utils.js';
import { poolThumbUrl, itemShowsThumb, shortHash } from '/js/pool/persistence.js';
import { isPoolGridScrolling, lastPoolPointer } from '/js/pool/layout.js';
import { findPoolItem } from '/js/pool/sequence-model.js';

/** Path shown in the Selection frame: temporary hover, else sticky selection. */
function displayFocusPath() {
  return state.pool.hoverPath || state.pool.selectedPath || null;
}

/** Temporary hover — updates Selection preview only; does not change selection. */
function setPoolHover(path) {
  if (isPoolGridScrolling()) return;
  if (!path) {
    clearPoolHover();
    return;
  }
  if (state.pool.hoverPath === path) return;
  state.pool.hoverPath = path;
  state.pool.focusPath = path; // keep legacy field in sync for any remaining callers
  updatePoolFocusFrame(path);
  updateSelectionHighlights();
}

function clearPoolHover() {
  if (isPoolGridScrolling()) return;
  if (!state.pool.hoverPath) return;
  state.pool.hoverPath = null;
  state.pool.focusPath = state.pool.selectedPath;
  updatePoolFocusFrame(state.pool.selectedPath);
  updateSelectionHighlights();
}

/** After scroll stops: hover the card still under the pointer, else clear. */
function applyPoolHoverAtPoint() {
  if (isPoolGridScrolling()) return;
  const { x, y } = lastPoolPointer();
  const under = document.elementFromPoint(x, y);
  const card = under && under.closest ? under.closest('.pool-card:not(.img-pool-card), .seq-token') : null;
  const path = card && card.dataset ? card.dataset.path : null;
  if (path) setPoolHover(path);
  else clearPoolHover();
}

/** Sticky click selection — library and sequence stay in sync by path. */
function setPoolFocus(path, opts = {}) {
  // Back-compat: hard focus = select; soft = hover only
  if (opts.soft) {
    setPoolHover(path);
    return;
  }
  if (path) selectPoolItem(path);
}

/** Sync .selected / .hovered classes across pool cards and sequence tokens. */
let _hlSel = null;
let _hlHov = null;

function _attrEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function _elsForPath(path) {
  if (!path) return [];
  const sel = `[data-path="${_attrEscape(path)}"]`;
  return [
    ...document.querySelectorAll(`.pool-card${sel}`),
    ...document.querySelectorAll(`.seq-token${sel}`),
  ];
}

function _applyHighlight(el, sel, hov) {
  const p = el.dataset.path;
  const multi = (typeof window !== 'undefined' && window.state?.pool?.selectedPaths instanceof Set)
    ? window.state.pool.selectedPaths
    : null;
  const isSel = multi ? multi.has(p) : (!!sel && p === sel);
  const isHov = !!hov && p === hov;
  el.classList.toggle('selected', isSel);
  el.classList.toggle('hovered', isHov);
  if (el.classList.contains('seq-token')) {
    el.classList.toggle('focused', isHov || (isSel && !hov));
  } else {
    el.classList.toggle('focused', isHov);
  }
}

function updateSelectionHighlights() {
  const sel = state.pool.selectedPath;
  const hov = state.pool.hoverPath;
  const multi = state.pool.selectedPaths instanceof Set ? state.pool.selectedPaths : null;
  const sig = multi ? `${[...multi].join('\0')}|${hov}` : `${sel}|${hov}`;
  if (sig === _hlSel && hov === _hlHov && !multi) return;
  const changed = new Set();
  if (sel !== _hlSel) {
    if (_hlSel) changed.add(_hlSel);
    if (sel) changed.add(sel);
  }
  if (hov !== _hlHov) {
    if (_hlHov) changed.add(_hlHov);
    if (hov) changed.add(hov);
  }
  if (multi) {
    for (const p of multi) changed.add(p);
    document.querySelectorAll('.pool-card.selected, .seq-token.selected').forEach((el) => {
      if (el.dataset.path) changed.add(el.dataset.path);
    });
  }
  _hlSel = multi ? sig : sel;
  _hlHov = hov;
  for (const p of changed) {
    for (const el of _elsForPath(p)) _applyHighlight(el, sel, hov);
  }
}

function updatePoolFocusFrame(path) {
  const frame = document.getElementById('poolFocusFrame');
  if (!frame) return;
  if (frame.dataset.focusPath === String(path || '') && frame.childElementCount) return;
  frame.dataset.focusPath = String(path || '');

  if (!path) {
    frame.innerHTML = `<div class="pool-focus-empty">Hover or click a clip</div>`;
    return;
  }

  let item = findPoolItem(path);
  if (!item) {
    // Sequence-only path not in pool (shouldn't happen often)
    item = { path, name: basename(path), hash: null, meta: null };
  }

  const firstSrc = itemShowsThumb(item, 'first') ? poolThumbUrl(item, 'first') : '';
  const lastSrc = itemShowsThumb(item, 'last') ? poolThumbUrl(item, 'last') : '';
  const name = item.name || basename(path);
  const m = item.meta || {};
  const hasMeta = !!(item.meta);
  const dur = hasMeta && m.duration != null ? formatDurationExact(m.duration) : '';
  const hash = item.hash || m.hash || '';
  const seqPos = sequencePositions(path);

  // Sequence timing info
  let seqTimingHtml = '';
  const seqEntry = state.pool.sequence.find(s => s.path === path);
  if (seqEntry && seqEntry.targetDuration != null && seqEntry.targetDuration > 0 && m.duration && m.duration > 0) {
    const factor = seqEntry.targetDuration / m.duration;
    const pct = Math.round((m.duration / seqEntry.targetDuration) * 100);
    seqTimingHtml = `<div class="pool-meta-row" style="color:#f59e0b;font-weight:600;">
      <span>⏱ ${formatDurationExact(m.duration)} → ${formatDurationExact(seqEntry.targetDuration)} (${pct}% speed ${factor >= 1 ? 'slower' : 'faster'})</span>
    </div>`;
  }

  frame.innerHTML = `
    ${seqPos.length > 0 ? `<span class="pool-seq-indicator">${seqPos.join(' ')}</span>` : ''}
    <div class="pool-focus-frames">
      <div class="pool-frame">
        <img class="pool-thumb" alt="First" decoding="async" draggable="false"${firstSrc ? ` src="${firstSrc}"` : ''}>
        <span class="pool-frame-label">FIRST</span>
      </div>
      <div class="pool-frame">
        <img class="pool-thumb" alt="Last" decoding="async" draggable="false"${lastSrc ? ` src="${lastSrc}"` : ''}>
        <span class="pool-frame-label">LAST</span>
      </div>
    </div>
    <div class="pool-focus-meta pool-overlay-text">
      <div class="pool-meta-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="pool-meta-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>
      ${hasMeta ? `<div class="pool-meta-row">
        ${hash ? `<span class="pool-hash">#${escapeHtml(shortHash(hash))}</span>` : ''}
        ${dur ? `<span>${dur}</span>` : ''}
        ${m.fps ? `<span>${m.fps} fps</span>` : ''}
        ${m.frames != null ? `<span>${m.frames} fr</span>` : ''}
      </div>` : `<div class="pool-meta-unavailable">metadata unavailable</div>`}
      ${seqTimingHtml}
    </div>
  `;

}

export { displayFocusPath, setPoolHover, clearPoolHover, applyPoolHoverAtPoint, setPoolFocus, updateSelectionHighlights, updatePoolFocusFrame };
