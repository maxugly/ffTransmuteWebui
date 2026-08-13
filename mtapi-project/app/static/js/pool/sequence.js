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
  setClientBusy, clearClientBusy, abortMainJob,
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
 * Density after time-stretch (ignores RIFE master switch — used for badges + Instant).
 * @returns {{ needed: boolean, reason?: string, effFps?: number, targetFps?: number,
 *             multiplier?: number, nativeFps?: number, stretch?: number }}
 */
function _densityInfoForEntry(entry) {
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
 * Whether Instant/join should densify this entry (density + RIFE interpolate on).
 * Honors densify on disk / in memory (haveM), even if user currently stitches ORIG.
 * Selecting a rifed path must set _rifeMultiplier or NEED stays wrong forever.
 */
function _rifeInfoForEntry(entry) {
  if (!state.pool.useRife) return { needed: false, reason: 'RIFE interpolate off' };
  const dens = _densityInfoForEntry(entry);
  if (!dens.needed) return dens;
  const haveM = _bestHaveM(entry);
  const needM = dens.multiplier || 2;
  // Known densify strength covers need (registry hydrate, menu pick, or prior encode)
  if (haveM >= needM) {
    const where = (entry.variantPath && entry.variantPath !== entry.path)
      ? basename(entry.variantPath)
      : 'on disk / registry';
    return {
      ...dens,
      needed: false,
      reason: `already densified ×${haveM} (≥ need ×${needM}): ${where}`,
      haveM,
    };
  }
  return dens;
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
let _hydrationComplete = true;
/** Currently encoding entry id (for status strip). */
let _instantRifeRunningId = null;
/**
 * After soft-abort of a running densify, re-queue this entry at a higher M.
 * Policy: keep the highest frame density we ever produce (drop frames later if needed).
 */
let _instantRifeRestart = null; // { entryId, info }

/**
 * One badge per clip describing Instant/join RIFE state. Hover title is the full story.
 * @returns {{ text: string, cls: string, title: string } | null}
 */
function _rifeBadgeForEntry(entry) {
  const useRife = !!state.pool.useRife;
  const instant = !!state.pool.instantRife;
  // Raw stretch math (for titles) + Instant-aware need (honors haveM)
  const dens = _densityInfoForEntry(entry);
  const info = useRife ? _rifeInfoForEntry(entry) : dens;
  const qIdx = _instantRifeQueue.findIndex((j) => j.entryId === entry.id);
  const st = entry._rifeStatus;
  const hasVar = !!(entry.variantPath && entry.variantPath !== entry.path);
  const mHave = _bestHaveM(entry);
  const stretchNote = (dens && dens.stretch > 1.001)
    ? `\nTime stretch: ${dens.stretch.toFixed(2)}× slower (fewer unique frames per second).`
    : (dens && dens.stretch < 0.999)
      ? `\nTime stretch: ${dens.stretch.toFixed(2)}× faster.`
      : '';

  if (st === 'running') {
    return {
      text: 'RUN',
      cls: 'seq-rife-badge is-running',
      title: [
        'STATE: RUN — Instant RIFE is encoding this clip now.',
        'Watch the main Run button (top) for elapsed time / progress.',
        'Stop (top bar) cancels this encode and drops the rest of the queue.',
        dens?.needed ? `Target density: ×${dens.multiplier} (${dens.effFps.toFixed(1)} → ${dens.targetFps} fps).` : '',
      ].filter(Boolean).join('\n'),
    };
  }

  if (st === 'pending' || qIdx >= 0) {
    const n = qIdx >= 0 ? qIdx + 1 : 1;
    return {
      text: `Q${n}`,
      cls: 'seq-rife-badge is-queued',
      title: [
        `STATE: Q${n} — waiting in Instant RIFE queue (position ${n}).`,
        'Earlier clips finish first; then this one encodes.',
        'Stop (top bar) cancels the whole queue.',
        dens?.multiplier ? `Will densify ×${dens.multiplier}.` : '',
      ].filter(Boolean).join('\n'),
    };
  }

  if (st === 'failed') {
    return {
      text: 'FAIL',
      cls: 'seq-rife-badge is-failed',
      title: [
        'STATE: FAIL — Instant RIFE failed for this clip.',
        entry._rifeError || 'See server / job result for the error.',
        'Fix the issue, then change Time or toggle Instant to retry.',
      ].join('\n'),
    };
  }

  // Waiting for probe (no badge state yet for queue)
  if (!dens?.targetFps && (useRife || instant)) {
    return {
      text: 'PROBE',
      cls: 'seq-rife-badge is-hint',
      title: [
        'STATE: PROBE — waiting for fps/duration from the server.',
        'Instant RIFE cannot densify until probe finishes (automatic).',
      ].join('\n'),
    };
  }

  // Densified enough: haveM covers need, OR rifed file selected with known/assumed M
  const needM = dens?.needed ? (dens.multiplier || 2) : 0;
  const covered = mHave > 0 && (!dens?.needed || mHave >= needM);
  const selectedRifed = hasVar && (mHave >= needM || (mHave > 0 && !dens?.needed) || (hasVar && mHave >= 2 && dens?.needed && mHave >= needM));
  if (st === 'done' || covered || (hasVar && mHave >= needM && needM > 0) || (hasVar && !dens?.needed)) {
    const label = mHave ? `OK×${mHave}` : (hasVar ? 'OK' : 'OK');
    return {
      text: label,
      cls: 'seq-rife-badge is-done',
      title: [
        'STATE: OK — densified variant is ready for stitch.',
        `Active file: ${basename(entry.variantPath || entry.path)}`,
        `Original: ${basename(entry.path)}`,
        mHave ? `Known densify strength: ×${mHave}` : '',
        dens?.needed && mHave && mHave < needM
          ? `Note: stretch wants ×${needM}; have ×${mHave} — Instant may densify further.`
          : '',
        'Click ORIG/RIFED to switch which file Stitch uses.',
      ].filter(Boolean).join('\n'),
    };
  }

  // Still needs denser frames — use Instant-aware info (false if haveM covers)
  if (info?.needed || dens?.needed) {
    // If dens needed but Instant-aware says not, show OK path already handled
    if (!info?.needed && useRife) {
      const label = mHave ? `OK×${mHave}` : 'OK';
      return {
        text: label,
        cls: 'seq-rife-badge is-done',
        title: [
          'STATE: OK — densify already covers this stretch.',
          info.reason || '',
        ].filter(Boolean).join('\n'),
      };
    }
    const m = dens.multiplier || info.multiplier;
    if (!useRife) {
      return {
        text: 'RIFE?',
        cls: 'seq-rife-badge is-hint',
        title: [
          'STATE: RIFE? — this stretch is sparse, but “RIFE interpolate” is OFF.',
          `Content ~${dens.effFps.toFixed(1)} fps after stretch; target ${dens.targetFps} fps.`,
          'Turn on Instant RIFE (enables densify) or RIFE interpolate + Stitch.',
          stretchNote.trim(),
        ].filter(Boolean).join('\n'),
      };
    }
    if (!instant) {
      return {
        text: `NEED×${m}`,
        cls: 'seq-rife-badge is-need',
        title: [
          `STATE: NEED×${m} — needs denser frames for smooth motion.`,
          `Content ~${dens.effFps.toFixed(1)} fps after stretch < target ${dens.targetFps} fps.`,
          mHave ? `Have densify ×${mHave} on file — not enough for ×${m}.` : 'No densify file recorded yet.',
          'Instant RIFE is OFF — densify runs when you Stitch.',
          'Turn Instant RIFE ON to encode now (main Run/Stop).',
          stretchNote.trim(),
        ].filter(Boolean).join('\n'),
      };
    }
    return {
      text: `NEED×${m}`,
      cls: 'seq-rife-badge is-need',
      title: [
        `STATE: NEED×${m} — will densify ×${m} (queued automatically).`,
        `Content ~${dens.effFps.toFixed(1)} fps < target ${dens.targetFps} fps.`,
        mHave ? `Have ×${mHave} — need higher.` : 'No densify on record yet.',
        stretchNote.trim(),
      ].filter(Boolean).join('\n'),
    };
  }

  return null;
}

function _ensureInstantRifeStrip() {
  const box = document.getElementById('poolSequenceBox');
  if (!box || !box.parentElement) return null;
  let strip = document.getElementById('seqInstantRifeStrip');
  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'seqInstantRifeStrip';
    strip.className = 'seq-instant-strip';
    box.parentElement.insertBefore(strip, box);
  }
  return strip;
}

function _updateInstantRifeStrip() {
  const strip = _ensureInstantRifeStrip();
  if (!strip) return;

  const useRife = !!state.pool.useRife;
  const instant = !!state.pool.instantRife;
  const q = _instantRifeQueue.length;
  const running = state.pool.sequence.find((e) => e.id === _instantRifeRunningId)
    || state.pool.sequence.find((e) => e._rifeStatus === 'running');
  const doneN = state.pool.sequence.filter(
    (e) => e._rifeStatus === 'done' || (e.variantPath && e.variantPath !== e.path),
  ).length;
  const needN = state.pool.sequence.filter((e) => {
    const d = _densityInfoForEntry(e);
    if (!d?.needed) return false;
    const mHave = e._rifeMultiplier || 0;
    // Already densified enough for this stretch
    if (e.variantPath && e.variantPath !== e.path && mHave >= (d.multiplier || 2)) return false;
    return true;
  }).length;

  let text = '';
  let title = '';
  let cls = 'seq-instant-strip';

  if (!useRife && !instant) {
    text = 'RIFE: off — turn on “RIFE interpolate” (and Instant) to densify slow clips.';
    title = 'RIFE interpolate densifies sparse clips on Stitch. Instant RIFE does it as soon as a clip needs it.';
    cls += ' is-off';
  } else if (useRife && !instant) {
    text = `RIFE: on Stitch only · Instant off · ${needN} clip(s) would need densify`;
    title = [
      'RIFE interpolate is ON: Stitch will densify sparse clips.',
      'Instant RIFE is OFF: nothing runs until you press Stitch.',
      'Badge NEED×N = this clip is sparse after time stretch.',
      'Badge OK = already has a densified variant.',
    ].join('\n');
    cls += needN ? ' is-warn' : ' is-idle';
  } else if (running) {
    text = `Instant RIFE: encoding ${running.name} · ${q} waiting · Stop cancels all`;
    title = [
      'Main Run button (top) is busy with this encode.',
      'Stop cancels the current encode and clears the queue.',
      'Token badges: RUN = encoding, Q# = waiting, NEED = still sparse, OK = done.',
    ].join('\n');
    cls += ' is-busy';
  } else if (q > 0 || _instantRifeDraining) {
    text = `Instant RIFE: queue ${q} · starting next… · Stop cancels all`;
    title = 'Queue is draining. Main Run/Stop control the batch.';
    cls += ' is-busy';
  } else if (instant) {
    text = `Instant RIFE: idle · ${needN} need densify · ${doneN} OK · badges explain on hover`;
    title = [
      'Instant is ON and nothing is encoding right now.',
      'NEED×N = sparse after stretch (should queue soon if Instant works).',
      'Q# = waiting · RUN = encoding · OK = densified · FAIL = error.',
      'ORIG/RIFED button = which file Stitch uses (hover for paths).',
    ].join('\n');
    cls += needN ? ' is-warn' : ' is-idle';
  } else {
    text = 'RIFE: —';
    cls += ' is-off';
  }

  strip.className = cls;
  strip.textContent = text;
  strip.title = title;
}

function _bindInstantRifeStopHook() {
  if (_instantRifeStopHookBound) return;
  _instantRifeStopHookBound = true;
  onStopRequest(() => {
    // User Stop — cancel restart intent and wipe queue
    _instantRifeRestart = null;
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

function _bestHaveM(entry) {
  return Math.max(0, Number(entry._rifeMultiplier) || 0);
}

/**
 * Pick densest existing rifed variant from /api/variants map.
 * @returns {{ path: string, multiplier: number } | null}
 */
function _pickBestRifed(variants) {
  const list = (variants && variants.rifed) || [];
  let best = null;
  let bestM = -1;
  for (const v of list) {
    if (!v || !v.path) continue;
    // detail.multiplier is set by register_variant; missing → treat as ×2 (legacy)
    const m = Number(v.detail && v.detail.multiplier);
    const score = Number.isFinite(m) && m >= 2 ? m : 2;
    if (score > bestM) {
      bestM = score;
      best = { path: v.path, multiplier: score };
    }
  }
  return best;
}

/**
 * Load registry densify for this source clip into entry.variantPath / _rifeMultiplier.
 * This is the memory Instant lost on reload — without it every clip is NEED forever.
 * @returns {Promise<{ path: string, multiplier: number } | null>}
 */
async function _hydrateEntryFromVariants(entry) {
  if (!entry || !entry.path) return null;
  const variants = await _fetchVariants(entry.path);
  const best = _pickBestRifed(variants);

  // Session already points at a densify file — fill missing M from registry
  if (entry.variantPath && entry.variantPath !== entry.path) {
    const list = (variants && variants.rifed) || [];
    const match = list.find((v) => v.path === entry.variantPath);
    if (match) {
      const m = Number(match.detail && match.detail.multiplier);
      entry._rifeMultiplier = Number.isFinite(m) && m >= 2 ? m : Math.max(_bestHaveM(entry), 2);
    } else if (!_bestHaveM(entry)) {
      entry._rifeMultiplier = 2;
    }
  }

  if (best) {
    const have = _bestHaveM(entry);
    if (!entry.variantPath || entry.variantPath === entry.path || best.multiplier >= have) {
      entry.variantPath = best.path;
      entry._rifeMultiplier = best.multiplier;
    }
  }

  if (entry.variantPath && entry.variantPath !== entry.path && _bestHaveM(entry) > 0) {
    const dens = _densityInfoForEntry(entry);
    const needM = dens.needed ? (dens.multiplier || 2) : 0;
    if (!dens.needed || _bestHaveM(entry) >= needM) {
      entry._rifeStatus = 'done';
      entry._rifeError = null;
    }
  }
  return best;
}

/**
 * If densify is already running for this entry at a lower M, soft-abort and
 * restart at the higher M. If in-flight M already covers need, keep it.
 */
function _maybeSupersedeRunningRife(entry, info) {
  if (entry._rifeStatus !== 'running' || _instantRifeRunningId !== entry.id) {
    return false;
  }
  const runM = entry._rifeRunningMultiplier || 0;
  const needM = info.multiplier || 2;
  if (needM <= runM) {
    logConsole(
      `[SEQ RIFE]: ${entry.name} — in-flight ×${runM} already covers need ×${needM}; keeping it`,
    );
    return true; // handled (no new queue)
  }
  // Request higher density: abort current, re-queue after cancel
  if (
    _instantRifeRestart
    && _instantRifeRestart.entryId === entry.id
    && (_instantRifeRestart.info.multiplier || 0) >= needM
  ) {
    return true; // restart already requested at least this high
  }
  _instantRifeRestart = {
    entryId: entry.id,
    info: { ...info, multiplier: needM },
  };
  logConsole(
    `[SEQ RIFE]: ${entry.name} — speed/target changed; abort ×${runM} → restart ×${needM}`,
  );
  setClientBusy(`Instant RIFE: restarting ${entry.name} at ×${needM}…`);
  abortMainJob({ soft: true, reason: `rife-restart-x${needM}` });
  return true;
}

/**
 * @param {{ skipRender?: boolean }} [opts]  skipRender=true when batching many enqueues
 * @returns {boolean} true only when queue membership or multiplier actually changed
 */
function _queueInstantRife(entry, info, opts) {
  opts = opts || {};
  _bindInstantRifeStopHook();

  const needM = info.multiplier || 2;

  // Policy: keep the densest variant we already have (can drop frames later)
  if (entry.variantPath && _bestHaveM(entry) >= needM) {
    entry._rifeStatus = 'done';
    return false;
  }

  // Do not auto-retry failures in a tight loop — user re-enables Instant or
  // changes Time / target to clear failed and re-queue.
  if (entry._rifeStatus === 'failed') {
    return false;
  }

  // Running densify for this clip — supersede if need is higher
  if (entry._rifeStatus === 'running') {
    return _maybeSupersedeRunningRife(entry, info);
  }

  const existing = _findQueuedRife(entry.id);
  if (existing) {
    if (needM > existing.multiplier) {
      existing.multiplier = needM;
      existing.effFps = info.effFps;
      existing.targetFps = info.targetFps;
      existing.stretch = info.stretch;
      logConsole(
        `[SEQ RIFE]: queue update ${entry.name} → ×${needM} (keep highest density)`,
      );
      if (!opts.skipRender) renderSequenceBox({ skipInstantKick: true });
      return true; // multiplier raised
    }
    return false; // already queued at ≥ need — no state change
  }

  entry._rifeStatus = 'pending';
  entry._rifeError = null;
  _instantRifeQueue.push({
    entryId: entry.id,
    path: entry.path,
    name: entry.name,
    multiplier: needM,
    effFps: info.effFps,
    targetFps: info.targetFps,
    stretch: info.stretch,
  });
  logConsole(
    `[SEQ RIFE]: queued ${entry.name} — ×${needM} `
    + `(content ${info.effFps.toFixed(1)} → ${info.targetFps} fps`
    + (info.stretch > 1.001 ? `, ${info.stretch.toFixed(2)}× slower` : '')
    + (info.stretch < 0.999 ? `, ${info.stretch.toFixed(2)}× faster` : '')
    + `) · queue depth ${_instantRifeQueue.length}`,
  );
  if (!opts.skipRender) renderSequenceBox({ skipInstantKick: true });
  _drainInstantRifeQueue();
  return true;
}

/**
 * Auto-enqueue every sequence clip that currently NEEDS densify.
 * Call only on real events (Instant ON, Time change, meta load, add clip) —
 * never from every renderSequenceBox (that caused an infinite re-render storm).
 * Always hydrate from /api/variants first so existing RIFED files are not re-done.
 */
async function _kickInstantRifeScan() {
  if (!state.pool.instantRife || !state.pool.useRife) return;
  if (!state.pool.sequence?.length) return;

  let changed = 0;
  let reused = 0;
  for (const entry of state.pool.sequence) {
    try {
      await _hydrateEntryFromVariants(entry);
    } catch (_) { /* ignore hydrate errors */ }
    const info = _rifeInfoForEntry(entry);
    if (!info?.needed) {
      if (entry.variantPath && entry.variantPath !== entry.path) reused += 1;
      continue;
    }
    // Only true when queue membership or M actually changes
    if (_queueInstantRife(entry, info, { skipRender: true })) changed += 1;
  }
  if (reused > 0) {
    logConsole(`[SEQ RIFE]: reusing ${reused} existing densified clip(s) — not re-encoding`);
  }
  if (changed > 0) {
    renderSequenceBox({ skipInstantKick: true });
    _drainInstantRifeQueue();
  } else {
    // Cheap strip/badge refresh only — no kick, no variant flood
    renderSequenceBox({ skipInstantKick: true });
    _updateInstantRifeStrip();
    try { scheduleSavePoolState(); } catch (_) { /* ignore */ }
  }
}

let _kickRifeTimer = null;
function _scheduleInstantRifeKick() {
  // Debounce: meta loads + duration edits often fire in bursts
  if (_kickRifeTimer != null) clearTimeout(_kickRifeTimer);
  _kickRifeTimer = setTimeout(() => {
    _kickRifeTimer = null;
    _kickInstantRifeScan().catch((e) => {
      console.error('[SEQ RIFE] kick failed', e);
    });
  }, 120);
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
        renderSequenceBox({ skipInstantKick: true });
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

      const runM = info.multiplier;
      entry._rifeStatus = 'running';
      entry._rifeError = null;
      entry._rifeRunningMultiplier = runM;
      _instantRifeRunningId = entry.id;
      renderSequenceBox({ skipInstantKick: true });
      logConsole(`[SEQ RIFE]: start ${entry.name} — ×${runM} (${remaining} more in queue)`);

      try {
        const body = {
          input_path: entry.path,
          multiplier: runM,
          // Native×M timeline; join setpts applies stretch. Keep densest; drop later if needed.
          target_fps: null,
          register_as_variant: true,
          dry_run: false,
        };
        // allowDuringClientBusy: we hold the batch lock ourselves
        const data = await runOpWithCancel('rife', body, {
          label,
          allowDuringClientBusy: true,
        });

        const cancelled = _instantRifeStop
          || (data && data.error === 'Cancelled by user');

        // Soft restart: Time/speed changed mid-encode → denser M requested
        if (cancelled && _instantRifeRestart && _instantRifeRestart.entryId === entry.id) {
          const restart = _instantRifeRestart;
          _instantRifeRestart = null;
          entry._rifeStatus = 'pending';
          entry._rifeRunningMultiplier = null;
          _instantRifeRunningId = null;
          // Front of queue so new densify runs next (keep other queued clips)
          _instantRifeQueue.unshift({
            entryId: entry.id,
            path: entry.path,
            name: entry.name,
            multiplier: restart.info.multiplier,
            effFps: restart.info.effFps,
            targetFps: restart.info.targetFps,
            stretch: restart.info.stretch,
          });
          logConsole(
            `[SEQ RIFE]: ${entry.name} — restarting densify at ×${restart.info.multiplier}`,
          );
          renderSequenceBox({ skipInstantKick: true });
          continue; // drain loop picks restart job
        }

        if (cancelled) {
          entry._rifeStatus = null;
          entry._rifeRunningMultiplier = null;
          _instantRifeRunningId = null;
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
          // Keep densest file only
          const prevM = entry._rifeMultiplier || 0;
          if (!entry.variantPath || runM >= prevM) {
            entry.variantPath = data.output_path || entry.variantPath;
            entry._rifeMultiplier = runM;
          }
          entry._rifeError = null;
          entry._rifeRunningMultiplier = null;
          _invalidateVariantsCache(entry.path);

          // If Time/target changed during the run and we need higher M, immediately re-queue
          const still = _rifeInfoForEntry(entry);
          const restartM = _instantRifeRestart?.entryId === entry.id
            ? (_instantRifeRestart.info.multiplier || 0)
            : 0;
          const wantM = Math.max(
            still?.needed ? (still.multiplier || 0) : 0,
            restartM,
          );
          _instantRifeRestart = null;

          if (wantM > (entry._rifeMultiplier || 0)) {
            entry._rifeStatus = 'pending';
            _instantRifeQueue.unshift({
              entryId: entry.id,
              path: entry.path,
              name: entry.name,
              multiplier: wantM,
              effFps: still?.effFps ?? info.effFps,
              targetFps: still?.targetFps ?? info.targetFps,
              stretch: still?.stretch ?? info.stretch,
            });
            logConsole(
              `[SEQ RIFE]: ${entry.name} — finished ×${entry._rifeMultiplier} but need ×${wantM}; re-queuing denser pass`,
            );
            renderSequenceBox({ skipInstantKick: true });
            continue;
          }

          entry._rifeStatus = 'done';
          logConsole(
            `[SEQ RIFE]: done ${entry.name} → ${basename(entry.variantPath || entry.path)} (×${entry._rifeMultiplier})`,
          );
        } else {
          entry._rifeStatus = 'failed';
          entry._rifeError = (data && data.error) || 'unknown error';
          entry._rifeRunningMultiplier = null;
          logConsole(
            `[SEQ RIFE]: failed ${entry.name} — ${entry._rifeError}`,
            'error',
          );
        }
      } catch (err) {
        // Soft restart via abort may throw AbortError
        if (_instantRifeRestart && _instantRifeRestart.entryId === entry.id) {
          const restart = _instantRifeRestart;
          _instantRifeRestart = null;
          entry._rifeStatus = 'pending';
          entry._rifeRunningMultiplier = null;
          _instantRifeRunningId = null;
          _instantRifeQueue.unshift({
            entryId: entry.id,
            path: entry.path,
            name: entry.name,
            multiplier: restart.info.multiplier,
            effFps: restart.info.effFps,
            targetFps: restart.info.targetFps,
            stretch: restart.info.stretch,
          });
          logConsole(
            `[SEQ RIFE]: ${entry.name} — restarting densify at ×${restart.info.multiplier}`,
          );
          renderSequenceBox({ skipInstantKick: true });
          continue;
        }
        if (_instantRifeStop || /already running|Cancelled|abort/i.test(err.message || '')) {
          entry._rifeStatus = null;
          entry._rifeRunningMultiplier = null;
          logConsole(`[SEQ RIFE]: aborted — ${err.message}`, 'error');
          _instantRifeQueue.splice(0);
          break;
        }
        entry._rifeStatus = 'failed';
        entry._rifeError = err.message || String(err);
        entry._rifeRunningMultiplier = null;
        logConsole(`[SEQ RIFE]: error ${entry.name} — ${entry._rifeError}`, 'error');
      } finally {
        if (_instantRifeRunningId === entry.id) _instantRifeRunningId = null;
      }
      renderSequenceBox({ skipInstantKick: true });
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
    renderSequenceBox({ skipInstantKick: true });
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
    } else if (entry._rifeStatus !== 'running' && entry._rifeStatus !== 'pending'
        && entry._rifeStatus !== 'failed') {
      entry._rifeStatus = null;
    }
    if (!quiet && info?.reason && state.pool.useRife) {
      logConsole(`[SEQ RIFE]: ${entry.name} — ${info.reason}`);
    }
    return;
  }

  _queueInstantRife(entry, info);
}

/**
 * Probe every sequence source for fps/duration, then queue Instant densify.
 * Call when Instant is turned on — do not require the user to re-touch Time.
 */
async function ensureSequenceMetaAndInstantScan({ force = false } = {}) {
  if (!state.pool.instantRife) return { queued: 0, reason: 'instant off' };
  _hydrationComplete = false;
  // Instant always implies join densify path
  state.pool.useRife = true;
  const ur = document.getElementById('poolUseRife');
  if (ur) ur.checked = true;

  const seq = state.pool.sequence || [];
  if (!seq.length) {
    logConsole('[SEQ RIFE]: Instant on but sequence is empty — add clips first');
    _updateInstantRifeStrip();
    _hydrationComplete = true;
    return { queued: 0, reason: 'empty sequence' };
  }

  setClientBusy('Instant RIFE: probing clips…');
  _updateInstantRifeStrip();

  try {
    // Ensure pool items exist + meta for every sequence path
    for (const entry of seq) {
      let item = findPoolItem(entry.path);
      if (!item) {
        item = { path: entry.path, name: entry.name || basename(entry.path), meta: null };
        state.pool.items.push(item);
      }
      const needProbe = force || !item.meta?.fps || !item.meta?.duration;
      if (needProbe) {
        try {
          await loadPoolItemMeta(item, state.pool.items.indexOf(item));
        } catch (e) {
          logConsole(`[SEQ RIFE]: probe failed ${entry.name} — ${e.message}`, 'error');
        }
      }
    }

    const target = _resolvedTargetFps();
    if (!target) {
      logConsole('[SEQ RIFE]: still no fps after probe — cannot densify');
      clearClientBusy();
      _updateInstantRifeStrip();
      _hydrationComplete = true;
      return { queued: 0, reason: 'no fps' };
    }

    setClientBusy('Instant RIFE: checking existing densify…');
    for (const entry of seq) {
      try {
        await _hydrateEntryFromVariants(entry);
      } catch (e) {
        logConsole(`[SEQ RIFE]: variant lookup failed ${entry.name} — ${e.message}`, 'error');
      }
    }

    let need = 0;
    let queued = 0;
    let already = 0;
    for (const entry of seq) {
      const info = _rifeInfoForEntry(entry);
      if (!info?.needed) {
        if (entry.variantPath && entry.variantPath !== entry.path) {
          already += 1;
          entry._rifeStatus = 'done';
        }
        continue;
      }
      need += 1;
      if (_queueInstantRife(entry, info, { skipRender: true })) queued += 1;
    }

    logConsole(
      `[SEQ RIFE]: scan complete — ${seq.length} clips, ${need} need densify, `
      + `${queued} queued, ${already} already densified (reused), target ${target} fps`,
    );

    renderSequenceBox();
    if (queued > 0) {
      _drainInstantRifeQueue();
    } else {
      clearClientBusy();
      _updateInstantRifeStrip();
      if (need === 0 && seq.length) {
        const strip = document.getElementById('seqInstantRifeStrip');
        if (strip) {
          strip.className = 'seq-instant-strip is-idle';
          strip.textContent =
            `Instant RIFE: nothing to densify @ ${target} fps `
            + `(set Time longer than native to slow, or raise RIFE fps above native)`;
          strip.title = [
            'Instant only densifies when content fps after Time stretch is below target fps.',
            'Example: 24fps clip stretched to 2× length → needs ×2 at target 24.',
            'Or set RIFE fps to 60 to densify even without stretch.',
          ].join('\n');
        }
      }
    }
    _hydrationComplete = true;
    return { queued, need, target };
  } catch (e) {
    logConsole(`[SEQ RIFE]: scan error — ${e.message}`, 'error');
    clearClientBusy();
    _hydrationComplete = true;
    throw e;
  }
}

function _maybeAutoRifeAll({ quiet = true } = {}) {
  if (!state.pool.instantRife) return;
  // Full probe+scan so "turn Instant on" always does real work when needed
  ensureSequenceMetaAndInstantScan({ force: false }).catch((e) => {
    console.error('[SEQ RIFE] ensureSequenceMetaAndInstantScan', e);
  });
}

function _maybeAutoRifeForPath(path) {
  if (!state.pool.instantRife) return;
  if (!state.pool.useRife) state.pool.useRife = true;
  (async () => {
    for (const entry of state.pool.sequence) {
      if (entry.path !== path) continue;
      try {
        await _hydrateEntryFromVariants(entry);
      } catch (_) { /* ignore */ }
      _maybeAutoRifeEntry(entry);
    }
    try { renderSequenceBox({ skipInstantKick: true }); } catch (_) { /* ignore */ }
  })();
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
    _updateInstantRifeStrip();
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
    tok.innerHTML = `
      <span class="seq-token-row seq-token-row-top">
        <span class="seq-token-idx">${idx + 1}</span>
        <span class="seq-token-name">${escapeHtml(entry.name)}</span>
        <button type="button" class="seq-token-x" title="Remove from sequence">&cross;</button>
      </span>
      <span class="seq-token-row seq-token-row-bot">
        <span class="seq-token-dur${speedInfo.stretched ? ' timed' : ''}">${speedInfo.durLabel}</span>
        <button type="button" class="seq-token-var${usingRifed ? ' is-rifed' : ''}" data-variant-path="${escapeHtml(entry.variantPath || '')}">${fileBtnLabel}</button>
        <span class="seq-token-rife-host"></span>
      </span>
    `;

    const varBtn = tok.querySelector('.seq-token-var');
    if (varBtn) {
      varBtn.title = fileBtnTitle;
      varBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const currentPath = entry.variantPath || entry.path;
        const variants = await _fetchVariants(entry.path);
        _showSeqVariantMenu(varBtn, entry, variants, currentPath);
      });
    }

    // Single state badge (NEED / Q# / RUN / OK / FAIL) — hover for full explanation
    const badge = _rifeBadgeForEntry(entry);
    const host = tok.querySelector('.seq-token-rife-host');
    if (badge && host) {
      if (badge.cls.includes('is-need') || badge.cls.includes('is-queued') || badge.cls.includes('is-running')) {
        tok.classList.add('seq-rife-needed');
      }
      const el = document.createElement('span');
      el.className = badge.cls;
      el.textContent = badge.text;
      el.title = badge.title;
      el.setAttribute('role', 'status');
      host.appendChild(el);
    }

    // Proportional width, but never below size-level min-width (prevents control crush)
    const ratio = totalDuration > 0
      ? (durations[idx] / totalDuration) * 100
      : (100 / state.pool.sequence.length);
    const minW = getComputedStyle(box).getPropertyValue('--seq-token-min-w').trim() || '152px';
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
    }

    tok.addEventListener('click', (e) => {
      if (e.target.closest('.seq-token-x') || e.target.closest('.seq-token-var') || e.target.closest('.seq-rife-badge')) return;
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

  _updateInstantRifeStrip();
  updateSeqTransportUI();
  if (!opts.skipInstantKick && _hydrationComplete && state.pool.instantRife && state.pool.useRife) {
    const hasIdleNeed = (state.pool.sequence || []).some((e) => {
      if (e._rifeStatus === 'pending' || e._rifeStatus === 'running'
          || e._rifeStatus === 'failed' || _findQueuedRife(e.id)) {
        return false;
      }
      const d = _densityInfoForEntry(e);
      if (!d?.needed) return false;
      if (e.variantPath && (_bestHaveM(e) >= (d.multiplier || 2))) return false;
      return true;
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
    // Dedupe paths — same source can appear multiple times in the sequence
    const seen = new Set();
    for (const tok of tokens) {
      const path = tok.dataset.path;
      const id = tok.dataset.id;
      if (!path || seen.has(path + '\0' + id)) continue;
      seen.add(path + '\0' + id);
      const entry = state.pool.sequence.find((e) => String(e.id) === String(id));
      if (!entry) continue;
      const btn = tok.querySelector('.seq-token-var');
      if (!btn) continue;
      const variants = await _fetchVariants(path);
      const n = Object.values(variants).reduce((a, arr) => a + (arr?.length || 0), 0);
      const using = entry.variantPath && entry.variantPath !== entry.path;
      btn.classList.toggle('is-rifed', !!using);
      btn.textContent = using ? 'RIFED' : 'ORIG';
      if (n > 0 && !btn.title.includes('Registered variants')) {
        btn.title = (btn.title || '') + `\nRegistered variants: ${n}`;
      }
    }
  } catch (e) {
    console.warn('[SEQ] _updateSeqVariantBadges', e);
  }
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

/** In-flight + short TTL cache — stops render storms from melting the server. */
const _variantsCache = new Map(); // path → { at, data }
const _variantsInflight = new Map(); // path → Promise
const VARIANTS_TTL_MS = 15000;

async function _fetchVariants(path) {
  if (!path) return {};
  const hit = _variantsCache.get(path);
  if (hit && (Date.now() - hit.at) < VARIANTS_TTL_MS) return hit.data;

  const pending = _variantsInflight.get(path);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(`/api/variants?path=${encodeURIComponent(path)}`);
      if (!res.ok) return {};
      const data = await res.json();
      const variants = data.variants || {};
      _variantsCache.set(path, { at: Date.now(), data: variants });
      return variants;
    } catch {
      return hit?.data || {};
    } finally {
      _variantsInflight.delete(path);
    }
  })();
  _variantsInflight.set(path, p);
  return p;
}

function _invalidateVariantsCache(path) {
  if (path) _variantsCache.delete(path);
  else _variantsCache.clear();
}

/**
 * Multiplier for a densify path from registry map (or filename fallback).
 */
function _multiplierForVariantPath(vPath, variants, entry) {
  if (!vPath || vPath === entry.path) return 0;
  const list = (variants && variants.rifed) || [];
  for (const v of list) {
    if (v && v.path === vPath) {
      const m = Number(v.detail && v.detail.multiplier);
      return Number.isFinite(m) && m >= 2 ? m : 2;
    }
  }
  // Same path already on entry
  if (entry.variantPath === vPath && _bestHaveM(entry) >= 2) {
    return _bestHaveM(entry);
  }
  // Filename heuristic: *_rife*.mp4 is densify
  if (/_rife/i.test(basename(vPath))) return 2;
  return 2;
}

function _showSeqVariantMenu(anchor, entry, variants, currentPath) {
  document.querySelectorAll('.seq-variant-menu').forEach(el => el.remove());
  const menu = document.createElement('div');
  menu.className = 'seq-variant-menu pool-context-menu';

  const makeRow = (vPath, kind, detail) => {
    const selected = currentPath === vPath;
    const base = basename(vPath);
    const m = detail && detail.multiplier != null ? Number(detail.multiplier) : '';
    const label = vPath === entry.path
      ? `Original — ${base}`
      : `${kind || 'variant'} — ${base}${detail ? ' · ' + Object.entries(detail).map(([k, val]) => `${k}=${val}`).join(' · ') : ''}`;
    const mAttr = (m >= 2) ? ` data-multiplier="${m}"` : '';
    return `<button type="button" class="seq-var-opt${selected ? ' selected' : ''}" data-vpath="${escapeHtml(vPath)}"${mAttr} data-kind="${escapeHtml(kind || '')}" title="${escapeHtml(vPath)}">${escapeHtml(label)}</button>`;
  };

  let rows = makeRow(entry.path, 'original', null);
  const seen = new Set([entry.path]);
  // Always list the active densified path even if /api/variants is empty
  if (entry.variantPath && entry.variantPath !== entry.path && !seen.has(entry.variantPath)) {
    rows += makeRow(entry.variantPath, 'rifed', entry._rifeMultiplier
      ? { multiplier: entry._rifeMultiplier } : null);
    seen.add(entry.variantPath);
  }
  for (const [kind, entries] of Object.entries(variants || {})) {
    for (const v of entries) {
      if (v.path && !seen.has(v.path)) {
        rows += makeRow(v.path, kind, v.detail || null);
        seen.add(v.path);
      }
    }
  }
  if (seen.size <= 1) {
    rows += `<div class="seq-var-empty">No densified file yet. Enable Instant RIFE (or Stitch with RIFE) when a clip shows NEED.</div>`;
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
        const ent = state.pool.sequence[idx];
        if (vp === entry.path) {
          // Stitch original — keep known densify M so Instant does not re-encode
          ent.variantPath = null;
          // do not clear _rifeMultiplier
          const dens = _densityInfoForEntry(ent);
          const needM = dens.needed ? (dens.multiplier || 2) : 0;
          ent._rifeStatus = (_bestHaveM(ent) >= needM && needM > 0) || (!_densityInfoForEntry(ent).needed)
            ? 'done'
            : ent._rifeStatus;
        } else {
          // Selecting densify file MUST record M — otherwise badge stays NEED×N forever
          const fromAttr = parseInt(btn.dataset.multiplier || '', 10);
          const m = (fromAttr >= 2)
            ? fromAttr
            : _multiplierForVariantPath(vp, variants, ent);
          ent.variantPath = vp;
          ent._rifeMultiplier = m;
          ent._rifeStatus = 'done';
          ent._rifeError = null;
          logConsole(
            `[SEQ]: ${ent.name} → use densify ${basename(vp)} (×${m})`,
          );
        }
        scheduleSavePoolState();
        renderSequenceBox({ skipInstantKick: true });
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
  applySeqTokenSize,
  setSeqTokenSize,
  ensureSequenceMetaAndInstantScan,
  getInstantRifeQueueSnapshot,
};

/**
 * Read-only Instant RIFE queue for Jobs tab — never mutates queue/run state.
 */
function getInstantRifeQueueSnapshot() {
  const runningEntry = (_instantRifeRunningId != null)
    ? (state.pool.sequence || []).find((e) => e.id === _instantRifeRunningId)
    : null;
  return {
    enabled: !!(state.pool.instantRife && state.pool.useRife),
    draining: !!_instantRifeDraining,
    stopRequested: !!_instantRifeStop,
    queueDepth: _instantRifeQueue.length,
    queue: _instantRifeQueue.map((j, i) => ({
      position: i + 1,
      entryId: j.entryId,
      name: j.name,
      path: j.path,
      multiplier: j.multiplier,
      targetFps: j.targetFps,
      effFps: j.effFps,
    })),
    running: runningEntry
      ? {
          entryId: runningEntry.id,
          name: runningEntry.name,
          path: runningEntry.path,
          status: runningEntry._rifeStatus,
          multiplier: runningEntry._rifeRunningMultiplier || runningEntry._rifeMultiplier,
        }
      : null,
    // Sequence entries that still claim densify work (for desk overview)
    sequenceNeed: (state.pool.sequence || [])
      .filter((e) => e._rifeStatus === 'pending' || e._rifeStatus === 'running'
        || e._rifeStatus === 'failed')
      .map((e) => ({
        id: e.id,
        name: e.name,
        status: e._rifeStatus,
        mult: e._rifeMultiplier || e._rifeRunningMultiplier || null,
        error: e._rifeError || null,
      })),
  };
}
