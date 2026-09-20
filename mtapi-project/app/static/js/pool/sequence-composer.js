// Extracted from pool/sequence.js — see sequence.js barrel. Vanilla ES6, no framework.
import { state, elements, logConsole, renderPoolGrid, sequencePositions } from '/app.js';
import { selectPoolItem } from '/js/pool/items.js';
import { isVideoPath, basename, escapeHtml, formatDurationExact } from '/js/utils.js';
import { poolThumbUrl, itemShowsThumb, shortHash, nextSeqId, scheduleSavePoolState, savePoolStateNow, refreshPoolToolbarCounts } from '/js/pool/persistence.js';
import { installPoolScrollPaint } from '/js/pool/layout.js';
import { findPoolItem, seqEntryPlayDuration, updateSeqTotalTime } from '/js/pool/sequence-model.js';
import { setPoolHover, applyPoolHoverAtPoint, clearPoolHover, displayFocusPath, updateSelectionHighlights, updatePoolFocusFrame } from '/js/pool/sequence-select.js';
import { refreshRifeNeed, _resolvedTargetFps, _rifeBadgeForEntry, _scheduleInstantRifeKick, _entrySatisfiesNeed, _updateInstantRifeStrip, _findQueuedRife, _maybeAutoRifeEntry, isHydrationComplete, isInstantArmed } from '/js/pool/sequence-rife.js';
import { peekVariants, _fetchVariants, _fetchVariantsBatch, _normVariantKey, _showSeqVariantMenu } from '/js/pool/sequence-variants.js';
import { updateSeqTransportUI, updateSeqClipSettings, seqClipSpeedInfo, seqClipTokenTitle, seqStop } from '/js/pool/sequence-transport.js';
import { conformBadgeForEntry, updateStitchButton, maybeAutoConformEntry } from '/js/pool/sequence-conform.js';
import { eraseBadgeForEntry, ensureSequenceLineages } from '/js/pool/sequence-erase.js?v=2';
import { normTagColor, sequenceUseCounts, openTagPicker } from '/js/pool/sequence-tag.js';

function setupSequenceDropZone() {
  installPoolScrollPaint(applyPoolHoverAtPoint);
  const box = document.getElementById('poolSequenceBox');
  if (!box) return;

  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    const types = e.dataTransfer.types;
    if (types.includes('application/x-pool-path') || types.includes('application/x-seq-id') || types.includes('text/plain')) {
      e.dataTransfer.dropEffect = types.includes('application/x-seq-id') ? 'move' : 'copy';
      box.classList.add('drag-over');
    }
  });

  box.addEventListener('dragleave', (e) => {
    if (!box.contains(e.relatedTarget)) box.classList.remove('drag-over');
  });

  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drag-over');

    const seqId = e.dataTransfer.getData('application/x-seq-id');
    const poolPath = e.dataTransfer.getData('application/x-pool-path') || e.dataTransfer.getData('text/plain');

    // Drop target index from token under cursor
    const tokenEl = e.target.closest('.seq-token');
    let insertAt = state.pool.sequence.length;
    if (tokenEl) {
      const tid = tokenEl.dataset.id;
      const idx = state.pool.sequence.findIndex(s => String(s.id) === String(tid));
      if (idx >= 0) {
        // Insert before or after based on mouse X midpoint
        const rect = tokenEl.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        insertAt = before ? idx : idx + 1;
      }
    }

    if (seqId) {
      // Reorder existing token
      const from = state.pool.sequence.findIndex(s => String(s.id) === String(seqId));
      if (from < 0) return;
      const [item] = state.pool.sequence.splice(from, 1);
      if (insertAt > from) insertAt -= 1;
      state.pool.sequence.splice(insertAt, 0, item);
      renderSequenceBox();
      renderPoolGrid();
      selectPoolItem(item.path);
      scheduleSavePoolState();
      return;
    }

    if (poolPath && isVideoPath(poolPath)) {
      addPathToSequence(poolPath, insertAt);
    }
  });
}

