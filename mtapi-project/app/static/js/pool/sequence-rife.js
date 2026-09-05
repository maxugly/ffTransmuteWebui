// Extracted from pool/sequence.js — see sequence.js barrel. Vanilla ES6, no framework.
import { state, logConsole } from '/app.js';
import { basename } from '/js/utils.js';
import { scheduleSavePoolState } from '/js/pool/persistence.js';
import { runOpWithCancel, onStopRequest, isMainJobBusy, setClientBusy, clearClientBusy, abortMainJob } from '/js/job-control.js';
import { recordVariantBatch, enqueueSignature } from '/js/lazy-loader.js';
import { findPoolItem, _getNativeMeta } from '/js/pool/sequence-model.js';
import { peekVariants, _fetchVariants, _fetchVariantsBatch, _normVariantKey, _invalidateVariantsCache } from '/js/pool/sequence-variants.js';
import { renderSequenceBox } from '/js/pool/sequence-composer.js';

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
function _alreadyHasUsableRife(entry) {
  return !!(entry && entry.variantPath && entry.variantPath !== entry.path && _bestHaveM(entry) >= 2);
}

/** Canonical Instant decision: 'rifed' | 'needsRife' | 'noRifeNeeded'. */
function refreshRifeNeed(entry) {
  if (!entry) return 'noRifeNeeded';
  const dens = _densityInfoForEntry(entry);
  const haveM = _bestHaveM(entry);
  const hasVar = _alreadyHasUsableRife(entry);
  let need;
  if (hasVar && (!dens.needed || haveM >= (dens.multiplier || 2))) {
    need = 'rifed';
  } else if (dens.needed && (!hasVar || haveM < (dens.multiplier || 2))) {
    need = 'needsRife';
  } else {
    need = 'noRifeNeeded';
  }
  entry.rifeNeed = need;
  return need;
}

