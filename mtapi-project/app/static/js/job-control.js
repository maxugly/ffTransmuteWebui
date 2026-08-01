import {
  state, elements,
  logConsole, fitPreviewViewer,
  renderTabForm, bestInput, allInputPaths, bestOutput,
  probeGlobalVideo, updateGlobalInputs, updateStatusIndicators,
  showPreview,
} from '/app.js';
import { basename, escapeHtml } from '/js/utils.js';
import { collectFaceMorphBody } from '/js/tabs/facemorph.js';
import { collectWithoutBgBody } from '/js/tabs/withoutbg.js';
import { collectStyleTransferBody } from '/js/tabs/styletransfer.js';
import { collectRifeBody } from '/js/tabs/rife.js';
import { collectConvertBody } from '/js/tabs/convert.js';
import { collectZoompanBody } from '/js/tabs/zoompan.js';
import { collectImageSortBody } from '/js/tabs/imagesort.js';
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
  lastProgressKey: '',
};

function formatJobLine(p) {
  if (!p || !p.found) return null;
  const parts = ['[PROGRESS]'];
  if (p.phase) parts.push(`[${p.phase}]`);
  if (p.total > 0) {
    parts.push(`${p.current || 0}/${p.total}${p.unit ? ' ' + p.unit : ''}`);
    if (p.pct != null) parts.push(`(${p.pct}%)`);
  }
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
}

function startJobProgressPoll(token) {
  stopJobProgressPoll();
  if (!token) return;
  activeJob.lastProgressKey = '';

  const tick = async () => {
    if (!activeJob.token || activeJob.token !== token) return;
    try {
      const res = await fetch(`/api/job/${encodeURIComponent(token)}`);
      if (!res.ok) return;
      const p = await res.json();
      if (!p || !p.found) return;

      // status bar: compact
      if (elements.statusText && p.status === 'running') {
        let st = p.message || 'Processing…';
        if (p.total > 0) st = `${p.current || 0}/${p.total} · ${p.elapsed_h || ''}`
          + (p.eta_s != null && p.eta_s > 0 ? ` · ETA ${p.eta_h}` : '');
        elements.statusText.textContent = st;
      }

      // console: only when something meaningful changes
      const key = `${p.phase}|${p.current}|${p.total}|${p.message}|${p.status}`;
      if (key !== activeJob.lastProgressKey) {
        activeJob.lastProgressKey = key;
        const line = formatJobLine(p);
        if (line) logConsole(line);
      }
    } catch (_) {
      // ignore poll errors while job runs
    }
  };

  // first tick soon, then every 1.5s
  tick();
  activeJob.pollTimer = setInterval(tick, 1500);
}

