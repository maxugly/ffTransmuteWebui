import { state, elements, resolveGlobalImages, bestInput, showPreview } from '/app.js';
import { basename, escapeHtml, withFrameRange, isVideoPath, isImagePath } from '/js/utils.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { runOpWithCancel } from '/js/job-control.js';
import {
  evolveRifeModelSelectHtml,
  evolveRifeKnobUnitsHtml,
  setupEvolveRifeKnobs,
  collectEvolveRifeFields,
  setupEvolveMasterToggle,
} from '/js/ui/evolve-rife.js';
import { registerListKeys } from '/js/ui/list-keys.js';

// ── Style Transfer tab (Magenta arbitrary stylization) ───────────────────
// Images: batch stills via engine. Video: dump → filters.styletransfer → encode.

function renderStyleTransferForm() {
  const contents = state.styleTransfer.contents || [];
  if (state.styleTransfer.selected == null) state.styleTransfer.selected = 0;
  if (contents.length && state.styleTransfer.selected >= contents.length) {
    state.styleTransfer.selected = contents.length - 1;
  }
  const sel = state.styleTransfer.selected | 0;
  const stylePath = state.styleTransfer.stylePath;
  const listHtml = contents.length
    ? contents.map((it, i) => {
        const kind = isVideoPath(it.path) ? 'video' : (isImagePath(it.path) ? 'image' : 'path');
        return `
        <div class="fm-item${i === sel ? ' is-selected' : ''}" data-idx="${i}">
          <span class="fm-ord">${String(i + 1).padStart(2, '0')}</span>
          <span class="fm-badge" data-help-title="${kind}">${kind === 'video' ? '▶' : '🖼'}</span>
          <span class="fm-name" data-help-title="${escapeHtml(it.path)}">${escapeHtml(it.name || basename(it.path))}</span>
          <button type="button" class="btn fm-rm" data-idx="${i}" data-st="1">✕</button>
        </div>`;
      }).join('')
    : `<div class="fm-empty">Add content photo(s) and/or one video. Arrows select · Ctrl+arrows reorder.</div>`;

  const hasVideo = contents.some((c) => isVideoPath(c.path));

  const html = `
    <div class="panel-title-desc dense">
      <h3>Neural style transfer</h3>
      <p class="dream-hint">
        CPU = Magenta arbitrary stylization (~90&nbsp;MB). GPU = OpenVINO AdaIN on the iGPU
        (needs one-time Setup below). Stills batch · video = dump → per-frame → encode.
        ${hasVideo ? ' <strong>Video mode:</strong> one clip (not mixed with stills).' : ''}
      </p>
    </div>
    <div class="form-row">
      <label for="stEngine">Engine</label>
      <select id="stEngine" data-help-title="Engine — CPU / GPU" data-help-text="CPU = Magenta arbitrary stylization (~90 MB). GPU = OpenVINO AdaIN on the iGPU (needs one-time GPU Setup below).">
        <option value="cpu">CPU · Magenta (existing)</option>
        <option value="gpu">GPU · OpenVINO AdaIN (iGPU)</option>
      </select>
      <span class="form-row-hint" id="stOvStatus">GPU status: checking…</span>
    </div>
    <div class="form-row st-gpu-only hidden" id="stGpuSetupRow">
      <button type="button" class="btn" id="btnStOvSetup">GPU Setup</button>
      <button type="button" class="btn" id="btnStOvRefresh">Refresh</button>
      <span class="form-row-hint">One-time IR install + CPU smoke + GPU probe.</span>
    </div>
    <div class="knob-row settings-inline-warm">
      <div class="knob-bank">${knobUnitHtml({ id: 'stWarm', label: 'Keep warm', value: state.settings?.warmModels?.styletransfer ? '1' : '0', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Keep warm — Off / On', helpText: 'Keeps the model resident between runs. On = faster repeat runs, holds VRAM.' })}</div>
      <p class="knob-row-legend">Keep the style-transfer model resident between runs (uses RAM/VRAM).</p>
    </div>

    <div class="form-group" style="margin-bottom:6px">
      <div class="form-row" style="margin-bottom:3px">
        <label>Content (${contents.length})</label>
        <div class="sort-toolbar" style="margin:0; flex:1">
          <button type="button" class="btn btn-primary" id="btnStAddContent">+ Images</button>
          <button type="button" class="btn" id="btnStAddVideo">+ Video</button>
          <button type="button" class="btn" id="btnStAddFolder">+ Folder</button>
          <button type="button" class="btn" id="btnStFromGlobal">Globals</button>
          <button type="button" class="btn" id="btnStClearContent" ${contents.length ? '' : 'disabled'}>Clear</button>
        </div>
        <p class="form-row-hint">stills → <code>*_styled.png</code> · video → <code>*_styled.mp4</code></p>
      </div>
      <div class="fm-list" id="stContentList">${listHtml}</div>
    </div>

    <div class="form-row">
      <label for="stStylePath">Style</label>
      <div class="input-row">
        <input type="text" id="stStylePath" placeholder="required: painting / texture still"
          value="${stylePath ? escapeHtml(stylePath) : ''}" data-help-title="Style — painting / texture still" data-help-text="Absolute path to the style image whose look is transferred. Required for every run.">
        <button type="button" class="btn" id="btnStStyleBrowse" data-help-title="Browse style" data-help-text="Pick the style image (painting / texture).">Browse</button>
      </div>
    </div>
    <div class="form-row">
      <label for="stOutput">Output</label>
      <div class="input-row">
        <input type="text" id="stOutput" placeholder="blank = next to source" data-help-title="Output — blank = next to source" data-help-text="Stylized write target. Blank writes *_styled.png (stills) or *_styled.mp4 (video) next to the source.">
        <button type="button" class="btn" id="btnStOutBrowse" data-help-title="Browse output" data-help-text="Pick where the stylized file is written.">Save As</button>
      </div>
    </div>
    <div class="form-row">
      <label for="stOutputDir">Batch dir</label>
      <div class="input-row">
        <input type="text" id="stOutputDir" placeholder="optional shared folder for stills" data-help-title="Batch dir — shared stills folder" data-help-text="Optional shared folder where styled stills land instead of next to each source. Blank = next to source.">
        <button type="button" class="btn" id="btnStOutDirBrowse" data-help-title="Browse batch dir" data-help-text="Pick the shared folder for styled stills.">Folder</button>
      </div>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'stStrength', label: 'Strength', value: '1.0', helpTitle: 'Strength — style intensity [0–1]', helpText: 'How strongly the style image is applied; 1 = full style. Sane: 0.3–1.0; default 1.0.' })}
        ${knobUnitHtml({ id: 'stMaxSide', label: 'Max side', value: '1280', helpTitle: 'Max side — longest-edge cap [0–2048]', helpText: 'Longest edge is capped to this px. 0 = keep source size; video applies per frame. Sane: 640–2048; default 1280.' })}
        ${knobUnitHtml({ id: 'stDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry', helpTitle: 'Dry run — Run / Dry', helpText: 'Validates params and prints the command without writing output files.' })}
      </div>
      <p class="knob-row-legend">
        <strong>Strength</strong> 1 = full style. <strong>Max side</strong> 0 = full res (video: per frame).
      </p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'stEvolve', label: 'Evolve', value: '0', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Evolve — Off / On', helpText: 'Per-frame drift: ramps style strength over one neural pass (evolve DeepDream-style path) + optional RIFE and writes *_styled_evolve.mp4. Single still content only. Off = single-pass stylization.' })}
      </div>
      <p class="knob-row-legend">
        Strength ramp (one neural pass) → optional RIFE → <code>*_styled_evolve.mp4</code>.
        Single still content only.
      </p>
    </div>
    <div class="st-evolve-only hidden" id="stEvolvePanel">
      ${evolveRifeModelSelectHtml('stEvolve')}
      <div class="knob-row">
        <div class="knob-bank">
          ${knobUnitHtml({ id: 'stEvolveFrames', label: 'Frames', value: '16', helpTitle: 'Frames — evolve length [2–128]', helpText: 'Number of frames the strength ramp spans; more = longer, smoother drift. Sane: 8–64; default 16.' })}
          ${knobUnitHtml({ id: 'stEvolveStr0', label: 'Str start', value: '0', helpTitle: 'Str start — ramp start strength [0–1]', helpText: 'Style strength on the first evolve frame; 0 = off, plain photo start. Sane: 0–0.8; default 0.' })}
          ${knobUnitHtml({ id: 'stEvolveStr1', label: 'Str end', value: '-1', helpTitle: 'Str end — ramp end strength [-1–1]', helpText: 'Style strength on the last evolve frame; −1 = use the main Strength knob instead of a literal end. Sane: 0.3–1; default −1.' })}
          ${knobUnitHtml({ id: 'stEvolveFps', label: 'FPS', value: '12', helpTitle: 'FPS — evolve output rate [1–60]', helpText: 'Frame rate of the evolved video; per file. 0/blank = source or auto. Sane: 8–24; default 12.' })}
          ${evolveRifeKnobUnitsHtml('stEvolve')}
        </div>
        <p class="knob-row-legend">
          <strong>Str end −1</strong> = use main Strength. Linear ramp over Frames.
          RIFE fills between strength keyframes (shared UI + bookend).
        </p>
      </div>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  setupContinuousKnob({
    knobId: 'stStrengthKnob', indicatorId: 'stStrengthKnobInd', valueId: 'stStrengthVal', hiddenId: 'stStrength',
    min: 0, max: 1, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'stMaxSideKnob', indicatorId: 'stMaxSideKnobInd', valueId: 'stMaxSideVal', hiddenId: 'stMaxSide',
    min: 0, max: 2048, step: 64, decimals: 0,
    format: (v) => (v <= 0 ? 'full' : String(Math.round(v))),
  });
  setupBinaryKnob({
    knobId: 'stWarmKnob', indicatorId: 'stWarmKnobInd', hiddenId: 'stWarm',
    leftValue: '0', rightValue: '1', initial: state.settings?.warmModels?.styletransfer ? '1' : '0',
  });
  document.getElementById('stWarm')?.addEventListener('change', (e) => {
    state.settings.warmModels.styletransfer = e.target.value === '1';
    try { localStorage.setItem('mtapi.settings', JSON.stringify(state.settings)); } catch (_) {}
  });
  // ── Engine dropdown (CPU Magenta vs GPU OpenVINO AdaIN) ──
  const engSel = document.getElementById('stEngine');
  if (engSel) {
    engSel.value = state.styleTransfer.engine || 'cpu';
    _syncStGpuRow();
    engSel.addEventListener('change', () => {
      state.styleTransfer.engine = engSel.value;
      _syncStGpuRow();
      if (engSel.value === 'gpu') _refreshStOvStatus();
    });
  }
  document.getElementById('btnStOvSetup')?.addEventListener('click', async () => {
    try {
      await runOpWithCancel('styletransfer_ov_setup', { action: 'install', dry_run: false },
        { label: 'Style-transfer GPU setup (IR install + smoke)…' });
    } catch (_) { /* logged */ }
    _refreshStOvStatus();
  });
  document.getElementById('btnStOvRefresh')?.addEventListener('click', _refreshStOvStatus);
  _refreshStOvStatus();
  setupBinaryKnob({
    knobId: 'stDryRunKnob', indicatorId: 'stDryRunKnobInd', hiddenId: 'stDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupEvolveMasterToggle('stEvolve', '.st-evolve-only');
  setupEvolveRifeKnobs('stEvolve');
  setupContinuousKnob({
    knobId: 'stEvolveFramesKnob', indicatorId: 'stEvolveFramesKnobInd',
    valueId: 'stEvolveFramesVal', hiddenId: 'stEvolveFrames',
    min: 2, max: 128, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'stEvolveStr0Knob', indicatorId: 'stEvolveStr0KnobInd',
    valueId: 'stEvolveStr0Val', hiddenId: 'stEvolveStr0',
    min: 0, max: 1, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'stEvolveStr1Knob', indicatorId: 'stEvolveStr1KnobInd',
    valueId: 'stEvolveStr1Val', hiddenId: 'stEvolveStr1',
    min: -1, max: 1, step: 0.05, decimals: 2,
    format: (v) => (v < 0 ? 'main' : v.toFixed(2)),
  });
  setupContinuousKnob({
    knobId: 'stEvolveFpsKnob', indicatorId: 'stEvolveFpsKnobInd',
    valueId: 'stEvolveFpsVal', hiddenId: 'stEvolveFps',
    min: 1, max: 60, step: 1, decimals: 0,
  });

  const syncStylePath = (e) => {
    state.styleTransfer.stylePath = e.target.value.trim() || null;
  };
  document.getElementById('stStylePath')?.addEventListener('input', syncStylePath);
  document.getElementById('stStylePath')?.addEventListener('change', syncStylePath);

  document.getElementById('btnStAddContent')?.addEventListener('click', async () => {
    await _addPathsFromPicker('files', 'image');
  });
  document.getElementById('btnStAddVideo')?.addEventListener('click', async () => {
    await _addPathsFromPicker('files', 'video');
  });
  document.getElementById('btnStAddFolder')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/picker?mode=dir&filter=all&start_path=`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const p = data.path || (data.paths && data.paths[0]);
      if (!p) return;
      if (state.styleTransfer.contents.some((x) => x.path === p)) return;
      state.styleTransfer.contents.push({ path: p, name: basename(p) + '/' });
      renderStyleTransferForm();
    } catch (err) {
      alert(`Picker failed: ${err.message}`);
    }
  });
  document.getElementById('btnStFromGlobal')?.addEventListener('click', () => {
    const added = _pullFromGlobals();
    if (!added) {
      alert('Global Video / Image bars are empty.');
      return;
    }
    renderStyleTransferForm();
  });
  document.getElementById('btnStClearContent')?.addEventListener('click', () => {
    state.styleTransfer.contents = [];
    renderStyleTransferForm();
  });
  document.getElementById('btnStStyleBrowse')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/picker?mode=files&filter=image&start_path=`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const p = (data.paths && data.paths[0]) || data.path;
      if (p) {
        state.styleTransfer.stylePath = p;
        const el = document.getElementById('stStylePath');
        if (el) el.value = p;
      }
    } catch (err) {
      alert(`Picker failed: ${err.message}`);
    }
  });
  document.getElementById('btnStOutBrowse')?.addEventListener('click', () => {
    openFileBrowser('stOutput', false, 'file_save', 'all');
  });
  document.getElementById('btnStOutDirBrowse')?.addEventListener('click', () => {
    openFileBrowser('stOutputDir', true, 'dir', 'all');
  });
  document.querySelectorAll('.fm-rm[data-st]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx, 10);
      state.styleTransfer.contents.splice(i, 1);
      if (state.styleTransfer.selected >= state.styleTransfer.contents.length) {
        state.styleTransfer.selected = Math.max(0, state.styleTransfer.contents.length - 1);
      }
      renderStyleTransferForm();
    });
  });
  document.getElementById('stContentList')?.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const row = e.target.closest('.fm-item');
    if (!row) return;
    const i = parseInt(row.dataset.idx, 10);
    if (isNaN(i)) return;
    state.styleTransfer.selected = i;
    document.querySelectorAll('#stContentList .fm-item').forEach((el, idx) => {
      el.classList.toggle('is-selected', idx === i);
    });
    const it = state.styleTransfer.contents[i];
    if (it?.path) showPreview(it.path);
  });
}

registerListKeys('styletransfer', {
  getItems: () => state.styleTransfer.contents || [],
  getSelected: () => state.styleTransfer.selected | 0,
  setSelected: (i) => {
    state.styleTransfer.selected = i;
    document.querySelectorAll('#stContentList .fm-item').forEach((el, idx) => {
      el.classList.toggle('is-selected', idx === i);
    });
    const it = state.styleTransfer.contents[i];
    if (it?.path) showPreview(it.path);
  },
  moveItem: (from, to) => {
    const a = state.styleTransfer.contents || [];
    if (from < 0 || to < 0 || from >= a.length || to >= a.length) return;
    const item = a.splice(from, 1)[0];
    a.splice(to, 0, item);
    state.styleTransfer.selected = to;
    renderStyleTransferForm();
  },
});

function _syncStGpuRow() {
  const show = (document.getElementById('stEngine')?.value || 'cpu') === 'gpu';
  document.getElementById('stGpuSetupRow')?.classList.toggle('hidden', !show);
}

async function _refreshStOvStatus() {
  const box = document.getElementById('stOvStatus');
  if (!box) return;
  box.textContent = 'GPU status: checking…';
  try {
    const res = await fetch('/api/styletransfer_ov/status');
    const data = await res.json();
    box.textContent = 'GPU status: IR ' + (data.ir_present ? 'ok' : 'MISSING — run GPU Setup')
      + ' · devices ' + ((data.devices || []).join('/') || '?');
  } catch (err) {
    box.textContent = 'GPU status check failed — ' + err.message;
  }
}

async function _addPathsFromPicker(mode, filter) {  try {
    const res = await fetch(`/api/picker?mode=${mode}&filter=${filter}&start_path=`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const paths = data.paths || (data.path ? [data.path] : []);
    let n = 0;
    paths.forEach((p) => {
      if (!p) return;
      if (state.styleTransfer.contents.some((x) => x.path === p)) return;
      state.styleTransfer.contents.push({ path: p, name: basename(p) });
      n += 1;
    });
    if (n) renderStyleTransferForm();
  } catch (err) {
    alert(`Picker failed: ${err.message}`);
  }
}

/** Pull paths from global video + image bars into the content list. */
function _pullFromGlobals() {
  let n = 0;
  const add = (p) => {
    if (!p) return;
    if (state.styleTransfer.contents.some((x) => x.path === p)) return;
    state.styleTransfer.contents.push({ path: p, name: basename(p) });
    n += 1;
  };
  const gi = window.globalInputs || {};
  String(gi.video || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach(add);
  String(gi.image || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach(add);
  // also first bestInput-style line
  try {
    const b = typeof bestInput === 'function' ? bestInput() : '';
    if (b) add(b.trim());
  } catch (_) { /* ignore */ }
  return n;
}

function collectStyleTransferBody() {
  var contents = (state.styleTransfer.contents || []).map((x) => x.path).filter(Boolean);
  const style_path = (document.getElementById('stStylePath')?.value || state.styleTransfer.stylePath || '').trim();

  if (!contents.length) {
    // Prefer explicit global video for single-clip video runs, then images
    const gi = window.globalInputs || {};
    const vids = String(gi.video || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const imgs = resolveGlobalImages();
    if (vids.length === 1 && !imgs.length) {
      contents = [vids[0]];
    } else if (vids.length && !imgs.length) {
      // multi video lines — take first as primary (batch video not supported in one POST)
      contents = [vids[0]];
    } else if (imgs.length) {
      contents = imgs;
    } else if (vids.length) {
      contents = [vids[0]];
    } else {
      alert('Add content (images and/or one video), or set the global Video / Image bars.');
      return null;
    }
  }

  if (!style_path) {
    alert('Pick a style image (painting / texture / etc.).');
    return null;
  }
  state.styleTransfer.stylePath = style_path;

  const videos = contents.filter(isVideoPath);
  const stills = contents.filter((p) => !isVideoPath(p));
  if (videos.length && stills.length) {
    alert('Run video and stills separately — mix is not supported in one job.\nClear the list or remove one type.');
    return null;
  }
  if (videos.length > 1) {
    alert('Style transfer video mode handles one clip at a time. Keep a single video in the content list.');
    return null;
  }

  const output = document.getElementById('stOutput')?.value?.trim() || null;
  const output_dir = document.getElementById('stOutputDir')?.value?.trim() || null;
  const singleVideo = videos.length === 1;

  const evolveOn = document.getElementById('stEvolve')?.value === '1';
  if (evolveOn && (videos.length || contents.length !== 1)) {
    alert('Evolve needs exactly one still content image (no multi, no video).');
    return null;
  }

  return withFrameRange({
    engine: document.getElementById('stEngine')?.value || state.styleTransfer.engine || 'cpu',
    content_path: singleVideo ? videos[0] : (contents.length === 1 ? contents[0] : null),
    content_paths: singleVideo ? null : contents,
    style_path,
    output_path: output || null,
    output_dir: output_dir || null,
    strength: parseFloat(document.getElementById('stStrength')?.value || '1'),
    max_side: parseInt(document.getElementById('stMaxSide')?.value || '1280', 10),
    style_size: 256,
    suffix: '_styled',
    dry_run: document.getElementById('stDryRun')?.value === '1',
    keep_model_warm: document.getElementById('stWarm')?.value === '1',
    evolve_enabled: evolveOn,
    evolve_frames: parseInt(document.getElementById('stEvolveFrames')?.value || '16', 10),
    evolve_strength_start: parseFloat(document.getElementById('stEvolveStr0')?.value || '0'),
    evolve_strength_end: parseFloat(document.getElementById('stEvolveStr1')?.value || '-1'),
    evolve_fps: parseFloat(document.getElementById('stEvolveFps')?.value || '12'),
    evolve_dedupe: false,
    ...collectEvolveRifeFields('stEvolve'),
  });
}

export { renderStyleTransferForm, collectStyleTransferBody };
