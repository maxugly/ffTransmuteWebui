import { state, bestInput, showPreview } from '/app.js';
import { basename, escapeHtml, isVideoPath } from '/js/utils.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { runOpWithCancel } from '/js/job-control.js';

// ── Stems tab (Demucs stem separation, OpenVINO Route C2 hybrid) ─────────
// Audio in (or video → track extracted) → one WAV per selected stem.
// Model selector re-renders the stem toggles: 4 for htdemucs/ft,
// 6 (+guitar/piano) for htdemucs_6s.

const DEMUCS_MODELS = {
  htdemucs: {
    label: 'htdemucs · 4 stems',
    stems: ['drums', 'bass', 'other', 'vocals'],
  },
  htdemucs_6s: {
    label: 'htdemucs_6s · 6 stems (+guitar/piano)',
    stems: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'],
  },
  htdemucs_ft: {
    label: 'htdemucs_ft · 4 stems (4-model bag)',
    stems: ['drums', 'bass', 'other', 'vocals'],
  },
};

function _dmState() {
  if (!state.demucs || typeof state.demucs !== 'object') {
    state.demucs = { model: 'htdemucs', stemSel: {}, inputPath: null };
  }
  const st = state.demucs;
  if (!st.stemSel || typeof st.stemSel !== 'object') st.stemSel = {};
  for (const [name, spec] of Object.entries(DEMUCS_MODELS)) {
    if (!Array.isArray(st.stemSel[name])) st.stemSel[name] = [...spec.stems];
  }
  if (!DEMUCS_MODELS[st.model]) st.model = 'htdemucs';
  return st;
}

