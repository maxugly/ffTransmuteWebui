import { elements, bestInput } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { rifeModelSelectHtml } from '/js/ui/evolve-rife.js';
import { withFrameRange } from '/js/utils.js';

// ── Unified Speed & Time (replaces Speed + RIFE Slo-Mo tabs) ─────────────
// Model (mirrors app/operations/speedchange_ops.py resolve_speed_plan):
//   Output FPS F' defaults to source F, or a custom rate (Match/Custom).
//   T = D / S.  R = T × F'.  K = (F'/F) / S.  M = smallest valid step (2,4,8,…)
//   with G = N×M ≥ R.  Extra = G − R frames are dropped by the conforming encode.
//   Snap (multiplier only): M = nearest step to K, then lock S = (F'/F)/M
//   so G == R exactly (zero extra frames).

let _probeCache = { path: '', frames: 0, fps: 24, duration: 0 };

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function nextRifeMult(targetM) {
  const floor = Math.max(2, targetM);
  return 2 ** Math.max(1, Math.ceil(Math.log2(floor)));
}

function snapRifeMult(targetM) {
  let best = 2;
  let bestDist = targetM > 0 ? Math.abs(Math.log2(2 / targetM)) : 1e9;
  for (let m = 2; m <= 128; m *= 2) {
    const dist = Math.abs(Math.log2(m / targetM));
    if (dist < bestDist) { bestDist = dist; best = m; }
  }
  return best;
}

/** Pure deterministic plan — mirrored on the backend. */
export function resolveUsPlan({ D, F, N, targetMode, targetLength, speed, useRife, snap, outputFps, keepExtra }) {
  F = parseFloat(F) > 0 ? parseFloat(F) : 30;
  N = Math.max(0, parseInt(N, 10) || 0);
  D = parseFloat(D) > 0 ? parseFloat(D) : (N > 0 ? N / F : 0);
  let Fp = outputFps != null && parseFloat(outputFps) > 0 ? parseFloat(outputFps) : F;
  const keep = (keepExtra === 'fps' || keepExtra === 'length') ? keepExtra : 'trim';

  let S, T;
  if (targetMode === 'length') {
    const tl = parseFloat(targetLength);
    T = Math.max(0.1, tl > 0 ? tl : (speed > 0 ? D / speed : D));
    S = D > 0 && T > 0 ? D / T : parseFloat(speed);
  } else {
    S = parseFloat(speed) > 0 ? parseFloat(speed) : 1;
    T = D > 0 && S > 0 ? D / S : D;
  }
  S = clamp(S, 0.1, 10);
  T = Math.max(0.1, T || D);

  const ratio = F > 0 ? Fp / F : 1;
  let M = null;
  let G = 0;
  let snapped = false;
  if (useRife) {
    if (snap && targetMode === 'multiplier') {
      const K = S > 0 ? ratio / S : 2;
      M = snapRifeMult(K);
      S = ratio / M;
      T = D > 0 ? D / S : T;
      snapped = true;
    }
    const K = S > 0 ? ratio / S : 2;
    M = nextRifeMult(K);
    G = N * M;
  }

  let R = T * Fp;
  let extra = useRife ? Math.max(0, G - R) : 0;
  let keptMode = null;
  if (useRife && extra > 0.5 && keep !== 'trim') {
    // Keep the Change — spend the overage instead of dropping it.
    if (keep === 'fps') {
      Fp = G / T;
      R = G;
      extra = 0;
    } else {
      T = G / Fp;
      S = D > 0 && T > 0 ? D / T : S;
      R = G;
      extra = 0;
    }
    keptMode = keep;
  }
  return {
    srcDuration: D,
    srcFps: F,
    srcFrames: N,
    targetMode,
    exactSpeed: S,
    finalDuration: T,
    finalFps: Fp,
    targetFrames: R,
    rifeMultiplier: useRife ? M : null,
    generatedFrames: useRife ? G : null,
    extraFrames: useRife ? extra : null,
    keptMode,
    snapped,
  };
}

window.__usResolvePlan = resolveUsPlan;

// ── Probe ─────────────────────────────────────────────────────────────────

