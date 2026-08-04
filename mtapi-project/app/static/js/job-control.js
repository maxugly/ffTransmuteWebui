import {
  state, elements,
  logConsole, fitPreviewViewer,
  renderTabForm, bestInput, allInputPaths, bestOutput,
  probeGlobalVideo, updateGlobalInputs, updateStatusIndicators,
  showPreview,
} from '/app.js';
import { basename, escapeHtml } from '/js/utils.js';
import { setPreviewAspect } from '/js/preview.js';
import { collectFaceMorphBody } from '/js/tabs/facemorph.js';
import { collectWithoutBgBody } from '/js/tabs/withoutbg.js';
import { collectStyleTransferBody } from '/js/tabs/styletransfer.js';
import { collectRifeBody } from '/js/tabs/rife.js';
import { collectImg2ImgBody } from '/js/tabs/img2img.js';
import { collectTxt2ImgBody } from '/js/tabs/txt2img.js';
import { collectUpscaleBody } from '/js/tabs/upscale.js';
import { collectRifeRecohereBody } from '/js/tabs/riferecohere.js';
import { collectSpeedChangeBody } from '/js/tabs/speedchange.js';
import { collectConvertBody } from '/js/tabs/convert.js';
import { collectZoompanBody } from '/js/tabs/zoompan.js';
import { collectImageSortBody } from '/js/tabs/imagesort.js';
import { collectCutBody } from '/js/tabs/cut.js';
import { activeTransmuteOp, transmuteOpsDetails, activeMultiMode } from '/js/tabs/transmute.js';
import { collectDeepDreamBody } from '/js/tabs/deepdream.js';
// ── Job run / cooperative stop ────────────────────────────────────────────
// Stop is cooperative: we abort the fetch + POST /api/cancel so DeepDream
// loops exit soon. ffmpeg/transmute mid-process may still finish the current
// subprocess — that's a hard limit of shelling out without process groups.

let activeJob = {
  token: null,
  controller: null,
  stopping: false,
  pollTimer: null,
  tickTimer: null,
  startedAt: 0,
  lastPhase: '',
  lastSnap: null,
};

// ── Live preview toggle ───────────────────────────────────────────────────

function togglePreviewLive() {
  state.previewLive = !state.previewLive;
  var btn = document.getElementById('btnPreviewLive');
  if (btn) {
    btn.textContent = state.previewLive ? 'Live: ON' : 'Live: OFF';
    btn.classList.toggle('live-active', state.previewLive);
  }
}

function _maybeShowLiveFrame(snap) {
  if (!state.previewLive || !activeJob.token) return;
  var path = snap && snap.latest_frame;
  if (!path) return;

  var viewer = elements.mediaViewer;
  if (!viewer) return;

  var existingImg = viewer.querySelector('img.live-preview-frame');
  var cacheBust = '&t=' + Date.now();

  if (existingImg) {
    existingImg.src = '/api/image?path=' + encodeURIComponent(path) + cacheBust;
    return;
  }

  // Live is on and we have a frame — replace whatever's there
  viewer.innerHTML = '';
  var img = document.createElement('img');
  img.className = 'live-preview-frame';
  img.src = '/api/image?path=' + encodeURIComponent(path) + cacheBust;
  img.style.objectFit = 'contain';
  img.style.width = '100%';
  img.style.height = '100%';
  img.onload = function() {
    if (img.naturalWidth && img.naturalHeight) {
      setPreviewAspect(img.naturalWidth, img.naturalHeight);
    }
  };
  viewer.appendChild(img);

  var info = document.getElementById('mediaInfo');
  if (info) info.style.display = 'flex';
  var nameEl = document.getElementById('mediaName');
  if (nameEl) nameEl.textContent = 'Live preview';
  var pathEl = document.getElementById('mediaPath');
  if (pathEl) pathEl.textContent = path;
}