function setRunUiBusy(busy, { stopping = false } = {}) {
  if (elements.btnRun) {
    elements.btnRun.disabled = busy;
    if (busy) {
      elements.btnRun.innerHTML = stopping
        ? `<span style="animation: pulse-dot 1s infinite;">●</span> Stopping…`
        : `<span style="animation: pulse-dot 1s infinite;">●</span> Processing…`;
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
  activeJob = { token, controller, stopping: false, pollTimer: null, lastProgressKey: '' };

  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = label;
  setRunUiBusy(true);
  startJobProgressPoll(token);

  logConsole(`[EXECUTE]: POST /ops/${opId} (job ${token.slice(0, 8)}…)\nParameters: ${JSON.stringify(body, null, 2)}`);
  logConsole('[PROGRESS]: live updates every ~1.5s (elapsed / count / ETA when known)');

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
    stopJobProgressPoll();
    // one last progress fetch for final stats
    try {
      const res = await fetch(`/api/job/${encodeURIComponent(token)}`);
      if (res.ok) {
        const p = await res.json();
        const line = formatJobLine(p);
        if (line) logConsole(line + ' · final');
      }
    } catch (_) { /* ignore */ }
    activeJob = { token: null, controller: null, stopping: false, pollTimer: null, lastProgressKey: '' };
    setRunUiBusy(false);
  }
}

// Running Operations
async function runActiveOperation() {
  if (activeJob.controller) {
    alert('A job is already running. Hit Stop first, or wait for it to finish.');
    return;
  }
  const tab = state.activeTab;
  let opId = '';
  let body = {};
  
  if (tab === 'mosh') {
    const input = bestInput('moshInput');
    const output = bestOutput('moshOutput');
    
    if (!input) {
      alert("Please provide an Input path.");
      return;
    }
    
    const mode = state.selectedMoshMode;
    if (mode === 'melt') {
      opId = 'datamosh_melt';
      body = {
        input_path: input,
        output_path: output,
        tail: parseInt(document.getElementById('moshTail').value),
        hdamp: parseInt(document.getElementById('moshDamp').value),
        vdrift: parseInt(document.getElementById('moshDrift').value),
        start_frame: window.globalInputs.frameStart,
        end_frame: window.globalInputs.frameEnd,
      };
    } else if (mode === 'classic') {
      opId = 'datamosh_classic';
      body = {
        input_path: input,
        output_path: output,
        start_frame: window.globalInputs.frameStart,
        end_frame: window.globalInputs.frameEnd,
      };
    } else if (mode === 'hijack') {
      opId = 'datamosh_hijack';
      const injectMode = document.getElementById('hijackSourceSelect').value;
      body = {
        input_path: input,
        output_path: output,
        inject_mode: injectMode,
        inject_image_path: injectMode === 'file' ? document.getElementById('hijackImagePath').value : null,
        inject_frame_num: injectMode === 'frame' ? parseInt(document.getElementById('hijackSourceFrame').value) : 0,
        start_frame: window.globalInputs.frameStart,
        end_frame: window.globalInputs.frameEnd,
        transition_style: document.getElementById('hijackTransitionStyle').value
      };
    } else if (mode === 'destruct') {
      opId = 'datamosh_destruct';
      body = {
        input_path: input,
        output_path: output,
        start_frame: window.globalInputs.frameStart,
        end_frame: window.globalInputs.frameEnd
      };
    } else if (mode === 'mv_hack') {
      opId = 'datamosh_mv_hack';
      body = {
        input_path: input,
        output_path: output,
        start_frame: window.globalInputs.frameStart,
        end_frame: window.globalInputs.frameEnd,
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
      alert("Please provide an Input path.");
      return;
    }
    
    opId = activeTransmuteOp;
    body = {
      input_path: input,
      output_path: output,
      dry_run: dryRun,
      start_frame: window.globalInputs.frameStart || 1,
      end_frame: window.globalInputs.frameEnd || 999999,
    };

    // Add extra params if needed
    const fields = transmuteOpsDetails[activeTransmuteOp].fields;
    if (fields.includes('quality')) {
      body.quality = parseInt(document.getElementById('transmuteQuality').value, 10);
    }
    if (fields.includes('seconds_from_end')) {
      body.seconds_from_end = parseFloat(document.getElementById('transmuteSecondsFromEnd').value);
    }
    if (fields.includes('width')) {
      body.width = parseInt(document.getElementById('transmuteWidth').value, 10);
      body.height = parseInt(document.getElementById('transmuteHeight').value, 10);
    }
    if (activeTransmuteOp === 'speed_ramp') {
      body = {
        input_path: input,
        output_path: output,
        dry_run: dryRun,
        direction: document.getElementById('rampDirection')?.value || 'spin_down',
        duration: parseFloat(document.getElementById('rampDuration')?.value) || 5.0,
        start_speed: parseFloat(document.getElementById('rampStartSpeed')?.value) || 4.0,
        end_speed: parseFloat(document.getElementById('rampEndSpeed')?.value) || 0.333,
        curve_shape: document.getElementById('rampCurveShape')?.value || 'exponential',
        loop_mode: document.getElementById('rampLoopMode')?.value || 'auto',
        start_frame: window.globalInputs.frameStart || 1,
        end_frame: window.globalInputs.frameEnd || 999999,
      };
    }
  } else if (tab === 'multi') {
    const mode = activeMultiMode; // 'join' or 'grid'
    const reconcile = document.getElementById('multiReconcile')?.value || 'pad';
    const output = document.getElementById('multiOutput')?.value || null;
    const dryRun = document.getElementById('multiDryRun')?.value === '1'
      || document.getElementById('multiDryRun')?.checked || false;
    
    if (state.multiClips.length < (mode === 'grid' ? 4 : 2)) {
      alert(mode === 'grid' ? "Grid mode requires exactly 4 clips." : "Stitch mode requires 2 or more clips.");
      return;
    }
    if (mode === 'grid' && state.multiClips.length !== 4) {
      alert("Grid mode requires exactly 4 clips (currently you have " + state.multiClips.length + ").");
      return;
    }

    opId = mode;
    body = {
      input_paths: state.multiClips,
      mode: reconcile,
      output_path: output,
      dry_run: dryRun
    };
  } else if (tab === 'deepdream') {
    const dreamBody = collectDeepDreamBody();
    if (!dreamBody) return;
    opId = 'deepdream';
    body = dreamBody;
  } else if (tab === 'facemorph') {
    const fmBody = collectFaceMorphBody();
    if (!fmBody) return;
    opId = 'facemorph';
    body = fmBody;
  } else if (tab === 'withoutbg') {
    const wbgBody = collectWithoutBgBody();
    if (!wbgBody) return;
    opId = 'withoutbg';
    body = wbgBody;
  } else if (tab === 'styletransfer') {
    const stBody = collectStyleTransferBody();
    if (!stBody) return;
    opId = 'styletransfer';
    body = stBody;
  } else if (tab === 'rife') {
    const rifeBody = collectRifeBody();
    if (!rifeBody) return;
    opId = 'rife';
    body = rifeBody;
  } else if (tab === 'convert') {
    const convBody = collectConvertBody();
    if (!convBody) return;
    opId = 'convert';
    body = convBody;
  } else if (tab === 'zoompan') {
    const zpBody = collectZoompanBody();
    if (!zpBody) return;
    opId = 'zoompan';
    body = zpBody;
  } else if (tab === 'imagesort') {
    const isBody = collectImageSortBody();
    if (!isBody) return;
    opId = 'imagesort_rife';
    body = isBody;
  } else if (tab === 'advanced') {
    const input = bestInput('advInput');
    const flagsStr = document.getElementById('advFlags')?.value || '';
    const output = document.getElementById('advOutput')?.value || null;
    const dryRun = document.getElementById('advDryRun')?.value === '1'
      || document.getElementById('advDryRun')?.checked || false;

    if (!input) {
      alert("Please provide an Input path.");
      return;
    }

    opId = 'transmute_raw';
    // split flags by whitespace, filter empty
    const flags = flagsStr.split(/\s+/).filter(f => f.length > 0);
    body = {
      input_arg: input,
      flags: flags,
      output_path: output,
      dry_run: dryRun
    };
  }

  if (!opId) {
    alert('Nothing to run on this tab.');
    return;
  }

  // ── Multi-path batch (global Path video / image is multi-line) ─────────
  // Single-input ops historically used bestInput() → first line only.
  // When multiple paths are present, run the same op sequentially for each
  // (auto-name outputs; clear explicit output_path to avoid clobber).
  const batchField = {
    mosh: 'moshInput',
    transmute: 'transmuteInput',
    deepdream: 'dreamInput',
    rife: 'rifeInput',
    convert: 'convertInput',
    advanced: 'advInput',
  }[tab];

  // Ops that already batch lists themselves
  const selfBatchTabs = new Set(['multi', 'facemorph', 'withoutbg', 'styletransfer', 'pool', 'sequence', 'images', 'cut', 'zoompan', 'notes', 'quick', 'watcher', 'imagesort']);

  let paths = [];
  if (batchField && !selfBatchTabs.has(tab)) {
    paths = allInputPaths(batchField).filter(function(p) {
      // Prefer videos for video-first tabs; still allow any path if listed
      return !!p;
    });
  }

  // Primary key on body for single-file input
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
        // Avoid writing every result to the same explicit path
        if (n > 1) {
          if ('output_path' in b) b.output_path = null;
        }
        logConsole(`[BATCH]: ${i + 1}/${n} ← ${path}`);
        try {
          await runOpWithCancel(opId, b, {
            label: `Batch ${i + 1}/${n}…`,
          });
          okCount += 1;
        } catch (_) {
          failCount += 1;
          // continue remaining unless user hit Stop
        }
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


export {
  formatJobLine, stopJobProgressPoll, startJobProgressPoll,
  setRunUiBusy, newJobToken, stopActiveOperation,
  runOpWithCancel, runActiveOperation, displayOpResult,
};
