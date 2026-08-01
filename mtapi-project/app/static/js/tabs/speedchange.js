import { elements, bestInput } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { withFrameRange } from '/js/utils.js';

// ── Speed Change (uniform) + optional RIFE for frame budget ───────────────

/** Last probe snapshot for budget math (filled by refreshSpeedProbe). */
let _probeCache = { path: '', frames: 0, fps: 24, duration: 0 };

function _srcProbe() {
  const gi = window.globalInputs || {};
  const frames = parseInt(gi.totalFrames, 10) || _probeCache.frames || 0;
  const fps = (_probeCache.fps > 0 ? _probeCache.fps : 24);
  const start = parseInt(gi.frameStart, 10) || 1;
  const end = parseInt(gi.frameEnd, 10) || frames || 1;
  const span = frames > 0 ? Math.max(1, Math.min(end, frames) - start + 1) : frames;
  return { frames: span > 0 ? span : frames, fps, full: frames };
}

async function refreshSpeedProbe() {
  const path = (document.getElementById('scInput')?.value || '').trim()
    || (window.globalInputs && window.globalInputs.video
      ? window.globalInputs.video.split('\n').map((l) => l.trim()).filter(Boolean)[0]
      : '');
  if (!path) {
    updateSpeedBudgetUi();
    return;
  }
  if (_probeCache.path === path && _probeCache.frames > 0) {
    updateSpeedBudgetUi();
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
  updateSpeedBudgetUi();
}

function frameBudget(srcFrames, srcFps, speed, targetFps, useRife, mult) {
  const n = Math.max(0, srcFrames | 0);
  const f = srcFps > 0 ? srcFps : 24;
  const s = speed > 0 ? speed : 1;
  const tf = targetFps > 0 ? targetFps : f;
  const dur = n / f;
  const outDur = dur / s;
  const needed = outDur * tf;
  const m = useRife ? Math.max(2, mult | 0) : 1;
  const available = n * m;
  let suggested = 1;
  if (n > 0 && needed > n) {
    suggested = Math.min(8, Math.max(2, Math.ceil(needed / n)));
  }
  return {
    needed,
    available,
    outDur,
    ok: available + 0.01 >= needed,
    suggested,
    srcFps: f,
    targetFps: tf,
  };
}

function updateSpeedBudgetUi() {
  const el = document.getElementById('scBudget');
  if (!el) return;
  const speed = parseFloat(document.getElementById('scSpeed')?.value || '1') || 1;
  let targetFps = parseFloat(document.getElementById('scTargetFps')?.value || '0');
  const useRife = document.getElementById('scUseRife')?.value === '1';
  const mult = parseInt(document.getElementById('scRifeMult')?.value || '2', 10);
  const probe = _srcProbe();
  // If user left target at 0, treat as source fps (budget uses same)
  if (!targetFps || targetFps <= 0) targetFps = probe.fps;

  const b = frameBudget(probe.frames, probe.fps, speed, targetFps, useRife, mult);
  if (!probe.frames) {
    el.className = 'sc-budget muted';
    el.textContent = 'Probe a video (global Video bar) to check frame budget.';
    return;
  }
  const need = b.needed.toFixed(1);
  const have = String(b.available);
  const outDur = b.outDur.toFixed(2);
  if (b.ok) {
    el.className = 'sc-budget ok';
    el.textContent = `OK · need ~${need} frames for ${outDur}s @ ${b.targetFps}fps · have ${have}`
      + (useRife ? ` (RIFE ×${mult})` : '');
  } else {
    el.className = 'sc-budget short';
    el.textContent = `SHORT · need ~${need} frames for ${outDur}s @ ${b.targetFps}fps · have ${have}`
      + ` · enable RIFE ×${b.suggested}+ or lower speed/fps`;
  }
}

function renderSpeedChangeForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>Speed Change</h3>
      <p class="dream-hint">
        Uniform speed (setpts + atempo). Optional RIFE when slow-mo needs more frames for a target FPS.
      </p>
    </div>

    <div class="form-row">
      <label for="scInput">Input</label>
      <div class="input-row">
        <input type="text" id="scInput" placeholder="/absolute/path/to/video.mp4">
        <button class="btn" type="button" id="btnScBrowseIn">Browse</button>
      </div>
    </div>
    <div class="form-row">
      <label for="scOutput">Output</label>
      <div class="input-row">
        <input type="text" id="scOutput" placeholder="blank = auto next to source">
        <button class="btn" type="button" id="btnScBrowseOut">Save As</button>
      </div>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'scSpeed', label: 'Speed ×', value: '1.0' })}
        ${knobUnitHtml({ id: 'scTargetFps', label: 'Target FPS', value: '0' })}
        ${knobUnitHtml({ id: 'scDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">
        <strong>Speed ×</strong> — 2 = faster, 0.5 = half speed.<br>
        <strong>Target FPS</strong> — 0 = keep source rate after speed.
      </p>
    </div>

    <div id="scBudget" class="sc-budget muted">Probe a video to check frame budget.</div>

    <div class="form-row">
      <label for="scAudio">Audio</label>
      <select id="scAudio">
        <option value="preserve" selected>Preserve pitch (atempo)</option>
        <option value="pitch">Pitch shift with speed</option>
        <option value="drop">Drop audio</option>
      </select>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'scUseRife', label: 'Use RIFE', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'scRifeMult', label: 'Frame ×', value: '2' })}
        ${knobUnitHtml({ id: 'scRifeTta', label: 'TTA', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'scRifeUhd', label: 'UHD', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      </div>
      <p class="knob-row-legend">
        RIFE multiplies frames before speed encode — use when budget is red.<br>
        <strong>TTA</strong> cleaner/~2× slower · <strong>UHD</strong> 4K+.
      </p>
    </div>
    <div class="form-row" id="scRifeModelRow">
      <label for="scRifeModel">RIFE model</label>
      <select id="scRifeModel">
        <option value="rife-v4.6" selected>rife-v4.6</option>
        <option value="rife-v4">rife-v4</option>
        <option value="rife-v2.4">rife-v2.4</option>
        <option value="rife-v2.3">rife-v2.3</option>
      </select>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  setupContinuousKnob({
    knobId: 'scSpeedKnob', indicatorId: 'scSpeedKnobInd', valueId: 'scSpeedVal', hiddenId: 'scSpeed',
    min: 0.1, max: 8, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'scTargetFpsKnob', indicatorId: 'scTargetFpsKnobInd', valueId: 'scTargetFpsVal', hiddenId: 'scTargetFps',
    min: 0, max: 120, step: 1, decimals: 0,
    format: (v) => (v <= 0 ? 'src' : String(Math.round(v))),
  });
  setupBinaryKnob({
    knobId: 'scDryRunKnob', indicatorId: 'scDryRunKnobInd', hiddenId: 'scDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'scUseRifeKnob', indicatorId: 'scUseRifeKnobInd', hiddenId: 'scUseRife',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupContinuousKnob({
    knobId: 'scRifeMultKnob', indicatorId: 'scRifeMultKnobInd', valueId: 'scRifeMultVal', hiddenId: 'scRifeMult',
    min: 2, max: 8, step: 1, decimals: 0,
  });
  setupBinaryKnob({
    knobId: 'scRifeTtaKnob', indicatorId: 'scRifeTtaKnobInd', hiddenId: 'scRifeTta',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'scRifeUhdKnob', indicatorId: 'scRifeUhdKnobInd', hiddenId: 'scRifeUhd',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  function syncRifeRow() {
    const on = document.getElementById('scUseRife')?.value === '1';
    const row = document.getElementById('scRifeModelRow');
    if (row) row.style.opacity = on ? '1' : '0.45';
  }
  syncRifeRow();
  refreshSpeedProbe();

  ['scSpeed', 'scTargetFps', 'scUseRife', 'scRifeMult'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => { syncRifeRow(); updateSpeedBudgetUi(); });
    el.addEventListener('input', () => { updateSpeedBudgetUi(); });
  });
  document.querySelectorAll('#scSpeedKnob, #scTargetFpsKnob, #scUseRifeKnob, #scRifeMultKnob').forEach((k) => {
    k?.addEventListener('click', () => setTimeout(updateSpeedBudgetUi, 50));
    k?.addEventListener('pointerup', () => setTimeout(updateSpeedBudgetUi, 50));
  });
  document.addEventListener('mtapi:frame-range', updateSpeedBudgetUi);
  document.addEventListener('mtapi:video-probed', () => { _probeCache.path = ''; refreshSpeedProbe(); });

  document.getElementById('btnScBrowseIn')?.addEventListener('click', () => {
    openFileBrowser('scInput', false, 'file', 'video');
    setTimeout(refreshSpeedProbe, 500);
  });
  document.getElementById('scInput')?.addEventListener('change', () => {
    _probeCache.path = '';
    refreshSpeedProbe();
  });
  document.getElementById('btnScBrowseOut')?.addEventListener('click', () => {
    openFileBrowser('scOutput', true, 'file', 'video');
  });
}

function collectSpeedChangeBody() {
  const input = bestInput('scInput');
  if (!input) {
    alert('Please provide an input video path.');
    return null;
  }
  const speed = parseFloat(document.getElementById('scSpeed')?.value || '1');
  let targetFps = parseFloat(document.getElementById('scTargetFps')?.value || '0');
  if (!targetFps || targetFps <= 0) targetFps = null;
  const useRife = document.getElementById('scUseRife')?.value === '1';

  return withFrameRange({
    input_path: input,
    output_path: document.getElementById('scOutput')?.value?.trim() || null,
    speed,
    target_fps: targetFps,
    audio_mode: document.getElementById('scAudio')?.value || 'preserve',
    use_rife: useRife,
    multiplier: parseInt(document.getElementById('scRifeMult')?.value || '2', 10),
    model: document.getElementById('scRifeModel')?.value || 'rife-v4.6',
    tta: document.getElementById('scRifeTta')?.value === '1',
    uhd: document.getElementById('scRifeUhd')?.value === '1',
    dry_run: document.getElementById('scDryRun')?.value === '1',
  });
}

export { renderSpeedChangeForm, collectSpeedChangeBody, updateSpeedBudgetUi };
