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
import {
  runOpWithCancel, onStopRequest, isMainJobBusy,
  setClientBusy, clearClientBusy,
} from '/js/job-control.js';

// ── Sequence composer ─────────────────────────────────────────────────────

function findPoolItem(path) {
  return state.pool.items.find(i => i.path === path) || null;
}

function _getNativeMeta(path) {
  const item = findPoolItem(path);
  return item?.meta || null;
}

function _timeFactor(targetDuration, nativeDuration) {
  if (!targetDuration || nativeDuration <= 0.001) return 1.0;
  const factor = targetDuration / nativeDuration;
  return factor > 0 ? factor : 1.0;
}

/**
 * Content frame density after temporal stretch (spec §2).
 * Slow-mo (req > native) *lowers* effective fps → more likely to need RIFE.
 *   eff = native_fps × (native_dur / req_dur) = native_fps / stretch
 */
function _effectiveContentFps(nativeFps, nativeDur, reqDur) {
  const fps = Number(nativeFps) || 0;
  if (fps <= 0) return 0;
  if (reqDur == null || !(reqDur > 0) || !(nativeDur > 0.001)) return fps;
  const stretch = reqDur / nativeDur;
  if (!(stretch > 0)) return fps;
  return fps / stretch;
}

/** Target FPS for need-RIFE: explicit pool setting, else max native in sequence. */
function _resolvedTargetFps() {
  const t = state.pool.targetFps;
  if (t != null && t > 0) return t;
  let max = 0;
  for (const e of state.pool.sequence || []) {
    const m = _getNativeMeta(e.path);
    if (m?.fps > 0) max = Math.max(max, m.fps);
  }
  return max > 0 ? max : null;
}

/**
 * @returns {null | { needed: true, effFps, targetFps, multiplier, nativeFps, stretch, reason? }}
 *          or { needed: false, reason } when we can explain a skip
 */
function _rifeInfoForEntry(entry) {
  if (!state.pool.useRife) return { needed: false, reason: 'RIFE interpolate off' };

  const targetFps = _resolvedTargetFps();
  if (!targetFps) {
    return { needed: false, reason: 'no target fps (set RIFE fps or load clip meta)' };
  }

  const meta = _getNativeMeta(entry.path);
  if (!meta?.fps) {
    return { needed: false, reason: 'clip meta missing fps (wait for probe)' };
  }
  if (!meta?.duration) {
    return { needed: false, reason: 'clip meta missing duration' };
  }

  const nativeFps = meta.fps;
  const reqDur = entry.targetDuration;
  const stretch = _timeFactor(reqDur, meta.duration);
  const effFps = _effectiveContentFps(nativeFps, meta.duration, reqDur);

  if (effFps >= targetFps - 0.01) {
    return {
      needed: false,
      reason: `dense enough (${effFps.toFixed(1)} ≥ ${targetFps} fps)`,
      effFps,
      targetFps,
      nativeFps,
      stretch,
    };
  }

  let m = 1;
  while (m < targetFps / Math.max(effFps, 1e-6)) m *= 2;
  m = Math.max(m, 2);
  if (m > 128) m = 128;

  return {
    needed: true,
    effFps,
    targetFps,
    multiplier: m,
    nativeFps,
    stretch,
  };
}

/**
 * Instant RIFE client queue — one job at a time via runOpWithCancel so:
 *  - Run button shows busy elapsed + Stop works (same as any op)
 *  - Nothing else can start while the batch drains
 *  - Stop cancels the current encode and drops the rest of the queue
 * No frame-count skip: long clips are allowed (they just take longer).
 */
const _instantRifeQueue = []; // { entryId, path, name, multiplier, effFps, targetFps, stretch }
let _instantRifeDraining = false;
let _instantRifeStop = false;
let _instantRifeStopHookBound = false;

