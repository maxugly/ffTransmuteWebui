// Extracted from pool/sequence.js — see sequence.js barrel. Vanilla ES6, no framework.
import { state, elements, logConsole, setPreviewAspect, clearPreviewAspect } from '/app.js';
import { selectPoolItem } from '/js/pool/items.js';
import { basename, formatDurationExact } from '/js/utils.js';
import { scheduleSavePoolState } from '/js/pool/persistence.js';
import { registerListKeys } from '/js/ui/list-keys.js';
import { findPoolItem, updateSeqTotalTime } from '/js/pool/sequence-model.js';
import { updateSelectionHighlights, displayFocusPath, updatePoolFocusFrame } from '/js/pool/sequence-select.js';
import { _maybeAutoRifeEntry } from '/js/pool/sequence-rife.js';
import { renderSequenceBox } from '/js/pool/sequence-composer.js';

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
    state.pool.sequence[idx]._hadTarget = true;
    state.pool.selectedSeqId = state.pool.sequence[idx].id;
    logConsole(`[SEQ]: ${state.pool.sequence[idx].name} target time = ${v}s`);
  }
  updateSeqClipSettings();
  renderSequenceBox({ skipInstantKick: true }); // refresh token duration labels + speed colors
  applySeqTokenTimeStyles(); // live-update video playbackRate for active preview / sequence player
  updatePoolFocusFrame(displayFocusPath()); // refresh preview timing
  // Persist immediately (don't wait for debounce — times are easy to lose)
  savePoolStateNow();
  const entry = state.pool.sequence[idx];
  if (entry) {
    // Keep 'done' + variant so we only re-RIFE when M must increase.
    // Clear failed so a Time edit can retry once (no tight auto-retry loop).
    if (entry._rifeStatus === 'failed') {
      entry._rifeStatus = null;
      entry._rifeError = null;
    } else if (entry._rifeStatus !== 'done' || !entry.variantPath) {
      entry._rifeStatus = null;
      entry._rifeError = null;
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
      durEl.classList.toggle('timed', !!speedInfo.stretched || !!speedInfo.hadTarget);
      if (speedInfo.stretched && speedInfo.textColor) {
        durEl.style.color = speedInfo.textColor;
        durEl.style.fontWeight = '700';
        durEl.style.textShadow = speedInfo.textShadow || 'none';
      } else if (speedInfo.hadTarget) {
        durEl.style.color = 'rgba(251, 191, 36, 0.75)';
        durEl.style.fontWeight = '600';
        durEl.style.textShadow = 'none';
      } else {
        durEl.style.color = '';
        durEl.style.fontWeight = '';
        durEl.style.textShadow = '';
      }
    }
    if (speedInfo.stretched && speedInfo.bgCss) {
      tok.classList.add('time-stretched');
      tok.classList.remove('was-stretched');
      tok.style.background = speedInfo.bgCss;
      tok.style.borderColor = speedInfo.borderCss;
    } else if (speedInfo.hadTarget) {
      tok.classList.remove('time-stretched');
      tok.classList.add('was-stretched');
      tok.style.background = '';
      tok.style.borderColor = '';
    } else {
      tok.classList.remove('time-stretched');
      tok.classList.remove('was-stretched');
      tok.style.background = '';
      tok.style.borderColor = '';
    }
    tok.title = seqClipTokenTitle(entry, speedInfo);

    // LIVE UPDATE: push new speed to every visible video for this clip.
    // playback.video is the authoritative sequence-player element, but the
    // static preview (showPreview) may have replaced #mediaViewer with a
    // different <video> while playback.video still points at the old one.
    const previewVid = elements.mediaViewer.querySelector('video');
    if (state.pool.playback.index === idx && state.pool.playback.video) {
      state.pool.playback.video.defaultPlaybackRate = speedInfo.speed;
      state.pool.playback.video.playbackRate = speedInfo.speed;
      if (previewVid && previewVid !== state.pool.playback.video) {
        previewVid.defaultPlaybackRate = speedInfo.speed;
        previewVid.playbackRate = speedInfo.speed;
      }
    } else if (state.pool.selectedSeqId === entry.id && previewVid) {
      previewVid.defaultPlaybackRate = speedInfo.speed;
      previewVid.playbackRate = speedInfo.speed;
    }
  });
  updateSeqTotalTime();
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
  const hadTarget = !!entry._hadTarget;
  if (hasTarget) {
    const durLabel = ` ${formatDurationExact(target)}`;
    if (!(native > 0) || Math.abs(target - native) <= 0.001) {
      // target set but equal to native, or native unknown \u2014 still show target
      if (native > 0 && Math.abs(target - native) <= 0.001) {
        return { stretched: false, durLabel: ` ${formatDurationExact(native)}`, speed: 1, tint: 0, hadTarget };
      }
      // unknown native: show target, mild amber until we can score
      if (!(native > 0)) {
        return {
          stretched: true,
          durLabel,
          speed: 1,
          tint: 0,
          hadTarget,
          textColor: '#fbbf24',
          textShadow: '0 0 6px rgba(251,191,36,0.45)',
          bgCss: 'rgba(251, 191, 36, 0.12)',
          borderCss: 'rgba(251, 191, 36, 0.4)',
        };
      }
    }

    const speed = native / target; // >1 faster
    const logSpeed = Math.log(speed);
    const log3 = Math.log(3);
    const shaped = Math.sign(logSpeed) * Math.pow(Math.abs(logSpeed) / log3, 0.35);
    let t = Math.max(-1, Math.min(1, shaped));
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

    const alpha = 0.2 + 0.3 * abs;
    const borderA = 0.4 + 0.5 * abs;
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
      hadTarget,
      textColor,
      textShadow,
      bgCss: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`,
      borderCss: `rgba(${r}, ${g}, ${b}, ${borderA.toFixed(3)})`,
    };
  }

  const durLabel = native != null && native > 0 ? ` ${formatDurationExact(native)}` : '';
  return { stretched: false, durLabel, speed: 1, tint: 0, hadTarget };
}

function seqClipTokenTitle(entry, speedInfo) {
  const native = findPoolItem(entry.path)?.meta?.duration;
  let t = entry.path;
  if (speedInfo.stretched && native != null) {
    const pct = Math.round(speedInfo.speed * 100);
    t += `\nnative ${formatDurationExact(native)} → ${formatDurationExact(entry.targetDuration)} (${pct}% speed)`;
  } else if (entry._hadTarget && native != null) {
    t += `\nnative ${formatDurationExact(native)} (target was set)`;
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

  const speedInfo = seqClipSpeedInfo(entry);
  video.defaultPlaybackRate = speedInfo.speed;
  video.playbackRate = speedInfo.speed;

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

export { updateSeqTransportUI, findSelectedSeqIndex, moveSelectedInSequence, updateSeqClipSettings, onSeqClipDurationChange, applySeqTokenTimeStyles, seqClipSpeedInfo, seqClipTokenTitle, _detachPlaybackVideo, seqLoadClip, seqPlay, seqPause, seqStop, seqPrev, seqNext };
