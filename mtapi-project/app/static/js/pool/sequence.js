import {
  state, elements,
  logConsole,
  renderPoolGrid,
  sequencePositions,
  setPreviewAspect,
  clearPreviewAspect,
} from '/app.js';
import { loadPoolItemMeta, selectPoolItem } from '/js/pool/items.js';
import { isVideoPath, basename, escapeHtml, formatDurationExact } from '/js/utils.js';
import {
  poolThumbUrl, shortHash, nextSeqId,
  scheduleSavePoolState, savePoolStateNow, refreshPoolToolbarCounts,
} from '/js/pool/persistence.js';

// ── Sequence composer ─────────────────────────────────────────────────────

function findPoolItem(path) {
  return state.pool.items.find(i => i.path === path) || null;
}

/** Path shown in the Selection frame: temporary hover, else sticky selection. */
function displayFocusPath() {
  return state.pool.hoverPath || state.pool.selectedPath || null;
}

/** Temporary hover — updates Selection preview only; does not change selection. */
function setPoolHover(path) {
  if (!path) {
    clearPoolHover();
    return;
  }
  state.pool.hoverPath = path;
  state.pool.focusPath = path; // keep legacy field in sync for any remaining callers
  updatePoolFocusFrame(path);
  updateSelectionHighlights();
}