function addPathToSequence(path, insertAt = null) {
  if (!path || !isVideoPath(path)) return;
  const item = findPoolItem(path);
  const name = item?.name || basename(path);
  const entry = {
    id: nextSeqId(),
    path,
    name,
    targetDuration: null, // seconds; null = native length
    _hadTarget: false,
    tagColor: null, // revisit mark; null = untagged (see sequence-tag.js)
    variantPath: (state.pool.selectedVariantPaths || {})[path] || null,
    conformedPath: null,
    conformSignature: null,
    conformStatus: null,
    _rifeStatus: null, // null | 'pending' | 'running' | 'done' | 'skipped'
  };
  if (insertAt == null || insertAt < 0 || insertAt > state.pool.sequence.length) {
    state.pool.sequence.push(entry);
  } else {
    state.pool.sequence.splice(insertAt, 0, entry);
  }
  logConsole(`[SEQ]: + ${name}`);
  try { ensureSequenceLineages(); } catch (_) { /* lineage optional */ }
  renderSequenceBox();
  renderPoolGrid();
  selectPoolItem(path); // select in library + sequence together
  refreshPoolToolbarCounts();
  updateSeqTransportUI();
  scheduleSavePoolState();
  _maybeAutoRifeEntry(entry);
  try { maybeAutoConformEntry(entry); } catch (_) { /* conform gate only */ }
  try {
    import('/js/pool/auto-firstlast.js').then((m) => {
      try { m.maybeAutoFLForSequence([path]); } catch (_) { /* ignore */ }
    }).catch(() => {});
  } catch (_) { /* auto F/L must not break sequence */ }
}

/**
 * Batch-append paths to the Sequence with a single render + save.
 * Used by pool auto-add on import (see settings `autoAddToSequence`).
 * Skips duplicates, non-video paths (Sequence is video-only), and blanks.
 * @returns {number} entries appended.
 */
function addPathsToSequence(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return 0;
  const seen = new Set((state.pool.sequence || []).map(s => s.path));
  const fresh = [];
  for (const raw of paths) {
    const path = typeof raw === 'string' ? raw.trim() : '';
    if (!path || !isVideoPath(path) || seen.has(path)) continue;
    seen.add(path);
    const item = findPoolItem(path);
    fresh.push({
      id: nextSeqId(),
      path,
      name: item?.name || basename(path),
      targetDuration: null, // seconds; null = native length
      _hadTarget: false,
      tagColor: null, // revisit mark; null = untagged (see sequence-tag.js)
      variantPath: (state.pool.selectedVariantPaths || {})[path] || null,
      conformedPath: null,
      conformSignature: null,
      conformStatus: null,
      _rifeStatus: null, // null | 'pending' | 'running' | 'done' | 'skipped'
    });
  }
  if (fresh.length === 0) return 0;
  state.pool.sequence.push(...fresh);
  logConsole(`[SEQ]: +${fresh.length} (auto-add on import)`);
  try { ensureSequenceLineages(); } catch (_) { /* lineage optional */ }
  renderSequenceBox();
  try { renderPoolGrid(); } catch (_) { /* grid may be absent */ }
  try { selectPoolItem(fresh[fresh.length - 1].path); } catch (_) { /* ignore */ }
  refreshPoolToolbarCounts();
  updateSeqTransportUI();
  scheduleSavePoolState();
  for (const entry of fresh) {
    try { _maybeAutoRifeEntry(entry); } catch (_) { /* ignore */ }
    try { maybeAutoConformEntry(entry); } catch (_) { /* conform gate only */ }
  }
  try {
    import('/js/pool/auto-firstlast.js').then((m) => {
      try { m.maybeAutoFLForSequence(fresh.map((e) => e.path)); } catch (_) { /* ignore */ }
    }).catch(() => {});
  } catch (_) { /* auto F/L must not break sequence */ }
  return fresh.length;
}

function removeSequenceAt(idx) {
  if (idx < 0 || idx >= state.pool.sequence.length) return;
  const [removed] = state.pool.sequence.splice(idx, 1);
  logConsole(`[SEQ]: − ${removed.name}`);
  // Adjust playback index if needed
  if (state.pool.playback.index >= state.pool.sequence.length) {
    state.pool.playback.index = Math.max(0, state.pool.sequence.length - 1);
  }
  renderSequenceBox();
  renderPoolGrid();
  updatePoolFocusFrame(displayFocusPath());
  refreshPoolToolbarCounts();
  updateSeqTransportUI();
  scheduleSavePoolState();
}