function _bindInstantRifeStopHook() {
  if (_instantRifeStopHookBound) return;
  _instantRifeStopHookBound = true;
  onStopRequest(() => {
    if (!_instantRifeDraining && _instantRifeQueue.length === 0) return;
    _instantRifeStop = true;
    const dropped = _instantRifeQueue.splice(0);
    for (const job of dropped) {
      const entry = state.pool.sequence.find((e) => e.id === job.entryId);
      if (entry && entry._rifeStatus === 'pending') {
        entry._rifeStatus = null;
      }
    }
    if (dropped.length) {
      logConsole(`[SEQ RIFE]: Stop — dropped ${dropped.length} queued job(s)`);
      renderSequenceBox();
    }
  });
}

function _findQueuedRife(entryId) {
  return _instantRifeQueue.find((j) => j.entryId === entryId) || null;
}

function _queueInstantRife(entry, info) {
  _bindInstantRifeStopHook();

  // Already denser than needed
  if (entry._rifeStatus === 'done' && entry.variantPath) {
    const prevM = entry._rifeMultiplier || 0;
    if (prevM >= info.multiplier) return false;
  }
  if (entry._rifeStatus === 'running') return false;

  const existing = _findQueuedRife(entry.id);
  if (existing) {
    if (info.multiplier > existing.multiplier) {
      existing.multiplier = info.multiplier;
      existing.effFps = info.effFps;
      existing.targetFps = info.targetFps;
      existing.stretch = info.stretch;
      logConsole(
        `[SEQ RIFE]: queue update ${entry.name} → ×${info.multiplier}`,
      );
    }
    return true;
  }

  entry._rifeStatus = 'pending';
  _instantRifeQueue.push({
    entryId: entry.id,
    path: entry.path,
    name: entry.name,
    multiplier: info.multiplier,
    effFps: info.effFps,
    targetFps: info.targetFps,
    stretch: info.stretch,
  });
  logConsole(
    `[SEQ RIFE]: queued ${entry.name} — ×${info.multiplier} `
    + `(content ${info.effFps.toFixed(1)} → ${info.targetFps} fps`
    + (info.stretch > 1.001 ? `, ${info.stretch.toFixed(2)}× slower` : '')
    + (info.stretch < 0.999 ? `, ${info.stretch.toFixed(2)}× faster` : '')
    + `) · queue depth ${_instantRifeQueue.length}`,
  );
  renderSequenceBox();
  _drainInstantRifeQueue();
  return true;
}