/** Sticky elapsed clock: 0:05 / 1:02:03 */
function formatElapsedMs(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatJobLine(p) {
  if (!p || !p.found) return null;
  const parts = ['[PROGRESS]'];
  if (p.phase) parts.push(`[${p.phase}]`);
  if (p.total > 0) {
    parts.push(`${p.current || 0}/${p.total}${p.unit ? ' ' + p.unit : ''}`);
    if (p.pct != null) parts.push(`(${p.pct}%)`);
  }
  if (p.rate_h) parts.push(`~${p.rate_h}`);
  if (p.message) parts.push(p.message);
  parts.push(`| elapsed ${p.elapsed_h || '—'}`);
  if (p.eta_s != null && p.eta_s > 0 && p.status === 'running') {
    parts.push(`| ETA ${p.eta_h || '—'}`);
  }
  return parts.join(' ');
}

function stopJobProgressPoll() {
  if (activeJob.pollTimer) {
    clearInterval(activeJob.pollTimer);
    activeJob.pollTimer = null;
  }
  if (activeJob.tickTimer) {
    clearInterval(activeJob.tickTimer);
    activeJob.tickTimer = null;
  }
}

/** Update sticky status bar + Run button with live elapsed (no new console lines). */
function paintStickyJobUi() {
  if (!activeJob.token || !activeJob.startedAt) return;
  const elapsed = formatElapsedMs(Date.now() - activeJob.startedAt);
  const p = activeJob.lastSnap;
  const stopping = activeJob.stopping;

  // Status bar — sticky single place, rewrites in place
  if (elements.statusText) {
    const bits = [];
    if (stopping) bits.push('Stopping');
    else bits.push('Running');
    bits.push(elapsed);
    if (p && p.found) {
      if (p.phase) bits.push(p.phase);
      if (p.total > 0) {
        bits.push(`${p.current || 0}/${p.total}${p.unit ? ' ' + p.unit : ''}`);
        if (p.pct != null) bits.push(`${p.pct}%`);
      } else if (p.message) {
        bits.push(p.message);
      }
      if (p.rate_h) bits.push(`~${p.rate_h}`);
      if (p.eta_s != null && p.eta_s > 0 && !stopping) bits.push(`ETA ${p.eta_h}`);
    }
    elements.statusText.textContent = bits.join(' · ');
  }

  // Run button — sticky timer on the control itself
  if (elements.btnRun && elements.btnRun.disabled) {
    elements.btnRun.innerHTML = stopping
      ? `<span style="animation: pulse-dot 1s infinite;">●</span> Stopping… ${elapsed}`
      : `<span style="animation: pulse-dot 1s infinite;">●</span> ${elapsed}`;
  }
}

function startJobProgressPoll(token) {
  stopJobProgressPoll();
  if (!token) return;
  activeJob.lastPhase = '';
  activeJob.lastSnap = null;
  activeJob.startedAt = Date.now();

  // Local sticky clock — independent of server poll (smooth 1s ticks)
  paintStickyJobUi();
  activeJob.tickTimer = setInterval(() => {
    if (!activeJob.token || activeJob.token !== token) return;
    paintStickyJobUi();
  }, 1000);

  const tick = async () => {
    if (!activeJob.token || activeJob.token !== token) return;
    try {
      const res = await fetch(`/api/job/${encodeURIComponent(token)}`);
      if (!res.ok) return;
      const p = await res.json();
      if (!p || !p.found) return;
      activeJob.lastSnap = p;
      paintStickyJobUi();

      // Live preview: show latest generated frame if toggle is on
      if (state.previewLive && p.latest_frame) {
        _maybeShowLiveFrame(p);
      }

      // Console: only when phase changes (not every frame / not every second)
      const phase = p.phase || '';
      if (phase && phase !== activeJob.lastPhase) {
        activeJob.lastPhase = phase;
        const line = formatJobLine(p);
        if (line) logConsole(line);
      }
    } catch (_) {
      // ignore poll errors while job runs
    }
  };

  tick();
  // Server snapshot for phase / counts / ETA (status bar only — no spam)
  activeJob.pollTimer = setInterval(tick, 1000);
}

function setRunUiBusy(busy, { stopping = false } = {}) {
  if (elements.btnRun) {
    elements.btnRun.disabled = busy;
    if (busy) {
      const elapsed = activeJob.startedAt
        ? formatElapsedMs(Date.now() - activeJob.startedAt)
        : '0:00';
      elements.btnRun.innerHTML = stopping
        ? `<span style="animation: pulse-dot 1s infinite;">●</span> Stopping… ${elapsed}`
        : `<span style="animation: pulse-dot 1s infinite;">●</span> ${elapsed}`;
    } else {
      elements.btnRun.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        Run Operation
      `;
    }
  }
  if (elements.btnStop) {
    elements.btnStop.hidden = !busy;
    elements.btnStop.disabled = stopping;
  }
}

function newJobToken() {
  if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

async function stopActiveOperation() {
  if (!activeJob.token && !activeJob.controller) {
    logConsole('[STOP]: Nothing running');
    return;
  }
  activeJob.stopping = true;
  setRunUiBusy(true, { stopping: true });
  elements.statusText.textContent = 'Stopping…';
  logConsole('[STOP]: Cancel requested — waiting for cooperative exit…');

  const token = activeJob.token;
  try {
    if (token) {
      await fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    }
  } catch (err) {
    logConsole(`[STOP]: cancel API: ${err.message}`, 'error');
  }
  try {
    activeJob.controller?.abort();
  } catch (_) { /* ignore */ }
}

/**
 * POST /ops/<id> with job token + abort support. Shared by Run, Stitch, Quick.
 */
async function runOpWithCancel(opId, body, { label = 'Processing…' } = {}) {
  if (activeJob.controller) {
    // one job at a time in the UI
    logConsole('[JOB]: Already running — stop first or wait', 'error');
    throw new Error('A job is already running');
  }

  const token = newJobToken();
  const controller = new AbortController();
  stopJobProgressPoll();
  activeJob = {
    token,
    controller,
    stopping: false,
    pollTimer: null,
    tickTimer: null,
    startedAt: Date.now(),
    lastPhase: '',
    lastSnap: null,
  };

  elements.statusDot.className = 'status-dot loading';
  setRunUiBusy(true);
  startJobProgressPoll(token);
  paintStickyJobUi();

  logConsole(`[EXECUTE]: POST /ops/${opId} (job ${token.slice(0, 8)}…)\nParameters: ${JSON.stringify(body, null, 2)}`);
  logConsole('[JOB]: sticky timer on status bar / Run button — console only logs phase changes');

  try {
    const response = await fetch(`/ops/${opId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Job-Token': token,
        ...(window.globalInputs.pathOut.trim() ? { 'X-MTAPI-Output-Dir': window.globalInputs.pathOut.trim() } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    if (data && data.error === 'Cancelled by user') {
      elements.statusDot.className = 'status-dot';
      elements.statusText.textContent = 'Stopped';
      logConsole('[STOP]: Operation cancelled', 'error');
      displayOpResult(data);
      return data;
    }
    displayOpResult(data);
    return data;
  } catch (err) {
    if (err.name === 'AbortError' || activeJob.stopping) {
      elements.statusDot.className = 'status-dot';
      elements.statusText.textContent = 'Stopped';
      logConsole('[STOP]: Fetch aborted (server may still wind down current step)');
      return { ok: false, error: 'Cancelled by user', operation: opId };
    }
    // Long-running ops (deepdream, rife, etc.) can outlive the browser fetch
    // timeout (~5 min). Poll the job endpoint — it may have finished on the server.
    logConsole(`[FETCH DROPPED]: ${err.message} — polling server for result…`, 'error');
    elements.statusDot.className = 'status-dot loading';
    elements.statusText.textContent = 'Reconnecting…';
    try {
      var recovered = false;
      for (var i = 0; i < 60; i++) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        var jobRes = await fetch(`/api/job/${encodeURIComponent(token)}`);
        if (!jobRes.ok) continue;
        var jobData = await jobRes.json();
        if (jobData.status === 'done') {
          recovered = true;
          elements.statusDot.className = 'status-dot';
          elements.statusText.textContent = 'Complete';
          logConsole('[RECOVERED]: job completed on server');
          // No structured result from job endpoint — operation succeeded
          return { ok: true, operation: opId, output_path: jobData.output_path || null };
        }
        if (jobData.status === 'error') {
          logConsole('[JOB ERROR]: ' + (jobData.message || 'unknown'), 'error');
          return { ok: false, error: jobData.message || 'Job failed on server', operation: opId };
        }
      }
      if (!recovered) {
        elements.statusDot.className = 'status-dot error';
        elements.statusText.textContent = 'Failed';
        logConsole('[EXECUTION FAILED]: fetch dropped, server unresponsive after 2 min', 'error');
        throw err;
      }
    } catch (_) {
      elements.statusDot.className = 'status-dot error';
      elements.statusText.textContent = 'Failed';
      logConsole(`[EXECUTION FAILED]: ${err.message}`, 'error');
      throw err;
    }
  } finally {
    const totalMs = activeJob.startedAt ? (Date.now() - activeJob.startedAt) : 0;
    const totalLabel = formatElapsedMs(totalMs);
    stopJobProgressPoll();
    // one final console line with total wall time (not a stream of ticks)
    try {
      const res = await fetch(`/api/job/${encodeURIComponent(token)}`);
      if (res.ok) {
        const p = await res.json();
        const line = formatJobLine(p);
        if (line) logConsole(line + ` · done in ${totalLabel}`);
        else logConsole(`[JOB]: done in ${totalLabel}`);
      } else {
        logConsole(`[JOB]: done in ${totalLabel}`);
      }
    } catch (_) {
      logConsole(`[JOB]: done in ${totalLabel}`);
    }
    activeJob = {
      token: null,
      controller: null,
      stopping: false,
      pollTimer: null,
      tickTimer: null,
      startedAt: 0,
      lastPhase: '',
      lastSnap: null,
    };
    setRunUiBusy(false);
  }
}

// ── resolveActiveOpAndBody — single function for Run + Queue ──────────────

/**
 * Read the active tab form and return { opId, body } or null on validation
 * failure.  Populates `error` string when form cannot be collected; callers
 * are expected to surface it (alert / logConsole).
 */
function resolveActiveOpAndBody() {
  const tab = state.activeTab;
  let opId = '';
  let body = {};
  let error = null;

  if (tab === 'mosh') {
    const input = bestInput('moshInput');
    const output = bestOutput('moshOutput');

    if (!input) {
      error = "Please provide an Input path.";
      return { opId: '', body: null, error };
    }

    const mode = state.selectedMoshMode;
    if (mode === 'melt') {
      opId = 'datamosh_melt';
      body = {
        input_path: input, output_path: output,
        tail: parseInt(document.getElementById('moshTail').value),
        hdamp: parseInt(document.getElementById('moshDamp').value),
        vdrift: parseInt(document.getElementById('moshDrift').value),
        start_frame: window.globalInputs.frameStart,
        end_frame: window.globalInputs.frameEnd,
      };
    } else if (mode === 'classic') {
      opId = 'datamosh_classic';
      body = { input_path: input, output_path: output, start_frame: window.globalInputs.frameStart, end_frame: window.globalInputs.frameEnd };
    } else if (mode === 'hijack') {
      opId = 'datamosh_hijack';
      const injectMode = document.getElementById('hijackSourceSelect').value;
      body = {
        input_path: input, output_path: output, inject_mode: injectMode,
        inject_image_path: injectMode === 'file' ? document.getElementById('hijackImagePath').value : null,
        inject_frame_num: injectMode === 'frame' ? parseInt(document.getElementById('hijackSourceFrame').value) : 0,
        start_frame: window.globalInputs.frameStart, end_frame: window.globalInputs.frameEnd,
        transition_style: document.getElementById('hijackTransitionStyle').value
      };
    } else if (mode === 'destruct') {
      opId = 'datamosh_destruct';
      body = { input_path: input, output_path: output, start_frame: window.globalInputs.frameStart, end_frame: window.globalInputs.frameEnd };
    } else if (mode === 'mv_hack') {
      opId = 'datamosh_mv_hack';
      body = {
        input_path: input, output_path: output,
        start_frame: window.globalInputs.frameStart, end_frame: window.globalInputs.frameEnd,
        multiplier: parseFloat(document.getElementById('mvMultiplier').value) / 100.0,
        drift_h: parseInt(document.getElementById('mvDriftH').value),
        drift_v: parseInt(document.getElementById('mvDriftV').value)
      };
    }

  } else if (tab === 'transmute') {
    const input = bestInput('transmuteInput');
    const output = document.getElementById('transmuteOutput')?.value || null;
    const dryRun = document.getElementById('transmuteDryRun')?.value === '1'
      || document.getElementById('transmuteDryRun')?.checked || false;

    if (!input) {
      error = "Please provide an Input path.";
      return { opId: '', body: null, error };
    }

    opId = activeTransmuteOp;
    body = {
      input_path: input, output_path: output, dry_run: dryRun,
      start_frame: window.globalInputs.frameStart || 1,
      end_frame: window.globalInputs.frameEnd || 999999,
    };

    const fields = transmuteOpsDetails[activeTransmuteOp].fields;
    if (fields.includes('quality')) body.quality = parseInt(document.getElementById('transmuteQuality').value, 10);
    if (fields.includes('seconds_from_end')) body.seconds_from_end = parseFloat(document.getElementById('transmuteSecondsFromEnd').value);
    if (fields.includes('width')) {
      body.width = parseInt(document.getElementById('transmuteWidth').value, 10);
      body.height = parseInt(document.getElementById('transmuteHeight').value, 10);
    }
    if (activeTransmuteOp === 'speed_ramp') {
      body = {
        input_path: input, output_path: output, dry_run: dryRun,
        direction: document.getElementById('rampDirection')?.value || 'spin_down',
        duration: parseFloat(document.getElementById('rampDuration')?.value) || 5.0,
        start_speed: parseFloat(document.getElementById('rampStartSpeed')?.value) || 4.0,
        end_speed: parseFloat(document.getElementById('rampEndSpeed')?.value) || 0.333,
        use_rife: document.getElementById('rampUseRife')?.value === '1',
        multiplier: parseInt(document.getElementById('rampRifeMult')?.value || '2', 10),
        model: document.getElementById('rampRifeModel')?.value || 'rife-v4.6',
        tta: document.getElementById('rampRifeTta')?.value === '1',
        uhd: document.getElementById('rampRifeUhd')?.value === '1',
        start_frame: window.globalInputs.frameStart || 1,
        end_frame: window.globalInputs.frameEnd || 999999,
      };
    }

  } else if (tab === 'multi') {
    const mode = activeMultiMode;
    const reconcile = document.getElementById('multiReconcile')?.value || 'pad';
    const output = document.getElementById('multiOutput')?.value || null;
    const dryRun = document.getElementById('multiDryRun')?.value === '1'
      || document.getElementById('multiDryRun')?.checked || false;

    if (state.multiClips.length < (mode === 'grid' ? 4 : 2)) {
      error = mode === 'grid' ? "Grid mode requires exactly 4 clips." : "Stitch mode requires 2 or more clips.";
      return { opId: '', body: null, error };
    }
    if (mode === 'grid' && state.multiClips.length !== 4) {
      error = "Grid mode requires exactly 4 clips (currently you have " + state.multiClips.length + ").";
      return { opId: '', body: null, error };
    }

    opId = mode;
    body = { input_paths: state.multiClips, mode: reconcile, output_path: output, dry_run: dryRun };

  } else if (tab === 'deepdream') {
    const bb = collectDeepDreamBody();
    if (!bb) { error = "Please provide valid input for DeepDream."; return { opId: '', body: null, error }; }
    opId = 'deepdream';
    body = bb;
  } else if (tab === 'facemorph') {
    const bb = collectFaceMorphBody();
    if (!bb) { error = "Please provide valid input for Face Morph."; return { opId: '', body: null, error }; }
    opId = 'facemorph';
    body = bb;
  } else if (tab === 'withoutbg') {
    const bb = collectWithoutBgBody();
    if (!bb) { error = "Please provide valid input for Remove BG."; return { opId: '', body: null, error }; }
    opId = 'withoutbg';
    body = bb;
  } else if (tab === 'styletransfer') {
    const bb = collectStyleTransferBody();
    if (!bb) { error = "Please provide valid input for Style Transfer."; return { opId: '', body: null, error }; }
    opId = 'styletransfer';
    body = bb;
  } else if (tab === 'rife') {
    const bb = collectRifeBody();
    if (!bb) { error = "Please provide valid input for RIFE."; return { opId: '', body: null, error }; }
    opId = 'rife';
    body = bb;
  } else if (tab === 'img2img') {
    const bb = collectImg2ImgBody();
    if (!bb) { error = "Please provide valid input for Img2Img."; return { opId: '', body: null, error }; }
    opId = 'img2img';
    body = bb;
  } else if (tab === 'txt2img') {
    const bb = collectTxt2ImgBody();
    if (!bb) { error = "Please provide valid input for Txt2Img."; return { opId: '', body: null, error }; }
    opId = 'txt2img';
    body = bb;
  } else if (tab === 'agent') {
    error = 'Use the Send button on the Agent tab (not Run).';
    return { opId: '', body: null, error };
  } else if (tab === 'upscale') {
    const bb = collectUpscaleBody();
    if (!bb) { error = "Please provide valid input for Upscale."; return { opId: '', body: null, error }; }
    opId = 'upscale';
    body = bb;
  } else if (tab === 'riferecohere') {
    const bb = collectRifeRecohereBody();
    if (!bb) { error = "Please provide valid input for RIFE Recohere."; return { opId: '', body: null, error }; }
    opId = 'rife_recohere';
    body = bb;
  } else if (tab === 'speedchange') {
    const bb = collectSpeedChangeBody();
    if (!bb) { error = "Please provide valid input for Speed Change."; return { opId: '', body: null, error }; }
    opId = 'speedchange';
    body = bb;
  } else if (tab === 'convert') {
    const bb = collectConvertBody();
    if (!bb) { error = "Please provide valid input for Convert."; return { opId: '', body: null, error }; }
    opId = 'convert';
    body = bb;
  } else if (tab === 'zoompan') {
    const bb = collectZoompanBody();
    if (!bb) { error = "Please provide valid input for Zoompan."; return { opId: '', body: null, error }; }
    opId = 'zoompan';
    body = bb;
  } else if (tab === 'imagesort') {
    const bb = collectImageSortBody();
    if (!bb) { error = "Please provide valid input for Image Sort."; return { opId: '', body: null, error }; }
    opId = 'imagesort_rife';
    body = bb;
  } else if (tab === 'cut') {
    const bb = collectCutBody();
    if (!bb) { error = "Please provide valid input for Cut."; return { opId: '', body: null, error }; }
    opId = 'cut';
    body = bb;
  } else if (tab === 'advanced') {
    const input = bestInput('advInput');
    const flagsStr = document.getElementById('advFlags')?.value || '';
    const output = document.getElementById('advOutput')?.value || null;
    const dryRun = document.getElementById('advDryRun')?.value === '1'
      || document.getElementById('advDryRun')?.checked || false;

    if (!input) {
      error = "Please provide an Input path.";
      return { opId: '', body: null, error };
    }

    opId = 'transmute_raw';
    const flags = flagsStr.split(/\s+/).filter(f => f.length > 0);
    body = { input_arg: input, flags: flags, output_path: output, dry_run: dryRun };
  }

  if (!opId) {
    error = 'Nothing to run on this tab.';
    return { opId: '', body: null, error };
  }

  return { opId, body, error: null };
}

// ── Running Operations ────────────────────────────────────────────────────

async function runActiveOperation() {
  if (activeJob.controller) {
    alert('A job is already running. Hit Stop first, or wait for it to finish.');
    return;
  }

  const { opId, body, error } = resolveActiveOpAndBody();
  if (error) {
    if (error === 'Use the Send button on the Agent tab (not Run).') {
      // Agent tab: no-op, just log
      logConsole('[AGENT]: ' + error);
      return;
    }
    alert(error);
    return;
  }

  const tab = state.activeTab;

  // ── Multi-path batch (global Path video / image is multi-line) ─────────
  const batchField = {
    mosh: 'moshInput', transmute: 'transmuteInput', deepdream: 'dreamInput',
    rife: 'rifeInput', convert: 'convertInput', advanced: 'advInput',
  }[tab];

  const selfBatchTabs = new Set(['multi', 'facemorph', 'withoutbg', 'styletransfer',
    'pool', 'sequence', 'images', 'cut', 'zoompan', 'notes', 'quick', 'watcher',
    'imagesort', 'txt2img', 'img2img', 'agent', 'jobs']);

  let paths = [];
  if (batchField && !selfBatchTabs.has(tab)) {
    paths = allInputPaths(batchField).filter(function(p) { return !!p; });
  }

  const pathKey = (tab === 'advanced') ? 'input_arg'
    : (body && body.input_path != null) ? 'input_path'
    : (body && body.content_path != null) ? 'content_path'
    : null;

  try {
    if (paths.length > 1 && pathKey) {
      const n = paths.length;
      logConsole(`[BATCH]: ${n} inputs — running ${opId} on each (Stop cancels current only)`);
      let okCount = 0;
      let failCount = 0;
      for (let i = 0; i < n; i++) {
        if (activeJob.stopping) {
          logConsole(`[BATCH]: stopped after ${i}/${n}`, 'error');
          break;
        }
        const path = paths[i];
        const b = Object.assign({}, body);
        b[pathKey] = path;
        if (n > 1) { if ('output_path' in b) b.output_path = null; }
        logConsole(`[BATCH]: ${i + 1}/${n} ← ${path}`);
        try {
          await runOpWithCancel(opId, b, { label: `Batch ${i + 1}/${n}…` });
          okCount += 1;
        } catch (_) { failCount += 1; }
      }
      logConsole(`[BATCH]: done — ok=${okCount} fail=${failCount} total=${n}`);
    } else {
      await runOpWithCancel(opId, body, {
        label: tab === 'deepdream' ? 'DeepDream… (Stop available)' : 'Processing…',
      });
    }
  } catch (_) {
    // already logged
  }
}

// Display Operation Results
function displayOpResult(res) {
  logConsole(`[RESULT]: ok=${res.ok}`);
  if (res.command) {
    logConsole(`[COMMAND EXECUTED]:\n${res.command}`, 'command');
  }
  if (res.stdout) {
    logConsole(`[STDOUT]:\n${res.stdout}`, 'stdout');
  }
  if (res.stderr) {
    logConsole(`[STDERR]:\n${res.stderr}`, 'stderr');
  }

  if (!res.ok) {
    if (res.error === 'Cancelled by user') {
      elements.statusDot.className = 'status-dot';
      elements.statusText.textContent = 'Stopped';
      logConsole(`[STOPPED]: ${res.operation || 'job'} cancelled by user`, 'error');
      return;
    }
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Failed';
    logConsole(`[ERROR]: ${res.error || 'Operation failed'}`, 'error');
    alert(`Operation failed: ${res.error || 'Check console details'}`);
    return;
  }

  elements.statusDot.className = 'status-dot';
  elements.statusText.textContent = 'Success';

  // Preview the output if not a dry run and output path exists
  if (!res.dry_run && res.output_path) {
    showPreview(res.output_path);
  } else if (res.dry_run) {
    logConsole(`[DRY RUN]: Complete. No files written.`);
    elements.mediaViewer.innerHTML = `
      <div class="media-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <p>Dry Run Successful. Command generated in Console.</p>
      </div>
    `;
    elements.mediaInfo.style.display = 'none';
  }
}

// ── Job Queue ─────────────────────────────────────────────────────────────

async function enqueueActiveOperation() {
  const { opId, body, error } = resolveActiveOpAndBody();
  if (error) {
    if (error === 'Use the Send button on the Agent tab (not Run).') {
      logConsole('[QUEUE]: ' + error, 'error');
      return;
    }
    logConsole(`[QUEUE]: ${error}`, 'error');
    return;
  }

  const label = `${opId}${body.input_path ? ' · ' + basename(String(body.input_path)) : ''}`;
  try {
    const res = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op_id: opId, body, label }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(data.error || 'Queue failed');
      return;
    }
    logConsole(`[QUEUE]: #${data.position} ${data.label || opId} (${String(data.id).slice(0, 8)}…)`);
    elements.statusText.textContent = `Queued #${data.position}`;
  } catch (err) {
    logConsole(`[QUEUE]: ${err.message}`, 'error');
    alert(`Queue failed: ${err.message}`);
  }
}

export {
  formatJobLine, stopJobProgressPoll, startJobProgressPoll,
  setRunUiBusy, newJobToken, stopActiveOperation,
  runOpWithCancel, runActiveOperation, displayOpResult,
  togglePreviewLive, enqueueActiveOperation,
  resolveActiveOpAndBody,
};

// ── Module init: wire static UI elements ──────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  var btn = document.getElementById('btnPreviewLive');
  if (btn) btn.addEventListener('click', togglePreviewLive);
});