function clearPoolHover() {
  if (!state.pool.hoverPath) return;
  state.pool.hoverPath = null;
  state.pool.focusPath = state.pool.selectedPath;
  updatePoolFocusFrame(state.pool.selectedPath);
  updateSelectionHighlights();
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
function updateSelectionHighlights() {
  const sel = state.pool.selectedPath;
  const hov = state.pool.hoverPath;
  document.querySelectorAll('.pool-card').forEach(el => {
    const p = el.dataset.path;
    el.classList.toggle('selected', !!sel && p === sel);
    el.classList.toggle('hovered', !!hov && p === hov);
    el.classList.toggle('focused', !!hov && p === hov); // alias for existing CSS
  });
  document.querySelectorAll('.seq-token').forEach(el => {
    const p = el.dataset.path;
    el.classList.toggle('selected', !!sel && p === sel);
    el.classList.toggle('hovered', !!hov && p === hov);
    el.classList.toggle('focused', (!!hov && p === hov) || (!!sel && p === sel && !hov));
  });
}

function updatePoolFocusFrame(path) {
  const frame = document.getElementById('poolFocusFrame');
  if (!frame) return;

  if (!path) {
    frame.innerHTML = `<div class="pool-focus-empty">Hover or click a clip</div>`;
    return;
  }

  let item = findPoolItem(path);
  if (!item) {
    // Sequence-only path not in pool (shouldn't happen often)
    item = { path, name: basename(path), hash: null, meta: null };
  }

  const firstSrc = poolThumbUrl(item, 'first');
  const lastSrc = poolThumbUrl(item, 'last');
  const name = item.name || basename(path);
  const m = item.meta || {};
  const dur = m.duration != null ? formatDurationExact(m.duration) : '';
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
        <img class="pool-thumb" src="${firstSrc}" alt="First" draggable="false"
             onerror="this.classList.add('broken')">
        <span class="pool-frame-label">FIRST</span>
      </div>
      <div class="pool-frame">
        <img class="pool-thumb" src="${lastSrc}" alt="Last" draggable="false"
             onerror="this.classList.add('broken')">
        <span class="pool-frame-label">LAST</span>
      </div>
    </div>
    <div class="pool-focus-meta pool-overlay-text">
      <div class="pool-meta-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="pool-meta-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>
      <div class="pool-meta-row">
        ${hash ? `<span class="pool-hash">#${escapeHtml(shortHash(hash))}</span>` : ''}
        ${dur ? `<span>${dur}</span>` : ''}
        ${m.fps ? `<span>${m.fps} fps</span>` : ''}
        ${m.frames != null ? `<span>${m.frames} fr</span>` : ''}
      </div>
      ${seqTimingHtml}
    </div>
  `;

  // Lazy-load meta if unknown
  const poolItem = findPoolItem(path);
  if (poolItem && !poolItem.meta && !poolItem.metaError) {
    const idx = state.pool.items.indexOf(poolItem);
    loadPoolItemMeta(poolItem, idx).then(() => {
      if (displayFocusPath() === path) updatePoolFocusFrame(path);
      renderSequenceBox(); // refresh duration labels on tokens
    });
  }
}

function setupSequenceDropZone() {
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
  };
  if (insertAt == null || insertAt < 0 || insertAt > state.pool.sequence.length) {
    state.pool.sequence.push(entry);
  } else {
    state.pool.sequence.splice(insertAt, 0, entry);
  }
  logConsole(`[SEQ]: + ${name}`);
  renderSequenceBox();
  renderPoolGrid();
  selectPoolItem(path); // select in library + sequence together
  // Refresh stitch button / counts without full re-render if possible
  refreshPoolToolbarCounts();
  updateSeqTransportUI();
  scheduleSavePoolState();
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

function clearSequence() {
  if (state.pool.sequence.length === 0) return;
  seqStop();
  state.pool.sequence = [];
  logConsole('[SEQ]: Cleared');
  renderSequenceBox();
  renderPoolGrid();
  updatePoolFocusFrame(displayFocusPath());
  refreshPoolToolbarCounts();
  updateSeqTransportUI();
  scheduleSavePoolState();
}

function renderSequenceBox() {
  const box = document.getElementById('poolSequenceBox');
  if (!box) return;

  const stitchBtn = document.getElementById('btnPoolStitch');
  if (stitchBtn) stitchBtn.disabled = state.pool.sequence.length < 2;

  if (state.pool.sequence.length === 0) {
    box.innerHTML = `<div class="seq-placeholder">Drop videos here to build a stitch sequence…</div>`;
    updateSeqTransportUI();
    return;
  }

  // Compute total effective duration for proportional token widths
  let totalDuration = 0;
  const durations = state.pool.sequence.map(entry => {
    if (entry.targetDuration != null && Number.isFinite(entry.targetDuration) && entry.targetDuration > 0) {
      return entry.targetDuration;
    }
    const native = findPoolItem(entry.path)?.meta?.duration;
    if (native != null && native > 0) return native;
    return 1.0;
  });
  totalDuration = durations.reduce((a, b) => a + b, 0);

  box.innerHTML = '';
  const playIdx = state.pool.playback.playing || state.pool.playback.index >= 0
    ? state.pool.playback.index
    : -1;

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
    tok.title = seqClipTokenTitle(entry, speedInfo);

    tok.innerHTML = `
      <span class="seq-token-idx">${idx + 1}</span>
      <span class="seq-token-name">${escapeHtml(entry.name)}</span>
      <span class="seq-token-dur${speedInfo.stretched ? ' timed' : ''}">${speedInfo.durLabel}</span>
      <button type="button" class="seq-token-x" title="Remove">&cross;</button>
    `;

    // Proportional width based on effective duration
    const ratio = totalDuration > 0
      ? (durations[idx] / totalDuration) * 100
      : (100 / state.pool.sequence.length);
    tok.style.flexBasis = ratio.toFixed(2) + '%';

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
    }

    tok.addEventListener('click', (e) => {
      if (e.target.closest('.seq-token-x')) return;
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
  updateSeqTransportUI();
}

// ── Sequence playback (preview in right media viewer) ─────────────────────

function updateSeqTransportUI() {
  const n = state.pool.sequence.length;
  const pb = state.pool.playback;
  const playBtn = document.getElementById('btnSeqPlay');
  const pauseBtn = document.getElementById('btnSeqPause');
  const stopBtn = document.getElementById('btnSeqStop');
  const prevBtn = document.getElementById('btnSeqPrev');
  const nextBtn = document.getElementById('btnSeqNext');
  const loopBtn = document.getElementById('btnSeqLoop');
  const status = document.getElementById('seqPlayStatus');
  const moveFirst = document.getElementById('btnSeqMoveFirst');
  const moveLeft = document.getElementById('btnSeqMoveLeft');
  const moveRight = document.getElementById('btnSeqMoveRight');
  const moveLast = document.getElementById('btnSeqMoveLast');
  const removeBtn = document.getElementById('btnSeqRemove');

  if (playBtn) playBtn.disabled = n === 0;
  if (prevBtn) prevBtn.disabled = n === 0;
  if (nextBtn) nextBtn.disabled = n === 0;
  if (loopBtn) {
    loopBtn.disabled = n === 0;
    loopBtn.classList.toggle('active', !!pb.loop);
  }
  if (pauseBtn) pauseBtn.disabled = !pb.playing;
  if (stopBtn) stopBtn.disabled = !pb.playing && !pb.video;

  // Reorder: need a selected clip that appears in the sequence
  const selIdx = findSelectedSeqIndex();
  const canReorder = n >= 2 && selIdx >= 0;
  if (moveFirst) moveFirst.disabled = !canReorder || selIdx === 0;
  if (moveLeft) moveLeft.disabled = !canReorder || selIdx === 0;
  if (moveRight) moveRight.disabled = !canReorder || selIdx >= n - 1;
  if (moveLast) moveLast.disabled = !canReorder || selIdx >= n - 1;
  if (removeBtn) removeBtn.disabled = selIdx < 0;

  if (status) {
    if (n === 0) {
      status.textContent = '\u2014';
    } else if (pb.playing) {
      const name = state.pool.sequence[pb.index]?.name || '';
      status.textContent = `\u25B6 ${pb.index + 1}/${n} ${name}`;
    } else if (pb.video && pb.video.paused) {
      status.textContent = `\u23F8 ${pb.index + 1}/${n}`;
    } else if (selIdx >= 0) {
      status.textContent = `sel ${selIdx + 1}/${n}`;
    } else {
      status.textContent = `${Math.min((pb.index || 0) + 1, n)}/${n}`;
    }
  }

  // Highlight playing token without full re-render when possible
  document.querySelectorAll('.seq-token').forEach(el => {
    const idx = parseInt(el.dataset.idx, 10);
    el.classList.toggle('playing', pb.playing && idx === pb.index);
  });
}

/** Index of the selected clip in the sequence (prefers entry id, then playback index, then path). */
function findSelectedSeqIndex() {
  const seq = state.pool.sequence;
  if (!seq.length) return -1;
  if (state.pool.selectedSeqId != null) {
    const byId = seq.findIndex(s => s.id === state.pool.selectedSeqId);
    if (byId >= 0) return byId;
  }
  const path = state.pool.selectedPath;
  if (!path) return -1;
  const pi = state.pool.playback.index;
  if (Number.isInteger(pi) && pi >= 0 && pi < seq.length && seq[pi].path === path) {
    return pi;
  }
  return seq.findIndex(s => s.path === path);
}

/**
 * Move the selected sequence entry.
 * @param {-1|1|'start'|'end'} action
 */
function moveSelectedInSequence(action) {
  const seq = state.pool.sequence;
  const from = findSelectedSeqIndex();
  if (from < 0 || seq.length < 2) return;

  let to;
  if (action === 'start') to = 0;
  else if (action === 'end') to = seq.length - 1;
  else if (action === -1 || action === 1) to = from + action;
  else return;

  to = Math.max(0, Math.min(seq.length - 1, to));
  if (to === from) return;

  const [item] = seq.splice(from, 1);
  seq.splice(to, 0, item);

  // Keep selection + playback index on the moved entry
  state.pool.selectedPath = item.path;
  state.pool.focusPath = item.path;
  state.pool.playback.index = to;

  logConsole(`[SEQ]: Moved ${item.name} ${from + 1} \u2192 ${to + 1}`);
  renderSequenceBox();
  updateSelectionHighlights();
  updateSeqTransportUI();
  updateSeqClipSettings();
  scheduleSavePoolState();
}

/** Panel: per-clip time stretch when a sequence entry is selected. */
function updateSeqClipSettings() {
  const panel = document.getElementById('seqClipSettings');
  if (!panel) return;
  const idx = findSelectedSeqIndex();
  if (idx < 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const entry = state.pool.sequence[idx];
  const nameEl = document.getElementById('seqClipName');
  const inp = document.getElementById('seqClipDuration');
  const hint = document.getElementById('seqClipDurHint');
  if (nameEl) nameEl.textContent = `${idx + 1}. ${entry.name}`;
  if (inp) {
    inp.value = entry.targetDuration != null && entry.targetDuration > 0
      ? String(entry.targetDuration)
      : '';
  }
  const meta = findPoolItem(entry.path)?.meta;
  const native = meta?.duration;
  if (hint) {
    if (entry.targetDuration != null && entry.targetDuration > 0 && native > 0) {
      const factor = entry.targetDuration / native;
      const pct = Math.round(factor * 100);
      hint.textContent = `native ${formatDurationExact(native)} \u2192 ${formatDurationExact(entry.targetDuration)} (${pct}% speed ${factor >= 1 ? 'slower' : 'faster'})`;
    } else if (native > 0) {
      hint.textContent = `native ${formatDurationExact(native)} (no stretch)`;
    } else {
      hint.textContent = 'set target length to stretch in time';
    }
  }
}

function onSeqClipDurationChange() {
  const idx = findSelectedSeqIndex();
  if (idx < 0) {
    logConsole('[SEQ]: No sequence clip selected \u2014 click a token first', 'error');
    return;
  }
  const inp = document.getElementById('seqClipDuration');
  const raw = inp?.value?.trim();
  if (!raw) {
    state.pool.sequence[idx].targetDuration = null;
  } else {
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v <= 0) {
      alert('Duration must be a positive number of seconds.');
      updateSeqClipSettings();
      return;
    }
    state.pool.sequence[idx].targetDuration = v;
    state.pool.selectedSeqId = state.pool.sequence[idx].id;
    logConsole(`[SEQ]: ${state.pool.sequence[idx].name} target time = ${v}s`);
  }
  updateSeqClipSettings();
  renderSequenceBox(); // refresh token duration labels + speed colors
  updatePoolFocusFrame(displayFocusPath()); // refresh preview timing
  // Persist immediately (don't wait for debounce \u2014 times are easy to lose)
  savePoolStateNow();
}

/** Update duration labels/colors on existing sequence tokens without full rebind. */
function applySeqTokenTimeStyles() {
  document.querySelectorAll('.seq-token').forEach(tok => {
    const idx = parseInt(tok.dataset.idx, 10);
    const entry = state.pool.sequence[idx];
    if (!entry) return;
    const speedInfo = seqClipSpeedInfo(entry);
    const durEl = tok.querySelector('.seq-token-dur');
    if (durEl) {
      durEl.textContent = speedInfo.durLabel;
      durEl.classList.toggle('timed', !!speedInfo.stretched);
      if (speedInfo.stretched && speedInfo.textColor) {
        durEl.style.color = speedInfo.textColor;
        durEl.style.fontWeight = '700';
        durEl.style.textShadow = speedInfo.textShadow || 'none';
      } else {
        durEl.style.color = '';
        durEl.style.fontWeight = '';
        durEl.style.textShadow = '';
      }
    }
    if (speedInfo.stretched && speedInfo.bgCss) {
      tok.classList.add('time-stretched');
      tok.style.background = speedInfo.bgCss;
      tok.style.borderColor = speedInfo.borderCss;
    } else {
      tok.classList.remove('time-stretched');
      tok.style.background = '';
      tok.style.borderColor = '';
    }
    tok.title = seqClipTokenTitle(entry, speedInfo);
  });
}

/**
 * Effective duration + speed color for a sequence entry.
 * speed = native/target (>1 faster \u2192 green, <1 slower \u2192 red).
 * Full green/red at 3\u00D7 / \u2153 playback rate (\u00B1300% of native).
 */
function seqClipSpeedInfo(entry) {
  const native = findPoolItem(entry.path)?.meta?.duration;
  const target = entry.targetDuration != null ? Number(entry.targetDuration) : null;
  const hasTarget = target != null && Number.isFinite(target) && target > 0;

  // Always show target time when set (even before native meta loads)
  if (hasTarget) {
    const durLabel = ` ${formatDurationExact(target)}`;
    if (!(native > 0) || Math.abs(target - native) <= 0.001) {
      // target set but equal to native, or native unknown \u2014 still show target
      if (native > 0 && Math.abs(target - native) <= 0.001) {
        return { stretched: false, durLabel: ` ${formatDurationExact(native)}`, speed: 1, tint: 0 };
      }
      // unknown native: show target, mild amber until we can score
      if (!(native > 0)) {
        return {
          stretched: true,
          durLabel,
          speed: 1,
          tint: 0,
          textColor: '#fbbf24',
          textShadow: '0 0 6px rgba(251,191,36,0.45)',
          bgCss: 'rgba(251, 191, 36, 0.12)',
          borderCss: 'rgba(251, 191, 36, 0.4)',
        };
      }
    }

    const speed = native / target; // >1 faster
    let t = Math.log(speed) / Math.log(3); // -1 @ \u2153, 0 @ 1, +1 @ 3\u00D7
    t = Math.max(-1, Math.min(1, t));
    const abs = Math.abs(t);

    // High-contrast text colors for the duration digits
    let textColor, textShadow;
    if (t >= 0) {
      // faster \u2192 green #34d399 \u2192 #6ee7b7
      const g = Math.round(180 + 50 * abs);
      textColor = `rgb(${Math.round(52 * (1 - abs))}, ${g}, ${Math.round(120 + 60 * abs)})`;
      textShadow = `0 0 ${4 + 6 * abs}px rgba(16, 185, 129, ${0.35 + 0.45 * abs})`;
    } else {
      // slower \u2192 red #f87171 \u2192 #fca5a5
      textColor = `rgb(${Math.round(200 + 55 * abs)}, ${Math.round(80 * (1 - abs * 0.5))}, ${Math.round(80 * (1 - abs * 0.5))})`;
      textShadow = `0 0 ${4 + 6 * abs}px rgba(239, 68, 68, ${0.35 + 0.45 * abs})`;
    }

    const alpha = 0.1 + 0.35 * abs;
    const borderA = 0.3 + 0.5 * abs;
    let r, g, b;
    if (t >= 0) {
      r = Math.round(16 + (16 - 40) * 0 + 40 * (1 - abs)); r = Math.round(40 + (16 - 40) * abs);
      g = Math.round(44 + (185 - 44) * abs);
      b = Math.round(52 + (129 - 52) * abs);
    } else {
      r = Math.round(40 + (239 - 40) * abs);
      g = Math.round(44 + (68 - 44) * abs);
      b = Math.round(52 + (68 - 52) * abs);
    }

    return {
      stretched: true,
      durLabel,
      speed,
      tint: t,
      textColor,
      textShadow,
      bgCss: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`,
      borderCss: `rgba(${r}, ${g}, ${b}, ${borderA.toFixed(3)})`,
    };
  }

  const durLabel = native != null && native > 0 ? ` ${formatDurationExact(native)}` : '';
  return { stretched: false, durLabel, speed: 1, tint: 0 };
}