function srcProbe() {
  const gi = window.globalInputs || {};
  // Tab input wins; global inputs are only a fallback base (pool selection).
  const full = parseInt(_probeCache.frames, 10)
    || parseInt(gi.totalFrames, 10)
    || parseInt((gi.frameCount || _probeCache.frames), 10)
    || 0;
  const fps = _probeCache.fps > 0 ? _probeCache.fps : 24;
  // Global frame-range (if any) clips the count — mirrors the backend, which
  // computes n = end − start + 1 when a range is sent.
  const start = parseInt(gi.frameStart, 10) || 1;
  const rawEnd = parseInt(gi.frameEnd, 10) || full || 1;
  let frames = full;
  if (full > 0) {
    const end = Math.min(rawEnd, full);
    const rangeActive = start > 1 || (rawEnd > 0 && rawEnd !== 1 && rawEnd < full);
    if (rangeActive) frames = Math.max(1, end - start + 1);
  }
  return {
    frames: frames > 0 ? frames : full,
    fps,
    duration: frames > 0 ? frames / fps : _probeCache.duration,
    full,
  };
}

async function refreshUsProbe() {
  const path = (document.getElementById('usInput')?.value || '').trim()
    || (window.globalInputs && window.globalInputs.video
      ? window.globalInputs.video.split('\n').map((l) => l.trim()).filter(Boolean)[0]
      : '');
  if (!path) {
    renderUsPlan();
    return;
  }
  const over = window.__usProbeOverride;
  if (over && over.frames > 0) {
    _probeCache = {
      path,
      frames: over.frames,
      fps: parseFloat(over.fps) || 24,
      duration: parseFloat(over.duration) || 0,
    };
    renderUsPlan();
    return;
  }
  if (_probeCache.path === path && _probeCache.frames > 0) {
    renderUsPlan();
    return;
  }
  try {
    const res = await fetch(`/api/probe?path=${encodeURIComponent(path)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;
    _probeCache = {
      path,
      frames: data.true_frames || data.frame_count || 0,
      fps: parseFloat(data.fps) || 24,
      duration: parseFloat(data.duration) || 0,
    };
  } catch (_) { /* ignore */ }
  renderUsPlan();
}

// ── Readout ───────────────────────────────────────────────────────────────

function readoutEls() {
  const g = (id) => document.getElementById(id);
  return {
    exactSpeed: g('usExactSpeed'),
    finalDuration: g('usFinalDuration'),
    finalFps: g('usFinalFps'),
    targetFrames: g('usTargetFrames'),
    rifeRow: g('usRifeRow'),
    rifeMult: g('usRifeMult'),
    generated: g('usGeneratedFrames'),
    generatedRow: g('usGeneratedRow'),
  };
}

function renderUsPlan() {
  const els = readoutEls();
  if (!els.exactSpeed) return;

  const probe = srcProbe();
  const placeholder = document.getElementById('usReadoutPlaceholder');
  const body = document.getElementById('usReadoutBody');
  if (!probe.frames) {
    if (placeholder) placeholder.style.display = '';
    if (body) body.style.display = 'none';
    return;
  }
  if (placeholder) placeholder.style.display = 'none';
  if (body) body.style.display = '';

  const mode = document.getElementById('usMode')?.value || 'multiplier';
  const lenRaw = document.getElementById('usLength')?.value || '';
  const lengthVal = parseFloat(lenRaw);
  const speedVal = parseFloat(document.getElementById('usSpeed')?.value || '1') || 1;
  const useRife = document.getElementById('usRife')?.value === '1';
  const snap = document.getElementById('usSnap')?.value === '1';
  const fpsMatch = document.getElementById('usFpsMatch')?.value === '1';
  const fpsRaw = parseFloat(document.getElementById('usFps')?.value || '0');
  const outputFps = !fpsMatch && fpsRaw > 0 ? fpsRaw : probe.fps;
  const keepExtra = document.getElementById('usKeepExtra')?.value || 'trim';

  const plan = resolveUsPlan({
    D: probe.duration,
    F: probe.fps,
    N: probe.frames,
    targetMode: mode,
    targetLength: lengthVal > 0 ? lengthVal : (mode === 'length' ? speedVal : null),
    speed: speedVal,
    useRife,
    snap,
    outputFps,
    keepExtra,
  });

  const orig = document.getElementById('usOrigProps');
  if (orig) {
    orig.innerHTML = `Original: <b>${plan.srcDuration.toFixed(2)}s</b> @ <b>${plan.srcFps} FPS</b> (<b>${plan.srcFrames.toLocaleString()} frames</b>)`;
  }
  els.exactSpeed.textContent = plan.exactSpeed.toFixed(2) + '×' + (plan.snapped ? ' (snapped)' : '');
  els.finalDuration.textContent = plan.finalDuration.toFixed(2) + 's';
  els.finalFps.textContent = plan.finalFps + ' FPS' + (plan.finalFps !== plan.srcFps ? ` (source ${plan.srcFps})` : '');
  els.targetFrames.textContent = Math.round(plan.targetFrames).toLocaleString();

  if (els.rifeRow && els.rifeMult && els.generated) {
    const showRife = useRife && plan.rifeMultiplier != null;
    els.rifeRow.style.display = showRife ? '' : 'none';
    if (els.generatedRow) els.generatedRow.style.display = showRife ? '' : 'none';
    if (showRife) {
      els.rifeMult.textContent = plan.rifeMultiplier + '×';
      els.generated.textContent = plan.generatedFrames.toLocaleString();
      if (plan.keptMode) {
        const note = plan.keptMode === 'fps'
          ? ` (encode all @ ${plan.finalFps} FPS)`
          : ` (encode all → ${plan.finalDuration.toFixed(2)}s)`;
        els.generated.textContent += note;
      } else if (plan.extraFrames > 0.5) {
        const label = Math.round(plan.targetFrames).toLocaleString();
        els.generated.textContent += ` (dropping ${Math.round(plan.extraFrames)} → ${label})`;
      }
    }
  }

  // Keep the hidden speed input in sync with a snapped value so the API body
  // carries the exact multiplier the readout promises.
  if (plan.snapped) {
    const spd = document.getElementById('usSpeed');
    const spdVal = document.getElementById('usSpeedVal');
    if (spd) spd.value = section(plan.exactSpeed, 4);
    if (spdVal) {
      const fmt = section(plan.exactSpeed, 2);
      if (document.activeElement !== spdVal) spdVal.value = fmt;
    }
  }

  // Keep the Auto row's knob readout live with the derived value, so the
  // disabled control still shows what the plan is actually using.
  if (mode === 'length') {
    const spdVal = document.getElementById('usSpeedVal');
    if (spdVal && document.activeElement !== spdVal) spdVal.value = section(plan.exactSpeed, 2);
  } else {
    const lenVal = document.getElementById('usLengthVal');
    if (lenVal && document.activeElement !== lenVal) lenVal.value = section(plan.finalDuration, 1);
  }
}

function section(v, n) {
  return Number(v.toFixed(n)).toString();
}

// ── Form ──────────────────────────────────────────────────────────────────

function syncModeRows() {
  const mode = document.getElementById('usMode')?.value || 'multiplier';
  const lengthRow = document.getElementById('usLengthRow');
  const speedRow = document.getElementById('usSpeedRow');
  const useRife = document.getElementById('usRife')?.value === '1';
  const snapRow = document.getElementById('usSnapRow');
  const keepRow = document.getElementById('usKeepRow');

  if (speedRow) speedRow.classList.toggle('is-auto', mode === 'length');
  if (lengthRow) lengthRow.classList.toggle('is-auto', mode === 'multiplier');
  if (snapRow) snapRow.style.display = (mode === 'multiplier' && useRife) ? '' : 'none';
  if (keepRow) keepRow.style.display = useRife ? '' : 'none';
  document.querySelectorAll('[data-ca]').forEach((b) => {
    const active = (b.dataset.ca === mode) === (b.dataset.target === 'ctrl');
    b.classList.toggle('active', active);
  });

  const fpsMatch = document.getElementById('usFpsMatch')?.value === '1';
  const fpsRow = document.getElementById('usFpsRow');
  if (fpsRow) fpsRow.style.display = fpsMatch ? 'none' : '';
  if (!fpsMatch) {
    const hidden = document.getElementById('usFps');
    const disp = document.getElementById('usFpsVal');
    const probe = srcProbe();
    // 0 / 1 are the "not yet chosen" sentinels (knob min clamps 0 → 1) —
    // prefill with the source rate so the readout is meaningful immediately.
    if (hidden && !(parseFloat(hidden.value) > 1) && probe.fps > 0) {
      hidden.value = String(probe.fps);
      if (disp) disp.value = String(probe.fps);
    }
  }

  const keepBtn = document.getElementById('usKeepFps');
  const keep = document.getElementById('usKeepExtra');
  // Output FPS on Auto·Match pins the rate, so 'fps (raise)' is impossible.
  if (keepBtn) keepBtn.disabled = fpsMatch;
  if (keep && keep.value === 'fps' && fpsMatch) keep.value = 'trim';
  document.querySelectorAll('[data-keep]').forEach((b) => {
    b.classList.toggle('active', b.dataset.keep === (keep?.value || 'trim'));
  });
  if (keepBtn) keepBtn.classList.toggle('disabled', fpsMatch);

  renderUsPlan();
}

function setControlMode(mode) {
  const hidden = document.getElementById('usMode');
  if (hidden) hidden.value = mode === 'length' ? 'length' : 'multiplier';
  syncModeRows();
}

function renderSpeedChangeForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>Speed &amp; Time</h3>
      <p class="dream-hint">
        Unified time control — pick a Target Length or Target Multiplier as the
        source of truth, then an Output FPS (match source or custom). Optional
        RIFE generates smooth in-between frames for slow-motion.
      </p>
    </div>

    <div class="form-row">
      <label for="usInput">Input</label>
      <div class="input-row">
        <input type="text" id="usInput" placeholder="/absolute/path/to/video.mp4">
        <button class="btn" type="button" id="btnUsBrowseIn">Browse</button>
      </div>
    </div>
    <div class="form-row">
      <label for="usOutput">Output</label>
      <div class="input-row">
        <input type="text" id="usOutput" placeholder="blank = auto next to source">
        <button class="btn" type="button" id="btnUsBrowseOut">Save As</button>
      </div>
    </div>

    <div id="usSpeedRow" class="knob-row ca-row">
      <div class="knob-bank">
        <div class="ca-toggle">
          <span class="ca-title">Multiplier</span>
          <div class="segmented seg-mini">
            <input type="hidden" id="usMode" value="multiplier">
            <button type="button" class="seg-seg" data-ca="multiplier" data-target="ctrl">Control</button>
            <button type="button" class="seg-seg" data-ca="multiplier" data-target="auto">Auto</button>
          </div>
        </div>
        ${knobUnitHtml({ id: 'usSpeed', label: 'Speed ×', value: '1' })}
      </div>
      <p class="knob-row-legend">
        <strong>Speed × (Multiplier)</strong> — 2 = faster, 0.5 = half speed.
        <em>Auto</em> derives it from your Target Length.
      </p>
    </div>

    <div id="usLengthRow" class="knob-row ca-row is-auto">
      <div class="knob-bank">
        <div class="ca-toggle">
          <span class="ca-title">Target Length</span>
          <div class="segmented seg-mini">
            <button type="button" class="seg-seg" data-ca="length" data-target="ctrl">Control</button>
            <button type="button" class="seg-seg" data-ca="length" data-target="auto">Auto</button>
          </div>
        </div>
        ${knobUnitHtml({ id: 'usLength', label: 'Length (s)', value: '10' })}
      </div>
      <p class="knob-row-legend">
        <strong>Target Length</strong> — exact output duration; multiplier is derived (<code>Input ÷ Target</code>).
        <em>Auto</em> derives the length from your Multiplier.
      </p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'usFpsMatch', label: 'Output FPS', value: '1', binary: true, leftCap: 'Auto · Match', rightCap: 'Control' })}
      </div>
      <p class="knob-row-legend">
        <strong>Output FPS</strong> — <strong>Auto</strong> locks the rate to the source (Match).
        <strong>Control</strong> retimes to an exact custom rate (RIFE creates in-between frames).
      </p>
    </div>

    <div id="usFpsRow" class="knob-row" style="display:none">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'usFps', label: 'Custom FPS', value: '0' })}
      </div>
      <p class="knob-row-legend">
        <strong>Custom FPS</strong> — exact target rate. With RIFE the generated frames are
        conformed to hit this rate; without RIFE frames are re-timed (duplicate/drop).
      </p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'usRife', label: 'RIFE', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'usTta', label: 'TTA', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'usUhd', label: 'UHD', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'usDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">
        <strong>RIFE</strong> interpolates N×M frames for smooth slow-mo, then conforms to the exact duration.<br>
        <strong>TTA</strong> cleaner/~2× slower · <strong>UHD</strong> 4K+.
      </p>
    </div>

    <div id="usSnapRow" class="knob-row" style="display:none">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'usSnap', label: 'Mode', value: '1', binary: true, leftCap: 'Snap', rightCap: 'Free' })}
      </div>
      <p class="knob-row-legend">
        <strong>Snap</strong> locks speed to exact RIFE rates (no extras) · <strong>Free</strong> generates
        extra frames — <em>Keep the Change</em> decides what happens to them.
      </p>
    </div>

    <div id="usKeepRow" class="knob-row" style="display:none">
      <div class="knob-bank">
        <input type="hidden" id="usKeepExtra" value="trim">
        <div class="segmented keep-seg">
          <button type="button" class="seg-seg" data-keep="trim">Trim (exact)</button>
          <button type="button" class="seg-seg" id="usKeepFps" data-keep="fps">FPS (raise)</button>
          <button type="button" class="seg-seg" data-keep="length">Length (stretch)</button>
        </div>
      </div>
      <p class="knob-row-legend">
        <strong>Keep the Change</strong> — extra generated frames: <strong>Trim</strong> drops them for the
        exact target · <strong>FPS</strong> encodes all frames at a raised rate (needs Output FPS on Control) ·
        <strong>Length</strong> encodes all frames and stretches the duration.
      </p>
    </div>

    ${rifeModelSelectHtml('usRifeModel', { label: 'RIFE model' })}

    <div class="form-row">
      <label for="usAudio">Audio</label>
      <select id="usAudio">
        <option value="preserve" selected>Preserve pitch (atempo)</option>
        <option value="pitch">Pitch shift with speed</option>
        <option value="drop">Drop audio</option>
      </select>
    </div>

    <div id="usReadout" class="us-readout">
      <div id="usReadoutPlaceholder" class="us-placeholder">Probe a video to see the target math.</div>
      <div id="usReadoutBody" style="display:none">
        <div class="us-original" id="usOrigProps"></div>
        <div class="us-grid">
          <div class="us-cell"><span class="us-label">Exact Speed</span><span class="us-val" id="usExactSpeed">—</span></div>
          <div class="us-cell"><span class="us-label">Final Duration</span><span class="us-val" id="usFinalDuration">—</span></div>
          <div class="us-cell"><span class="us-label">Final FPS</span><span class="us-val" id="usFinalFps">—</span></div>
          <div class="us-cell"><span class="us-label">Target Total Frames</span><span class="us-val" id="usTargetFrames">—</span></div>
          <div class="us-cell" id="usRifeRow" style="display:none">
            <span class="us-label">Required RIFE Multiplier</span><span class="us-val" id="usRifeMult">—</span>
          </div>
          <div class="us-cell" id="usGeneratedRow" style="display:none">
            <span class="us-label">Generated Total Frames</span><span class="us-val" id="usGeneratedFrames">—</span>
          </div>
        </div>
      </div>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  setupBinaryKnob({
    knobId: 'usRifeKnob', indicatorId: 'usRifeKnobInd', hiddenId: 'usRife',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'usSnapKnob', indicatorId: 'usSnapKnobInd', hiddenId: 'usSnap',
    leftValue: '1', rightValue: '0', initial: '1',
  });
  setupBinaryKnob({
    knobId: 'usTtaKnob', indicatorId: 'usTtaKnobInd', hiddenId: 'usTta',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'usUhdKnob', indicatorId: 'usUhdKnobInd', hiddenId: 'usUhd',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'usDryRunKnob', indicatorId: 'usDryRunKnobInd', hiddenId: 'usDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'usFpsMatchKnob', indicatorId: 'usFpsMatchKnobInd', hiddenId: 'usFpsMatch',
    leftValue: '1', rightValue: '0', initial: '1',
  });

  const planEls = ['usSpeed', 'usLength', 'usRife', 'usSnap', 'usFpsMatch', 'usKeepExtra'];
  planEls.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => { syncModeRows(); renderUsPlan(); });
    el.addEventListener('input', renderUsPlan);
  });
  // Continuous knobs never fire a change/input event — wire their onChange
  // hook (runs on drag, wheel, and text commit) straight to the readout.
  setupContinuousKnob({
    knobId: 'usSpeedKnob', indicatorId: 'usSpeedKnobInd', valueId: 'usSpeedVal', hiddenId: 'usSpeed',
    min: 0.1, max: 10, step: 0.05, decimals: 2,
    format: (v) => Number(v.toFixed(2)) + '×',
    onChange: renderUsPlan,
  });
  setupContinuousKnob({
    knobId: 'usLengthKnob', indicatorId: 'usLengthKnobInd', valueId: 'usLengthVal', hiddenId: 'usLength',
    min: 0.1, max: 600, step: 0.1, decimals: 1,
    onChange: renderUsPlan,
  });
  setupContinuousKnob({
    knobId: 'usFpsKnob', indicatorId: 'usFpsKnobInd', valueId: 'usFpsVal', hiddenId: 'usFps',
    min: 1, max: 240, step: 1, decimals: 1,
    onChange: renderUsPlan,
  });
  // Typing directly into a knob's numeric readout updates the hidden input
  // via onTextSubmit — the readout must re-render on that commit too.
  ['usSpeedVal', 'usLengthVal', 'usFpsVal'].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener('change', renderUsPlan);
    el?.addEventListener('input', renderUsPlan);
    el?.addEventListener('blur', renderUsPlan);
  });

  document.querySelectorAll('[data-ca]').forEach((b) => {
    b.addEventListener('click', () => {
      // Control on a row activates that row's variable; Auto activates the other.
      const row = b.dataset.ca;
      const mode = b.dataset.target === 'ctrl' ? row : (row === 'multiplier' ? 'length' : 'multiplier');
      setControlMode(mode);
    });
  });
  document.querySelectorAll('[data-keep]').forEach((b) => {
    b.addEventListener('click', () => {
      const keep = document.getElementById('usKeepExtra');
      if (!keep) return;
      if (b.dataset.keep === 'fps' && document.getElementById('usFpsMatch')?.value === '1') return;
      keep.value = b.dataset.keep;
      syncModeRows();
    });
  });

  syncModeRows();

  document.addEventListener('mtapi:frame-range', renderUsPlan);
  document.addEventListener('mtapi:video-probed', () => { _probeCache.path = ''; refreshUsProbe(); });

  document.getElementById('btnUsBrowseIn')?.addEventListener('click', () => {
    openFileBrowser('usInput', false, 'file', 'video');
    setTimeout(refreshUsProbe, 500);
  });
  document.getElementById('usInput')?.addEventListener('change', () => {
    _probeCache.path = '';
    refreshUsProbe();
  });
  document.getElementById('btnUsBrowseOut')?.addEventListener('click', () => {
    openFileBrowser('usOutput', true, 'file', 'video');
  });

  refreshUsProbe();
}

function collectSpeedChangeBody() {
  const input = bestInput('usInput');
  if (!input) {
    alert('Please provide an input video path.');
    return null;
  }
  const mode = document.getElementById('usMode')?.value || 'multiplier';
  const useRife = document.getElementById('usRife')?.value === '1';
  const snap = mode === 'multiplier' && document.getElementById('usSnap')?.value === '1';

  const probe = srcProbe();
  const lenRaw = parseFloat(document.getElementById('usLength')?.value || '0');
  const spdRaw = parseFloat(document.getElementById('usSpeed')?.value || '1') || 1;
  const keepExtra = document.getElementById('usKeepExtra')?.value || 'trim';
  const fpsMatch = document.getElementById('usFpsMatch')?.value === '1';
  const plan = resolveUsPlan({
    D: probe.duration, F: probe.fps, N: probe.frames,
    targetMode: mode,
    targetLength: lenRaw > 0 ? lenRaw : (mode === 'length' ? spdRaw : null),
    speed: spdRaw,
    useRife,
    snap,
    outputFps: !fpsMatch ? (parseFloat(document.getElementById('usFps')?.value || '0') || probe.fps) : probe.fps,
    keepExtra,
  });

  const common = {
    input_path: input,
    output_path: document.getElementById('usOutput')?.value?.trim() || null,
    target_mode: mode,
    use_rife: useRife,
    rife_snap: snap,
    audio_mode: document.getElementById('usAudio')?.value || 'preserve',
    model: document.getElementById('usRifeModel')?.value || 'rife-v4.6',
    tta: document.getElementById('usTta')?.value === '1',
    uhd: document.getElementById('usUhd')?.value === '1',
    dry_run: document.getElementById('usDryRun')?.value === '1',
  };
  const fpsRaw = parseFloat(document.getElementById('usFps')?.value || '0');
  if (!fpsMatch && fpsRaw > 0) common.target_fps = fpsRaw;
  common.speed = plan.exactSpeed;
  if (mode === 'length') common.target_length = plan.finalDuration;
  if (useRife && !snap) {
    common.keep_extra = (fpsMatch || keepExtra !== 'fps') ? keepExtra : 'trim';
  }
  return withFrameRange(common);
}

export { renderSpeedChangeForm, collectSpeedChangeBody };