function clearSequence(opts = {}) {
  const n = state.pool.sequence?.length || 0;
  if (n === 0) {
    logConsole('[SEQ]: Already empty');
    refreshPoolToolbarCounts();
    updateSeqTransportUI();
    return;
  }
  if (opts.confirm !== false) {
    // Allow silent clear when opts.confirm === false
    if (!window.confirm(`Clear all ${n} clip(s) from the sequence?`)) return;
  }
  try {
    seqStop();
  } catch (err) {
    console.error('[SEQ] seqStop during clear', err);
  }
  state.pool.sequence = [];
  state.pool.selectedSeqId = null;
  state.pool.playback = state.pool.playback || {};
  state.pool.playback.index = 0;
  state.pool.playback.playing = false;
  logConsole('[SEQ]: Cleared');
  renderSequenceBox();
  try { renderPoolGrid(); } catch (_) { /* grid may be absent */ }
  updatePoolFocusFrame(displayFocusPath());
  try { updateSeqClipSettings(); } catch (_) { /* optional */ }
  refreshPoolToolbarCounts();
  updateSeqTransportUI();
  scheduleSavePoolState();
}

/**
 * @param {{ skipInstantKick?: boolean }} [opts]
 *   skipInstantKick — avoid re-entrancy (queue → render → kick → render…).
 */
/** Apply W/H size levels to the sequence strip (CSS data attributes). */
function applySeqTokenSize() {
  const box = document.getElementById('poolSequenceBox');
  if (!box) return;
  const w = Math.max(0, Math.min(5, state.pool.seqTokenW ?? 2));
  const h = Math.max(0, Math.min(5, state.pool.seqTokenH ?? 2));
  state.pool.seqTokenW = w;
  state.pool.seqTokenH = h;
  box.dataset.seqW = String(w);
  box.dataset.seqH = String(h);
  // Min width px per level (must match CSS --seq-token-min-w table)
  const minWs = [110, 128, 152, 180, 220, 260];
  box.style.setProperty('--seq-token-min-w', `${minWs[w]}px`);
}

function setSeqTokenSize(dim, delta) {
  if (dim === 'w') {
    state.pool.seqTokenW = Math.max(0, Math.min(5, (state.pool.seqTokenW ?? 2) + delta));
  } else if (dim === 'h') {
    state.pool.seqTokenH = Math.max(0, Math.min(5, (state.pool.seqTokenH ?? 2) + delta));
  }
  applySeqTokenSize();
  // Re-layout tokens so min-width / flex recompute
  renderSequenceBox({ skipInstantKick: true });
  try { scheduleSavePoolState(); } catch (_) { /* ignore */ }
}