function seqClipTokenTitle(entry, speedInfo) {
  const native = findPoolItem(entry.path)?.meta?.duration;
  let t = entry.path;
  if (speedInfo.stretched && native != null) {
    const pct = Math.round(speedInfo.speed * 100);
    t += `\nnative ${formatDurationExact(native)} \u2192 ${formatDurationExact(entry.targetDuration)} (${pct}% speed)`;
  } else if (native != null) {
    t += `\nnative ${formatDurationExact(native)}`;
  }
  return t;
}

function _detachPlaybackVideo() {
  const v = state.pool.playback.video;
  if (v) {
    v.onended = null;
    v.onerror = null;
    v.onplay = null;
    v.onpause = null;
    try { v.pause(); } catch (_) { /* ignore */ }
  }
  state.pool.playback.video = null;
}

function seqLoadClip(index, { autoplay = true } = {}) {
  const seq = state.pool.sequence;
  if (!seq.length) return null;
  index = Math.max(0, Math.min(index, seq.length - 1));
  state.pool.playback.index = index;
  const entry = seq[index];
  if (!entry) return null;

  // Select this clip in library + sequence (sticky), then play
  state.pool.playback.index = index;
  selectPoolItem(entry.path);

  // Build player in the main media viewer
  const filePath = entry.path;
  const filename = entry.name || basename(filePath);
  elements.mediaName.textContent = filename;
  elements.mediaPath.textContent = filePath;
  elements.mediaInfo.style.display = 'flex';
  elements.mediaViewer.innerHTML = '';
  clearPreviewAspect();

  const video = document.createElement('video');
  video.src = `/api/video?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
  video.controls = true;
  video.autoplay = autoplay;
  video.muted = false;
  video.playsInline = true;
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'contain';
  video.addEventListener('loadedmetadata', () => {
    if (video.videoWidth && video.videoHeight) {
      setPreviewAspect(video.videoWidth, video.videoHeight);
    }
  });
  const poolItem = findPoolItem(filePath);
  if (poolItem?.meta?.width && poolItem?.meta?.height) {
    setPreviewAspect(poolItem.meta.width, poolItem.meta.height);
  }

  _detachPlaybackVideo();
  state.pool.playback.video = video;

  video.onended = () => {
    if (!state.pool.playback.playing) return;
    const next = state.pool.playback.index + 1;
    if (next < state.pool.sequence.length) {
      seqLoadClip(next, { autoplay: true });
      updateSeqTransportUI();
      renderSequenceBox();
    } else if (state.pool.playback.loop) {
      seqLoadClip(0, { autoplay: true });
      updateSeqTransportUI();
      renderSequenceBox();
    } else {
      state.pool.playback.playing = false;
      updateSeqTransportUI();
      logConsole('[SEQ PLAY]: Finished');
    }
  };

  video.onerror = () => {
    logConsole(`[SEQ PLAY]: Failed to load ${filePath}`, 'error');
    // Skip to next if playing
    if (state.pool.playback.playing) {
      const next = state.pool.playback.index + 1;
      if (next < state.pool.sequence.length) {
        seqLoadClip(next, { autoplay: true });
      } else {
        state.pool.playback.playing = false;
      }
      updateSeqTransportUI();
    }
  };

  video.onplay = () => {
    state.pool.playback.playing = true;
    updateSeqTransportUI();
  };
  video.onpause = () => {
    // Don't mark stopped on brief seeks; only if user paused
    if (video.ended) return;
    if (!video.seeking) {
      // keep playing=true only if we'll auto-advance? User pause should pause sequence
      // Check if still the active video
      if (state.pool.playback.video === video && !video.ended) {
        // leave playing flag; pause button state via video.paused
        updateSeqTransportUI();
      }
    }
  };

  elements.mediaViewer.appendChild(video);
  if (autoplay) {
    state.pool.playback.playing = true;
    video.play().catch(err => {
      logConsole(`[SEQ PLAY]: autoplay blocked — ${err.message}. Click play on the video.`);
      state.pool.playback.playing = false;
      updateSeqTransportUI();
    });
  }
  updateSeqTransportUI();
  return video;
}

function seqPlay() {
  if (state.pool.sequence.length === 0) return;
  const pb = state.pool.playback;
  // Resume paused current video if still loaded
  if (pb.video && !pb.video.ended && pb.video.paused && pb.video.src) {
    pb.playing = true;
    pb.video.play().catch(() => {});
    updateSeqTransportUI();
    return;
  }
  const startIdx = Math.min(pb.index || 0, state.pool.sequence.length - 1);
  logConsole(`[SEQ PLAY]: Starting at clip ${startIdx + 1}/${state.pool.sequence.length}`);
  seqLoadClip(startIdx, { autoplay: true });
  renderSequenceBox();
}

function seqPause() {
  const v = state.pool.playback.video;
  if (v && !v.paused) {
    v.pause();
    state.pool.playback.playing = false;
    updateSeqTransportUI();
    logConsole('[SEQ PLAY]: Paused');
  }
}

function seqStop() {
  _detachPlaybackVideo();
  state.pool.playback.playing = false;
  state.pool.playback.index = 0;
  updateSeqTransportUI();
  // Clear playing highlight
  document.querySelectorAll('.seq-token.playing').forEach(el => el.classList.remove('playing'));
  logConsole('[SEQ PLAY]: Stopped');
}

function seqPrev() {
  if (state.pool.sequence.length === 0) return;
  const idx = Math.max(0, (state.pool.playback.index || 0) - 1);
  const wasPlaying = state.pool.playback.playing;
  seqLoadClip(idx, { autoplay: wasPlaying });
  if (!wasPlaying) state.pool.playback.playing = false;
  renderSequenceBox();
}

function seqNext() {
  if (state.pool.sequence.length === 0) return;
  const idx = Math.min(state.pool.sequence.length - 1, (state.pool.playback.index || 0) + 1);
  const wasPlaying = state.pool.playback.playing;
  seqLoadClip(idx, { autoplay: wasPlaying });
  if (!wasPlaying) state.pool.playback.playing = false;
  renderSequenceBox();
}

export {
  findPoolItem,
  displayFocusPath,
  setPoolHover,
  clearPoolHover,
  setPoolFocus,
  updateSelectionHighlights,
  updatePoolFocusFrame,
  setupSequenceDropZone,
  addPathToSequence,
  removeSequenceAt,
  clearSequence,
  renderSequenceBox,
  updateSeqTransportUI,
  findSelectedSeqIndex,
  moveSelectedInSequence,
  updateSeqClipSettings,
  onSeqClipDurationChange,
  applySeqTokenTimeStyles,
  seqClipSpeedInfo,
  seqClipTokenTitle,
  _detachPlaybackVideo,
  seqLoadClip,
  seqPlay,
  seqPause,
  seqStop,
  seqPrev,
  seqNext,
};