async function _drainInstantRifeQueue() {
  if (_instantRifeDraining) return;
  _instantRifeDraining = true;
  _instantRifeStop = false;
  _bindInstantRifeStopHook();
  // Hold main busy for the whole batch (between encodes too) so Stop works and
  // nothing else (Run / Stitch / other Instant) can sneak in.
  setClientBusy(`Instant RIFE queue (${_instantRifeQueue.length})`);

  try {
    while (_instantRifeQueue.length > 0 && !_instantRifeStop) {
      const job = _instantRifeQueue.shift();
      const entry = state.pool.sequence.find((e) => e.id === job.entryId);
      if (!entry) continue;

      // Re-check need (user may have cleared stretch while queued)
      const info = _rifeInfoForEntry(entry);
      if (!info?.needed) {
        entry._rifeStatus = entry.variantPath ? 'done' : null;
        logConsole(`[SEQ RIFE]: skip ${job.name} — no longer needed`);
        renderSequenceBox();
        setClientBusy(
          _instantRifeQueue.length
            ? `Instant RIFE queue (${_instantRifeQueue.length})`
            : 'Instant RIFE…',
        );
        continue;
      }
      if (entry._rifeStatus === 'done' && entry.variantPath
          && (entry._rifeMultiplier || 0) >= info.multiplier) {
        continue;
      }

      const remaining = _instantRifeQueue.length;
      const label = remaining > 0
        ? `Instant RIFE ×${info.multiplier} · ${entry.name} (+${remaining} queued)`
        : `Instant RIFE ×${info.multiplier} · ${entry.name}`;
      setClientBusy(label);

      entry._rifeStatus = 'running';
      renderSequenceBox();
      logConsole(`[SEQ RIFE]: start ${entry.name} — ×${info.multiplier} (${remaining} more in queue)`);

      try {
        const body = {
          input_path: entry.path,
          multiplier: info.multiplier,
          // Native×M timeline; join setpts applies stretch
          target_fps: null,
          register_as_variant: true,
          dry_run: false,
        };
        // allowDuringClientBusy: we hold the batch lock ourselves
        const data = await runOpWithCancel('rife', body, {
          label,
          allowDuringClientBusy: true,
        });

        if (_instantRifeStop || (data && data.error === 'Cancelled by user')) {
          entry._rifeStatus = null;
          logConsole(`[SEQ RIFE]: stopped on ${entry.name}`, 'error');
          const dropped = _instantRifeQueue.splice(0);
          for (const j of dropped) {
            const e = state.pool.sequence.find((x) => x.id === j.entryId);
            if (e && e._rifeStatus === 'pending') e._rifeStatus = null;
          }
          if (dropped.length) {
            logConsole(`[SEQ RIFE]: cleared ${dropped.length} remaining queued job(s)`);
          }
          break;
        }

        if (data && data.ok) {
          entry._rifeStatus = 'done';
          entry.variantPath = data.output_path || entry.variantPath;
          entry._rifeMultiplier = info.multiplier;
          logConsole(
            `[SEQ RIFE]: done ${entry.name} → ${basename(entry.variantPath || entry.path)}`,
          );
        } else {
          entry._rifeStatus = null;
          logConsole(
            `[SEQ RIFE]: failed ${entry.name} — ${(data && data.error) || 'unknown'}`,
            'error',
          );
        }
      } catch (err) {
        entry._rifeStatus = null;
        if (_instantRifeStop || /already running|Cancelled/i.test(err.message || '')) {
          logConsole(`[SEQ RIFE]: aborted — ${err.message}`, 'error');
          _instantRifeQueue.splice(0);
          break;
        }
        logConsole(`[SEQ RIFE]: error ${entry.name} — ${err.message}`, 'error');
      }
      renderSequenceBox();
      scheduleSavePoolState();
      if (_instantRifeQueue.length && !_instantRifeStop) {
        setClientBusy(`Instant RIFE queue (${_instantRifeQueue.length})`);
      }
    }
  } finally {
    _instantRifeDraining = false;
    clearClientBusy();
    if (_instantRifeStop) {
      _instantRifeStop = false;
      for (const e of state.pool.sequence) {
        if (e._rifeStatus === 'pending' || e._rifeStatus === 'running') {
          e._rifeStatus = null;
        }
      }
    }
    renderSequenceBox();
    scheduleSavePoolState();
  }
}

/** Enqueue Instant RIFE for one sequence entry (if needed). Non-blocking. */
function _maybeAutoRifeEntry(entry, { quiet = false } = {}) {
  if (!state.pool.instantRife) return;
  if (!state.pool.useRife) return;

  const info = _rifeInfoForEntry(entry);
  if (!info?.needed) {
    if (entry._rifeStatus === 'done' && entry.variantPath) {
      // keep
    } else if (entry._rifeStatus !== 'running' && entry._rifeStatus !== 'pending') {
      entry._rifeStatus = null;
      renderSequenceBox();
    }
    if (!quiet && info?.reason && state.pool.useRife) {
      logConsole(`[SEQ RIFE]: ${entry.name} — ${info.reason}`);
    }
    return;
  }

  _queueInstantRife(entry, info);
}

function _maybeAutoRifeAll({ quiet = true } = {}) {
  if (!state.pool.instantRife) return;
  if (!state.pool.useRife) {
    logConsole('[SEQ RIFE]: Instant on but RIFE interpolate is off — enable both');
    return;
  }
  const target = _resolvedTargetFps();
  if (!target) {
    logConsole('[SEQ RIFE]: no target fps yet — set “RIFE fps” or wait for clip probes');
    return;
  }
  logConsole(`[SEQ RIFE]: scan ${state.pool.sequence.length} clip(s) @ target ${target} fps`);
  for (const entry of state.pool.sequence) {
    _maybeAutoRifeEntry(entry, { quiet });
  }
}