function renderDemucsForm() {
  const st = _dmState();
  const model = st.model;
  const spec = DEMUCS_MODELS[model];
  const sel = st.stemSel[model];
  const stemHtml = spec.stems.map((s) => `
    <label class="dm-stem${sel.includes(s) ? ' is-on' : ''}" data-stem="${s}">
      <input type="checkbox" data-dm-stem="${s}"${sel.includes(s) ? ' checked' : ''}>
      <span>${s}</span>
    </label>`).join('');

  const html = `
    <div class="panel-title-desc dense">
      <h3>Stem separation</h3>
      <p class="dream-hint">
        Meta HTDemucs v4 on the iGPU (host STFT/ISTFT + OpenVINO neural core).
        Audio file in — or a video (track extracted) — one WAV per toggled stem out.
        Needs one-time GPU Setup below.
      </p>
    </div>
    <div class="form-row">
      <label for="dmModel">Model</label>
      <select id="dmModel" data-help-title="Model — 4 / 6 stem" data-help-text="htdemucs splits 4 stems (drums/bass/other/vocals); htdemucs_6s adds guitar and piano; htdemucs_ft is a 4-stem 4-model bag — better quality, slower.">
        ${Object.entries(DEMUCS_MODELS).map(([name, m]) =>
          `<option value="${name}"${name === model ? ' selected' : ''}>${m.label}</option>`).join('')}
      </select>
      <span class="form-row-hint" id="dmOvStatus">GPU status: checking…</span>
    </div>
    <div class="form-row">
      <label id="dmStemCount">Stems (${sel.length}/${spec.stems.length})</label>
      <div class="dm-stems" id="dmStems">${stemHtml}</div>
    </div>
    <div class="form-row">
      <label for="dmDevice">Device</label>
      <select id="dmDevice" data-help-title="Device — GPU / GPU.0 / CPU" data-help-text="GPU = strict OpenVINO on the iGPU (fails loudly, never CPU fallback); GPU.0 pins the first GPU explicitly; CPU is the explicit slower fallback.">
        <option value="GPU">GPU · strict (fails loudly, never CPU fallback)</option>
        <option value="GPU.0">GPU.0 · explicit first GPU</option>
        <option value="CPU">CPU · explicit fallback (slower)</option>
      </select>
    </div>
    <div class="form-row" id="dmGpuSetupRow">
      <button type="button" class="btn" id="btnDmOvSetup">GPU Setup</button>
      <button type="button" class="btn" id="btnDmOvRefresh">Refresh</button>
      <span class="form-row-hint">One-time IR install (6 pairs) + CPU smoke + GPU probe.</span>
    </div>

    <div class="form-row">
      <label for="dmInput">Audio</label>
      <div class="input-row">
        <input type="text" id="dmInput" placeholder="audio file (wav/mp3/flac/…) or video"
          value="${st.inputPath ? escapeHtml(st.inputPath) : ''}">
        <button type="button" class="btn" id="btnDmBrowse">Browse</button>
        <button type="button" class="btn" id="btnDmFromGlobal">Globals</button>
      </div>
    </div>
    <div class="form-row">
      <label for="dmOutDir">Out dir</label>
      <div class="input-row">
        <input type="text" id="dmOutDir" placeholder="blank = next to input">
        <button type="button" class="btn" id="btnDmOutDirBrowse">Folder</button>
      </div>
    </div>
    <div class="form-row">
      <label for="dmFormat">Format</label>
      <select id="dmFormat" data-help-title="Format — WAV float32 / PCM24" data-help-text="wav-f32 is lossless float and keeps overs/headroom; wav-pcm24 is integer and reports clips.">
        <option value="wav-f32">WAV float32 (lossless, keeps overs)</option>
        <option value="wav-pcm24">WAV PCM24 (integer, clips reported)</option>
      </select>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dmOverlap', label: 'Overlap', value: '0.25', helpTitle: 'Overlap — segment overlap [0–0.5]', helpText: 'Overlap between stagger-merged segments; 0.25 is the native Demucs reference, higher = smoother but slower. Sane: 0.1–0.4; default 0.25.' })}
        ${knobUnitHtml({ id: 'dmTransPow', label: 'Trans pw', value: '1.0', helpTitle: 'Trans pw — window transition power [0.1–4]', helpText: 'Power of the transition window between segments; 1.0 matches the Demucs window. Sane: 0.5–2; default 1.0.' })}
        ${knobUnitHtml({ id: 'dmOverwrite', label: 'Overwrite', value: '0', binary: true, leftCap: 'Keep', rightCap: 'Over', helpTitle: 'Overwrite — Keep / Over', helpText: 'Outputs land as inputname_stem_model.wav and are never overwritten while Keep; Over replaces an existing file. Default Keep.' })}
        ${knobUnitHtml({ id: 'dmNoAsync', label: 'No async', value: '0', binary: true, leftCap: 'Fast', rightCap: 'Sync', helpTitle: 'No async — Fast / Sync', helpText: 'Fast runs inference on the async path (default); Sync forces the non-async path for strictly serial execution — slower but predictably paced.' })}
        ${knobUnitHtml({ id: 'dmDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry', helpTitle: 'Dry run — Run / Dry', helpText: 'Validates params and prints the command without writing output files.' })}
      </div>
      <p class="knob-row-legend">
        <strong>Overlap</strong> 0.25 = native reference (higher = smoother, slower).
        <strong>Trans pw</strong> 1.0 = Demucs window. Outputs land as
        <code>&lt;input&gt;_&lt;stem&gt;_&lt;model&gt;.wav</code>, never overwritten unless set.
      </p>
    </div>
  `;
  document.getElementById('actionPanelForm').innerHTML = html;

  setupContinuousKnob({
    knobId: 'dmOverlapKnob', indicatorId: 'dmOverlapKnobInd', valueId: 'dmOverlapVal', hiddenId: 'dmOverlap',
    min: 0, max: 0.5, step: 0.01, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'dmTransPowKnob', indicatorId: 'dmTransPowKnobInd', valueId: 'dmTransPowVal', hiddenId: 'dmTransPow',
    min: 0.1, max: 4, step: 0.1, decimals: 1,
  });
  for (const id of ['dmOverwrite', 'dmNoAsync', 'dmDryRun']) {
    setupBinaryKnob({
      knobId: `${id}Knob`, indicatorId: `${id}KnobInd`, hiddenId: id,
      leftValue: '0', rightValue: '1', initial: '0',
    });
  }

  document.getElementById('dmModel')?.addEventListener('change', (e) => {
    _dmState().model = e.target.value;
    renderDemucsForm();
  });
  document.querySelectorAll('[data-dm-stem]').forEach((box) => {
    box.addEventListener('change', () => {
      const m = _dmState().model;
      const checked = [...document.querySelectorAll('[data-dm-stem]:checked')].map((b) => b.dataset.dmStem);
      _dmState().stemSel[m] = checked;
      document.querySelectorAll('.dm-stem').forEach((lab) => {
        lab.classList.toggle('is-on', !!lab.querySelector('input')?.checked);
      });
      const counter = document.getElementById('dmStemCount');
      if (counter) counter.textContent = `Stems (${checked.length}/${DEMUCS_MODELS[m].stems.length})`;
    });
  });
  document.getElementById('dmInput')?.addEventListener('input', (e) => {
    _dmState().inputPath = e.target.value.trim() || null;
  });
  document.getElementById('dmInput')?.addEventListener('change', (e) => {
    _dmState().inputPath = e.target.value.trim() || null;
  });
  document.getElementById('btnDmBrowse')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/picker?mode=files&filter=all&start_path=');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const p = (data.paths && data.paths[0]) || data.path;
      if (p) {
        _dmState().inputPath = p;
        const el = document.getElementById('dmInput');
        if (el) el.value = p;
        if (!isVideoPath(p)) showPreview(p);
      }
    } catch (err) {
      alert(`Picker failed: ${err.message}`);
    }
  });
  document.getElementById('btnDmFromGlobal')?.addEventListener('click', () => {
    let got = '';
    try { got = (bestInput() || '').trim(); } catch (_) { got = ''; }
    if (!got) {
      const gi = window.globalInputs || {};
      got = String(gi.video || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    }
    if (!got) {
      alert('Global Video bar is empty — paste a path or Browse above.');
      return;
    }
    _dmState().inputPath = got;
    const el = document.getElementById('dmInput');
    if (el) el.value = got;
  });
  document.getElementById('btnDmOutDirBrowse')?.addEventListener('click', () => {
    try { openFileBrowser('dmOutDir', true, 'dir', 'all'); }
    catch (_) { /* file browser unavailable */ }
  });
  document.getElementById('btnDmOvSetup')?.addEventListener('click', async () => {
    try {
      await runOpWithCancel('demucs_ov_setup', { action: 'install', dry_run: false },
        { label: 'Demucs GPU setup (IR install + smoke)…' });
    } catch (_) { /* logged */ }
    _refreshDmOvStatus();
  });
  document.getElementById('btnDmOvRefresh')?.addEventListener('click', _refreshDmOvStatus);
  _refreshDmOvStatus();
}