function _rifeInfoForEntry(entry) {
  if (!state.pool.useRife) return { needed: false, reason: 'RIFE interpolate off' };
  const dens = _densityInfoForEntry(entry);
  const haveM = _bestHaveM(entry);
  if (_alreadyHasUsableRife(entry)) {
    if (!dens.needed || haveM >= (dens.multiplier || 2)) {
      return {
        ...dens,
        needed: false,
        reason: `already densified ×${haveM} — not re-encoding`,
        haveM,
      };
    }
  }
  if (!dens.needed) return dens;
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
let _hydrationComplete = false;

function setInstantHydrationGate(complete) {
  _hydrationComplete = !!complete;
}

/**
 * Attach already-registered RIFE files from the media cache.
 * No probe, no encode, no busy UI. Same video in another project reuses
 * the global variant list.
 */
async function attachCachedRifeVariants() {
  const seq = state.pool.sequence || [];
  if (!seq.length) return { attached: 0 };
  const need = [];
  const seen = new Set();
  let already = 0;
  for (const e of seq) {
    if (!e.path) continue;
    if (e.rifeNeed === 'rifed' || e.rifeNeed === 'noRifeNeeded'
        || (e.variantPath && e.variantPath !== e.path && _bestHaveM(e) >= 2)) {
      if (e.rifeNeed !== 'noRifeNeeded') e.rifeNeed = e.rifeNeed || 'rifed';
      e._rifeStatus = e.rifeNeed === 'rifed' ? 'done' : e._rifeStatus;
      already += 1;
      continue;
    }
    const k = _normVariantKey(e.path);
    if (!seen.has(k)) {
      seen.add(k);
      need.push(e.path);
    }
  }
  let attached = already;
  if (need.length) {
    const map = await _fetchVariantsBatch(need);
    for (const e of seq) {
      if (e.variantPath && e.variantPath !== e.path && _bestHaveM(e) >= 2) continue;
      const variants = map.get(_normVariantKey(e.path)) || peekVariants(e.path);
      const best = _pickBestRifed(variants);
      if (!best) continue;
      e.variantPath = best.path;
      e._rifeMultiplier = best.multiplier;
      if (best.hash) e._variantHash = best.hash;
      e._rifeStatus = 'done';
      e._rifeError = null;
      refreshRifeNeed(e);
      attached += 1;
    }
  }
  if (attached > already) {
    try { scheduleSavePoolState(); } catch (_) { /* ignore */ }
  }
  return { attached };
}
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

function _entrySatisfiesNeed(entry) {
  if (!entry || !entry.path) return false;
  if (!entry.variantPath || entry.variantPath === entry.path) return false;
  const have = _bestHaveM(entry);
  if (have < 2) return false;
  const dens = _densityInfoForEntry(entry);
  const needM = dens?.needed ? (dens.multiplier || 2) : 0;
  return !dens?.needed || have >= needM;
}

async function _pathExistsCheap(path) {
  if (!path) return false;
  try {
    const sig = await enqueueSignature(path);
    return !!(sig && sig.size != null);
  } catch (_) {
    return false;
  }
}

async function _recoverMissingVariant(entry, needM) {
  if (!entry) return false;
  const persisted = entry.variantPath && entry.variantPath !== entry.path && _bestHaveM(entry) >= (needM || 2);
  if (persisted) {
    const exists = await _pathExistsCheap(entry.variantPath);
    if (exists) return true;
  } else if (!entry.variantPath || entry.variantPath === entry.path) {
    return false;
  } else {
    const exists = await _pathExistsCheap(entry.variantPath);
    if (exists && _bestHaveM(entry) >= (needM || 2)) return true;
    if (exists) return false;
  }
  try {
    const res = await fetch('/api/media/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hash: entry._variantHash || null,
        last_path: entry.variantPath || null,
        parent_path: entry.path,
        multiplier: entry._rifeMultiplier || needM || null,
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data || !data.found || !data.path) return false;
    entry.variantPath = data.path;
    if (data.hash) entry._variantHash = data.hash;
    if (_bestHaveM(entry) < 2) entry._rifeMultiplier = needM || 2;
    return _bestHaveM(entry) >= (needM || 2);
  } catch (_) {
    return false;
  }
}

async function recoverSequenceVariants() {
  const seq = state.pool.sequence || [];
  for (const entry of seq) {
    if (!entry.variantPath || entry.variantPath === entry.path) continue;
    await _recoverMissingVariant(entry, entry._rifeMultiplier || 2);
  }
}

async function _gcLowerDensityAfterPromote(entry, _prevPath, _prevM, _prevHash) {
  if (!entry?.path || !entry.variantPath) return;
  const keepM = _bestHaveM(entry);
  if (keepM < 2) return;
  try {
    await fetch('/api/variants/gc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent_path: entry.path,
        keep_multiplier: keepM,
        keep_paths: [entry.variantPath],
      }),
    });
  } catch (_) { /* ignore */ }
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
      best = { path: v.path, multiplier: score, hash: v.hash || null };
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
  if (_entrySatisfiesNeed(entry)) {
    entry._rifeStatus = 'done';
    entry._rifeError = null;
    return entry.variantPath
      ? { path: entry.variantPath, multiplier: _bestHaveM(entry) }
      : null;
  }
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

  // If we have a densified variant that covers the current need, mark done immediately
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
    // The project/session snapshot already carries the selected densified
    // path and multiplier.  If that saved variant covers the current need,
    // trust it and avoid a registry request during project restore.
    const before = _rifeInfoForEntry(entry);
    const haveBefore = _bestHaveM(entry);
    if (entry.variantPath && entry.variantPath !== entry.path
        && haveBefore > 0
        && (!before?.needed || haveBefore >= (before.multiplier || 2))) {
      entry._rifeStatus = 'done';
      entry._rifeError = null;
      reused += 1;
      continue;
    }
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

      const recovered = await _recoverMissingVariant(entry, info.multiplier);
      if (recovered) {
        entry._rifeStatus = 'done';
        entry._rifeError = null;
        logConsole(`[SEQ RIFE]: recovered ${entry.name} → ${basename(entry.variantPath)} (×${entry._rifeMultiplier}) — not re-encoding`);
        renderSequenceBox({ skipInstantKick: true });
        scheduleSavePoolState();
        continue;
      }

      const runM = info.multiplier;
      const previousVariant = entry.variantPath || null;
      const previousM = entry._rifeMultiplier || 0;
      const previousHash = entry._variantHash || null;
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
          // Promote only after success. Previous valid variant stays until then.
          const prevPath = entry.variantPath;
          const prevM = entry._rifeMultiplier || 0;
          const prevHash = entry._variantHash || null;
          if (!entry.variantPath || runM >= prevM) {
            entry.variantPath = data.output_path || entry.variantPath;
            entry._rifeMultiplier = runM;
            const vh = data.meta?.variant_hash;
            if (vh) entry._variantHash = vh;
          }
          entry._rifeError = null;
          entry._rifeRunningMultiplier = null;
          _invalidateVariantsCache(entry.path);
          try { scheduleSavePoolState(); } catch (_) { /* ignore */ }
          _gcLowerDensityAfterPromote(entry, prevPath, prevM, prevHash).catch(() => {});

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

  // If we already have a densified variant on record, never clear its status
  if (entry.variantPath && entry.variantPath !== entry.path && _bestHaveM(entry) > 0) {
    entry._rifeStatus = 'done';
    return;
  }

  const info = _rifeInfoForEntry(entry);
  if (!info?.needed) {
    if (entry._rifeStatus !== 'running' && entry._rifeStatus !== 'pending'
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

  try {
    // Only ask the cache about clips we do not already have an answer for.
    await attachCachedRifeVariants();

    const target = _resolvedTargetFps();
    let need = 0;
    let queued = 0;
    let already = 0;
    for (const entry of seq) {
      const kind = entry.rifeNeed || refreshRifeNeed(entry);
      if (kind !== 'needsRife') {
        if (kind === 'rifed') {
          already += 1;
          entry._rifeStatus = 'done';
        }
        continue;
      }
      const info = _rifeInfoForEntry(entry);
      if (!info?.needed) {
        entry.rifeNeed = refreshRifeNeed(entry);
        if (entry.rifeNeed !== 'needsRife') continue;
      }
      need += 1;
      if (info?.needed && _queueInstantRife(entry, info, { skipRender: true })) queued += 1;
    }

    logConsole(
      `[SEQ RIFE]: ${seq.length} clips — ${already} already densified, `
      + `${need} need work, ${queued} queued`
      + (target ? `, target ${target} fps` : ''),
    );

    renderSequenceBox({ skipInstantKick: true });
    if (queued > 0) {
      _drainInstantRifeQueue();
    } else {
      clearClientBusy();
      _updateInstantRifeStrip();
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

export { _timeFactor, _effectiveContentFps, _resolvedTargetFps, _densityInfoForEntry, _alreadyHasUsableRife, refreshRifeNeed, _rifeInfoForEntry, setInstantHydrationGate, attachCachedRifeVariants, _rifeBadgeForEntry, _updateInstantRifeStrip, _findQueuedRife, _bestHaveM, _entrySatisfiesNeed, _recoverMissingVariant, recoverSequenceVariants, _hydrateEntryFromVariants, _queueInstantRife, _kickInstantRifeScan, _scheduleInstantRifeKick, _drainInstantRifeQueue, _maybeAutoRifeEntry, ensureSequenceMetaAndInstantScan, _maybeAutoRifeAll, getInstantRifeQueueSnapshot };
export function isHydrationComplete() { return _hydrationComplete; }