function _maybeAutoRifeForPath(path) {
  if (!state.pool.instantRife) return;
  for (const entry of state.pool.sequence) {
    if (entry.path === path) {
      _maybeAutoRifeEntry(entry);
    }
  }
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
    variantPath: (state.pool.selectedVariantPaths || {})[path] || null,
    _rifeStatus: null, // null | 'pending' | 'running' | 'done' | 'skipped'
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
  refreshPoolToolbarCounts();
  updateSeqTransportUI();
  scheduleSavePoolState();
  _maybeAutoRifeEntry(entry);
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
      <button type="button" class="seq-token-var" title="Choose variant" data-variant-path="${escapeHtml(entry.variantPath || '')}">V</button>
      <span class="seq-token-rife-status" data-status="${entry._rifeStatus || ''}"></span>
      <button type="button" class="seq-token-x" title="Remove">&cross;</button>
    `;

    // RIFE status indicator (pending = queued, running = main job)
    const rifeStatusEl = tok.querySelector('.seq-token-rife-status');
    if (rifeStatusEl && entry._rifeStatus) {
      const qIdx = _instantRifeQueue.findIndex((j) => j.entryId === entry.id);
      rifeStatusEl.textContent = entry._rifeStatus === 'pending'
        ? (qIdx >= 0 ? `#${qIdx + 1}` : '…')
        : entry._rifeStatus === 'running' ? '↻'
          : entry._rifeStatus === 'done' ? '✓'
            : entry._rifeStatus === 'skipped' ? '—' : '';
      rifeStatusEl.title = entry._rifeStatus === 'pending'
        ? (qIdx >= 0 ? `Queued #${qIdx + 1} for Instant RIFE` : 'Queued for Instant RIFE')
        : entry._rifeStatus === 'running'
          ? 'RIFE running — use main Stop to cancel batch'
          : entry._rifeStatus === 'done' ? 'RIFE variant ready' : '';
      rifeStatusEl.className = `seq-token-rife-status seq-rife-${entry._rifeStatus}`;
    }

    // RIFE needed badge (content density after stretch vs target)
    const rifeInfo = _rifeInfoForEntry(entry);
    if (rifeInfo?.needed) {
      tok.classList.add('seq-rife-needed');
      const rifeBadge = document.createElement('span');
      rifeBadge.className = 'seq-rife-badge';
      const stretchNote = rifeInfo.stretch > 1.001
        ? ` · ${rifeInfo.stretch.toFixed(2)}× slower`
        : rifeInfo.stretch < 0.999
          ? ` · ${rifeInfo.stretch.toFixed(2)}× faster`
          : '';
      rifeBadge.title =
        `RIFE ×${rifeInfo.multiplier} — content ${rifeInfo.effFps.toFixed(1)} fps`
        + ` → target ${rifeInfo.targetFps}${stretchNote}`;
      rifeBadge.textContent = `R${rifeInfo.multiplier}`;
      tok.appendChild(rifeBadge);
    }

    // Variant picker
    const varBtn = tok.querySelector('.seq-token-var');
    if (varBtn) {
      varBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const currentPath = entry.variantPath || entry.path;
        const variants = await _fetchVariants(entry.path);
        _showSeqVariantMenu(varBtn, entry, variants, currentPath);
      });
    }

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

  // Update variant count badges asynchronously
  _updateSeqVariantBadges();

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
  // Persist immediately (don't wait for debounce — times are easy to lose)
  savePoolStateNow();
  const entry = state.pool.sequence[idx];
  if (entry) {
    // Keep 'done' so we only re-RIFE when multiplier must increase
    if (entry._rifeStatus !== 'done' || !entry.variantPath) {
      entry._rifeStatus = null;
    }
    _maybeAutoRifeEntry(entry, { quiet: false });
  }
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