async function _refreshDmOvStatus() {
  const box = document.getElementById('dmOvStatus');
  if (!box) return;
  box.textContent = 'GPU status: checking…';
  try {
    const res = await fetch('/api/demucs_ov/status');
    const data = await res.json();
    const models = data.models || {};
    const ready = Object.entries(models).filter(([, m]) => m.ir_present).map(([k]) => k);
    box.textContent = 'GPU status: '
      + (ready.length === 3 ? 'all 3 models ok'
        : ready.length ? `${ready.join(', ')} ok — ${3 - ready.length} MISSING, run GPU Setup`
        : 'IRs MISSING — run GPU Setup')
      + ' · devices ' + ((data.devices || []).join('/') || '?');
  } catch (err) {
    box.textContent = 'GPU status check failed — ' + err.message;
  }
}

function collectDemucsBody() {
  const st = _dmState();
  const model = document.getElementById('dmModel')?.value || st.model || 'htdemucs';
  const spec = DEMUCS_MODELS[model];
  if (!spec) {
    alert('Unknown Demucs model.');
    return null;
  }
  const checked = [...document.querySelectorAll('[data-dm-stem]:checked')].map((b) => b.dataset.dmStem);
  const stems = checked.length ? checked : null;
  if (!checked.length) {
    alert('Toggle at least one stem.');
    return null;
  }
  st.model = model;
  st.stemSel[model] = checked;

  let input = (document.getElementById('dmInput')?.value || st.inputPath || '').trim();
  if (!input) {
    try { input = (bestInput() || '').trim(); } catch (_) { input = ''; }
  }
  if (!input) {
    alert('Pick an audio file (or video) — Browse above or set the global Video bar.');
    return null;
  }
  st.inputPath = input;

  return {
    input_path: input,
    output_dir: document.getElementById('dmOutDir')?.value?.trim() || null,
    model,
    stems,
    device: document.getElementById('dmDevice')?.value || 'GPU',
    overlap: parseFloat(document.getElementById('dmOverlap')?.value || '0.25'),
    transition_power: parseFloat(document.getElementById('dmTransPow')?.value || '1.0'),
    output_format: document.getElementById('dmFormat')?.value || 'wav-f32',
    overwrite: document.getElementById('dmOverwrite')?.value === '1',
    no_async: document.getElementById('dmNoAsync')?.value === '1',
    dry_run: document.getElementById('dmDryRun')?.value === '1',
  };
}

export { renderDemucsForm, collectDemucsBody, DEMUCS_MODELS };