function renderSequenceBox(opts) {
  opts = opts || {};
  const box = document.getElementById('poolSequenceBox');
  if (!box) return;
  applySeqTokenSize();

  const stitchBtn = document.getElementById('btnPoolStitch');
  if (stitchBtn) stitchBtn.disabled = state.pool.sequence.length < 2;

  if (state.pool.sequence.length === 0) {
    box.innerHTML = `<div class="seq-placeholder">Drop videos here to build a stitch sequence…</div>`;
    updateSeqTotalTime();
    _updateInstantRifeStrip();
    updateSeqTransportUI();
    try { updateStitchButton(); } catch (_) { /* prediction only */ }
    return;
  }

  // Compute total effective duration for proportional token widths
  const durations = state.pool.sequence.map((entry) => {
    const play = seqEntryPlayDuration(entry);
    return play > 0 ? play : 1.0;
  });
  const totalDuration = durations.reduce((a, b) => a + b, 0);

  box.innerHTML = '';
  const playIdx = state.pool.playback.playing || state.pool.playback.index >= 0
    ? state.pool.playback.index
    : -1;
  // One target resolution + one style read per render — per-token repeats of
  // either turn this loop O(n²) (347 tokens ≈ seconds of forced reflow).
  const _renderTarget = _resolvedTargetFps();
  const _tokenMinW = getComputedStyle(box).getPropertyValue('--seq-token-min-w').trim() || '152px';
  // Usage counts grouped by original path (one pass — not per token).
  const _useCounts = sequenceUseCounts();

  state.pool.sequence.forEach((entry, idx) => {
    const tok = document.createElement('span');
    const isPlaying = state.pool.playback.playing && playIdx === idx;
    const isSelected = state.pool.selectedPath === entry.path;
    const isHovered = state.pool.hoverPath === entry.path;
    const speedInfo = seqClipSpeedInfo(entry);
    tok.className = `seq-token${isSelected ? ' selected' : ''}${isHovered ? ' hovered' : ''}${isSelected && !isHovered ? ' focused' : ''}${isPlaying ? ' playing' : ''}${speedInfo.stretched ? ' time-stretched' : ''}`;
    tok.draggable = true;
    tok.dataset.id = String(entry.id);
    tok.dataset.path = entry.path;
    tok.dataset.idx = String(idx);
    tok.setAttribute('data-help-title', seqClipTokenTitle(entry, speedInfo));

    const usingRifed = !!(entry.variantPath && entry.variantPath !== entry.path);
    const fileBtnLabel = usingRifed ? 'RIFED' : 'ORIG';
    const fileBtnTitle = usingRifed
      ? [
          'FILE: RIFED — Stitch will use the densified file.',
          `Active: ${basename(entry.variantPath)}`,
          `Original: ${basename(entry.path)}`,
          'Click to open the file menu (Original vs densified).',
        ].join('\n')
      : [
          'FILE: ORIG — Stitch will use the original source file.',
          `Active: ${basename(entry.path)}`,
          entry.variantPath
            ? `Densified available — click to switch.`
            : 'No densified variant yet (or not selected).',
          'Click to open the file menu.',
        ].join('\n');

    // Two-row layout: name on top; controls (dur / ORIG / badge / ×) on bottom
    // so badges never spill onto neighboring chips.
    // Top row also owns the tag block (#-sized revisit mark, independent of
    // the Time speed colors) and the ×N usage badge (same path >1 in seq).
    const _tag = normTagColor(entry.tagColor);
    const _use = _useCounts.get(entry.path);
    const _useBadge = (_use && _use.count > 1)
      ? `<span class="seq-use-badge" data-help-title="In sequence ${_use.count}× (#${_use.positions.join(', #')})">&times;${_use.count}</span>`
      : '';
    const _tagTitle = _tag
      ? `Tag: ${_tag} — click to change the revisit mark`
      : 'Tag this clip — click to pick a revisit color';
    tok.innerHTML = `
      <span class="seq-token-row seq-token-row-top">
        <span class="seq-token-idx">${idx + 1}</span>
        <button type="button" class="seq-token-tag${_tag ? ' is-tagged' : ''}"${_tag ? ` style="background:${_tag}"` : ''} data-help-title="${escapeHtml(_tagTitle)}" aria-label="${escapeHtml(_tagTitle)}"></button>
        <span class="seq-token-name">${escapeHtml(entry.name)}</span>
        ${_useBadge}
        <button type="button" class="seq-token-x" data-help-title="Remove from sequence">&cross;</button>
      </span>
      <span class="seq-token-row seq-token-row-bot">
        <span class="seq-token-dur${speedInfo.stretched ? ' timed' : ''}">${speedInfo.durLabel}</span>
        <button type="button" class="seq-token-var${usingRifed ? ' is-rifed' : ''}" data-variant-path="${escapeHtml(entry.variantPath || '')}">${fileBtnLabel}</button>
        <span class="seq-token-rife-host"></span>
      </span>
    `;

    const varBtn = tok.querySelector('.seq-token-var');
    if (varBtn) {
      varBtn.setAttribute('data-help-title', fileBtnTitle);
      varBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const currentPath = entry.variantPath || entry.path;
        const variants = peekVariants(entry.path) || await _fetchVariants(entry.path);
        _showSeqVariantMenu(varBtn, entry, variants, currentPath);
      });
    }

    const tagBtn = tok.querySelector('.seq-token-tag');
    if (tagBtn) {
      tagBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTagPicker(tagBtn, entry.id);
      });
    }

    // Single state badge (NEED / Q# / RUN / OK / FAIL) — hover for full explanation
    const badge = _rifeBadgeForEntry(entry, _renderTarget);
    const host = tok.querySelector('.seq-token-rife-host');
    if (badge && host) {
      if (badge.cls.includes('is-need') || badge.cls.includes('is-queued') || badge.cls.includes('is-running')) {
        tok.classList.add('seq-rife-needed');
      }
      const el = document.createElement('span');
      el.className = badge.cls;
      el.textContent = badge.text;
      el.setAttribute('data-help-title', badge.title);
      el.setAttribute('role', 'status');
      host.appendChild(el);
    }
    // Conform badge: valid / stale / pending — visibly distinct from RIFE.
    const cbadge = conformBadgeForEntry(entry);
    if (cbadge && host) {
      const cel = document.createElement('span');
      cel.className = cbadge.cls;
      cel.textContent = cbadge.text;
      cel.setAttribute('data-help-title', cbadge.title);
      cel.setAttribute('role', 'status');
      host.appendChild(cel);
    }
    // Erase badge: mask dot + stale marker (spec §4.1). Never a RIFE badge.
    try {
      const ebadge = eraseBadgeForEntry(entry);
      if (ebadge && host) {
        const eel = document.createElement('span');
        eel.className = ebadge.cls;
        eel.textContent = ebadge.text;
        eel.setAttribute('data-help-title', ebadge.title);
        eel.setAttribute('role', 'status');
        host.appendChild(eel);
      }
    } catch (_) { /* badge optional */ }

    // Proportional width, but never below size-level min-width (prevents control crush)
    const ratio = totalDuration > 0
      ? (durations[idx] / totalDuration) * 100
      : (100 / state.pool.sequence.length);
    const minW = _tokenMinW;
    tok.style.flex = `1 1 max(${minW}, ${ratio.toFixed(2)}%)`;
    tok.style.minWidth = minW;
    tok.style.maxWidth = '100%';

    // Color the TIME text for beat-sync at a glance (not just token chrome)
    const durEl = tok.querySelector('.seq-token-dur');
    if (durEl && speedInfo.stretched && speedInfo.textColor) {
      durEl.style.color = speedInfo.textColor;
      durEl.style.fontWeight = '700';
      durEl.style.textShadow = speedInfo.textShadow || 'none';
      if (speedInfo.bgCss) {
        tok.style.background = speedInfo.bgCss;
        tok.style.borderColor = speedInfo.borderCss;
      }
    } else if (durEl && entry._hadTarget) {
      durEl.style.color = 'rgba(251, 191, 36, 0.75)';
      durEl.style.fontWeight = '600';
      durEl.style.textShadow = 'none';
      tok.classList.add('was-stretched');
    }

    tok.addEventListener('click', (e) => {
      if (e.target.closest('.seq-token-x') || e.target.closest('.seq-token-var') || e.target.closest('.seq-token-tag') || e.target.closest('.seq-rife-badge') || e.target.closest('.seq-conform-badge')) return;
      state.pool.playback.index = idx;
      state.pool.selectedSeqId = entry.id;
      selectPoolItem(entry.path); // also selects matching library tile
      updateSeqTransportUI();
      updateSeqClipSettings();
    });
    tok.addEventListener('mouseenter', () => {
      if (!state.pool.playback.playing) setPoolHover(entry.path);
    });
    tok.addEventListener('mouseleave', (e) => {
      const to = e.relatedTarget;
      if (to && (to.closest?.('.pool-card') || to.closest?.('.seq-token'))) return;
      clearPoolHover();
    });

    tok.querySelector('.seq-token-x')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSequenceAt(idx);
    });

    tok.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-seq-id', String(entry.id));
      e.dataTransfer.setData('text/plain', entry.path);
      e.dataTransfer.effectAllowed = 'move';
      state.pool.seqDragId = entry.id;
      tok.classList.add('dragging');
    });
    tok.addEventListener('dragend', () => {
      tok.classList.remove('dragging');
      state.pool.seqDragId = null;
      scheduleSavePoolState();
    });

    box.appendChild(tok);

    // Visual separator (arrow) between tokens except last
    if (idx < state.pool.sequence.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'seq-sep';
      sep.textContent = '\u2192';
      sep.setAttribute('aria-hidden', 'true');
      box.appendChild(sep);
    }
  });

  // Variant count polish is cached/coalesced — never flood /api/variants
  _updateSeqVariantBadges();

  try { updateStitchButton(); } catch (_) { /* prediction only */ }
  _updateInstantRifeStrip();
  updateSeqTransportUI();
  updateSeqTotalTime();
  // Restore renders are never a start gesture (spec §8.3): the kick needs an
  // armed user start (toggle/Time/add/RIFE-fps), not just a hydrated open.
  if (!opts.skipInstantKick && isHydrationComplete() && isInstantArmed() && state.pool.instantRife && state.pool.useRife) {
    const hasIdleNeed = (state.pool.sequence || []).some((e) => {
      if (e._rifeStatus === 'pending' || e._rifeStatus === 'running'
          || e._rifeStatus === 'failed' || _findQueuedRife(e.id)) {
        return false;
      }
      // Always recompute: persisted rifeNeed may predate target/meta.
      return refreshRifeNeed(e) === 'needsRife';
    });
    if (hasIdleNeed) _scheduleInstantRifeKick();
  }
}