// Horizontal sequence: arrows select; Ctrl+arrows reorder (list-keys).
import { registerListKeys } from '/js/ui/list-keys.js';

function _seqScrollSelected() {
  const el = document.querySelector('.seq-token.selected, .seq-token.focused, .seq-token.playing');
  if (el && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }
}

const _seqListApi = {
  getItems: () => state.pool.sequence || [],
  getSelected: () => findSelectedSeqIndex(),
  setSelected: (i) => {
    const seq = state.pool.sequence || [];
    if (i < 0 || i >= seq.length) return;
    const entry = seq[i];
    state.pool.selectedSeqId = entry.id;
    state.pool.selectedPath = entry.path;
    state.pool.focusPath = entry.path;
    try { selectPoolItem(entry.path); } catch (_) { /* ignore */ }
    renderSequenceBox();
    updateSeqClipSettings();
    updateSelectionHighlights();
    _seqScrollSelected();
  },
  moveItem: (from, to) => {
    const seq = state.pool.sequence || [];
    if (from < 0 || to < 0 || from >= seq.length || to >= seq.length) return;
    const [item] = seq.splice(from, 1);
    seq.splice(to, 0, item);
    state.pool.selectedSeqId = item.id;
    state.pool.selectedPath = item.path;
    state.pool.focusPath = item.path;
    state.pool.playback.index = to;
    logConsole(`[SEQ]: Moved ${item.name} ${from + 1} → ${to + 1}`);
    renderSequenceBox();
    updateSelectionHighlights();
    updateSeqTransportUI();
    updateSeqClipSettings();
    scheduleSavePoolState();
    _seqScrollSelected();
  },
  scrollSelectedIntoView: _seqScrollSelected,
};

// Same strip lives on Video Pool + Sequence tabs
registerListKeys('sequence', _seqListApi);
registerListKeys('pool', _seqListApi);

// ── Per-clip variant picker ─────────────────────────────────────────────

async function _fetchVariants(path) {
  try {
    const res = await fetch(`/api/variants?path=${encodeURIComponent(path)}`);
    if (!res.ok) return {};
    const data = await res.json();
    return data.variants || {};
  } catch {
    return {};
  }
}

function _showSeqVariantMenu(anchor, entry, variants, currentPath) {
  document.querySelectorAll('.seq-variant-menu').forEach(el => el.remove());
  const menu = document.createElement('div');
  menu.className = 'seq-variant-menu pool-context-menu';

  const makeRow = (vPath, kind, detail) => {
    const selected = currentPath === vPath;
    const label = vPath === entry.path
      ? 'Original'
      : `${kind}${detail ? ' · ' + Object.entries(detail).map(([k,val]) => `${k}=${val}`).join(' · ') : ''}`;
    return `<button type="button" class="seq-var-opt${selected ? ' selected' : ''}" data-vpath="${escapeHtml(vPath)}">${escapeHtml(label)}</button>`;
  };

  let rows = makeRow(entry.path, 'original', null);
  for (const [kind, entries] of Object.entries(variants)) {
    for (const v of entries) {
      if (v.path) rows += makeRow(v.path, kind, v.detail || null);
    }
  }

  menu.innerHTML = rows;
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.zIndex = '10000';
  document.body.appendChild(menu);

  const close = () => {
    menu.remove();
    document.removeEventListener('click', close, true);
  };
  menu.querySelectorAll('.seq-var-opt').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const vp = btn.dataset.vpath;
      const idx = state.pool.sequence.findIndex(s => s.id === entry.id);
      if (idx >= 0) {
        state.pool.sequence[idx].variantPath = vp === entry.path ? null : vp;
        scheduleSavePoolState();
        renderSequenceBox();
      }
      close();
    });
  });
  setTimeout(() => document.addEventListener('click', close, true), 0);
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
  _fetchVariants,
  _showSeqVariantMenu,
  _maybeAutoRifeAll,
  _maybeAutoRifeForPath,
};