/**
 * Async polish for ORIG/RIFED button titles from /api/variants.
 * Safe no-op on failure — render already set labels from entry.variantPath.
 */
async function _updateSeqVariantBadges() {
  try {
    const tokens = document.querySelectorAll('#poolSequenceBox .seq-token');
    const seen = new Set();
    const needFetch = [];
    for (const tok of tokens) {
      const path = tok.dataset.path;
      const id = tok.dataset.id;
      if (!path || seen.has(path + '\0' + id)) continue;
      seen.add(path + '\0' + id);
      const entry = state.pool.sequence.find((e) => String(e.id) === String(id));
      if (!entry) continue;
      const btn = tok.querySelector('.seq-token-var');
      if (!btn) continue;
      const using = entry.variantPath && entry.variantPath !== entry.path;
      btn.classList.toggle('is-rifed', !!using);
      btn.textContent = using ? 'RIFED' : 'ORIG';
      const local = peekVariants(path);
      if (local) {
        const n = Object.values(local).reduce((a, arr) => a + (arr?.length || 0), 0);
        if (n > 0 && !(btn.getAttribute('data-help-title') || '').includes('Registered variants')) {
          btn.setAttribute('data-help-title', (btn.getAttribute('data-help-title') || '') + `\nRegistered variants: ${n}`);
        }
        continue;
      }
      if (entry.rifeNeed === 'rifed' || entry.rifeNeed === 'noRifeNeeded'
          || _entrySatisfiesNeed(entry)) continue;
      needFetch.push(path);
    }
    if (!needFetch.length) return;
    // Badge polish is a read (spec §8.3): cached labels only until an armed
    // gesture starts the scan that hydrates the registry view.
    if (!isInstantArmed()) return;
    const map = await _fetchVariantsBatch(needFetch);
    for (const tok of tokens) {
      const path = tok.dataset.path;
      const entry = state.pool.sequence.find((e) => String(e.id) === String(tok.dataset.id));
      const btn = tok.querySelector('.seq-token-var');
      if (!path || !entry || !btn) continue;
      const variants = map.get(_normVariantKey(path)) || peekVariants(path) || {};
      const n = Object.values(variants).reduce((a, arr) => a + (arr?.length || 0), 0);
      if (n > 0 && !(btn.getAttribute('data-help-title') || '').includes('Registered variants')) {
        btn.setAttribute('data-help-title', (btn.getAttribute('data-help-title') || '') + `\nRegistered variants: ${n}`);
      }
    }
  } catch (e) {
    console.warn('[SEQ] _updateSeqVariantBadges', e);
  }
}

export { setupSequenceDropZone, addPathToSequence, addPathsToSequence, removeSequenceAt, clearSequence, applySeqTokenSize, setSeqTokenSize, renderSequenceBox };
