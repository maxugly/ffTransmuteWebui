import { state } from '/app.js';
import { knobUnitHtml } from '/js/ui/knobs.js';
import { setupContinuousKnob, setupBinaryKnob } from '/js/ui/knobs.js';
import { runOpWithCancel } from '/js/job-control.js';

// ── Music tab (ACE-Step text-to-music, OpenVINO HETERO) ────────────────────
// Model dropdown is the single source of knob visibility: the status payload
// carries each model's `knobs[]`, and only those render. Turbo exposes exactly
// prompt/lyrics/seed/duration/device/outdir/format/overwrite/dryrun —
// guidance/negative/steps/shift do not exist for it (baked out by distillation).

let MUSIC_CATALOG = null;
let MUSIC_LORAS = [];

function loraHtml(model) {
  const pairs = MUSIC_LORAS.filter((p) => p.model === model);
  const sel = (_muState().lora) || '';
  const badge = { GOOD: '✅', untested: '🆕', BAD: '❌' };
  let html = `<option value="">none</option>`;
  for (const p of pairs) {
    const missing = p.ir_present === false ? ' (IR missing)' : '';
    const s = p.id === sel ? ' selected' : '';
    html += `<option value="${p.id}"${s}>${badge[p.verdict] || '?'} ${p.label}${missing}</option>`;
  }
  if (!pairs.length) {
    html += `<option value="" disabled>no pairs for this model yet</option>`;
  }
  return html;
}

function _muState() {
  if (!state.music || typeof state.music !== 'object') {
    state.music = {
      model: 'acestep-v15-turbo',
      prompt: 'wu-tang, hip hop, boom bap, gritty instrumental, 95bpm, sampled guitar riff, sampled woodwinds, tight snare, dirty kick',
      lyrics: '[Instrumental]',
      seed: 42,
      duration: 12,
      device: 'HETERO',
      outDir: '',
      format: 'wav-f32',
      lora: '',
      bpm: '',
      key: '',
      timesig: '',
      negative: '',
      steps: 50,
      guidance: 7.0,
    };
  }
  return state.music;
}

async function _muCatalog() {
  if (MUSIC_CATALOG) return MUSIC_CATALOG;
  const res = await fetch('/api/music_ov/status');
  const data = await res.json();
  MUSIC_CATALOG = data.models || {};
  MUSIC_CATALOG.__devices = data.devices || [];
  MUSIC_LORAS = data.loras || [];
  return MUSIC_CATALOG;
}

const KNOB_RENDER = {
  prompt: (st) => `
    <div class="form-row">
      <label for="muPrompt">Prompt</label>
      <textarea id="muPrompt" rows="2">${(st.prompt || '').replace(/</g, '&lt;')}</textarea>
    </div>`,
  lyrics: (st) => `
    <div class="form-row">
      <label for="muLyrics">Lyrics</label>
      <input type="text" id="muLyrics" placeholder="[Instrumental] or lyric block"
        value="${(st.lyrics || '').replace(/"/g, '&quot;')}">
    </div>`,
  seed: (st) => `
    <div class="form-row">
      <label for="muSeed">Seed</label>
      <div class="input-row">
        ${knobUnitHtml({ id: 'muSeed', label: 'Seed', value: String(st.seed ?? 42) })}
        <button type="button" class="btn" id="btnMuDice" title="Random seed">🎲</button>
      </div>
      <span class="form-row-hint">Same prompt + seed = bit-identical clip.</span>
    </div>`,
  duration: (st) => `
    <div class="form-row">
      <label for="muDuration">Duration</label>
      ${knobUnitHtml({ id: 'muDuration', label: 'Seconds', value: String(st.duration ?? 12) })}
      <span class="form-row-hint">10–60 s (below 10 is under the model floor).</span>
    </div>`,
  bpm: (st) => `
    <div class="form-row">
      <label for="muBpm">BPM</label>
      <input type="text" id="muBpm" inputmode="numeric" placeholder="95 (blank = N/A)"
        value="${(st.bpm || '').replace(/"/g, '&quot;')}">
    </div>`,
  key: (st) => `
    <div class="form-row">
      <label for="muKey">Key</label>
      <input type="text" id="muKey" placeholder="E minor (blank = N/A)"
        value="${(st.key || '').replace(/"/g, '&quot;')}">
    </div>`,
  timesig: (st) => `
    <div class="form-row">
      <label for="muTimesig">Timesig</label>
      <input type="text" id="muTimesig" placeholder="4/4 (blank = N/A)"
        value="${(st.timesig || '').replace(/"/g, '&quot;')}">
    </div>`,
  device: (st) => `
    <div class="form-row">
      <label for="muDevice">Device</label>
      <select id="muDevice">
        <option value="HETERO"${st.device !== 'CPU' ? ' selected' : ''}>HETERO · iGPU + proj_out CPU pin (proven)</option>
        <option value="CPU"${st.device === 'CPU' ? ' selected' : ''}>CPU · explicit fallback (slower)</option>
      </select>
      <span class="form-row-hint">GPU-only is not offered — measured broken on this model.</span>
    </div>`,
  outdir: (st) => `
    <div class="form-row">
      <label for="muOutDir">Out dir</label>
      <div class="input-row">
        <input type="text" id="muOutDir" placeholder="blank = music outbox" value="${(st.outDir || '').replace(/"/g, '&quot;')}">
        <button type="button" class="btn" id="btnMuOutDirBrowse">Folder</button>
      </div>
    </div>`,
  format: (st) => `
    <div class="form-row">
      <label for="muFormat">Format</label>
      <select id="muFormat">
        <option value="wav-f32"${st.format !== 'wav-pcm24' ? ' selected' : ''}>WAV float32 (lossless, keeps overs)</option>
        <option value="wav-pcm24"${st.format === 'wav-pcm24' ? ' selected' : ''}>WAV PCM24 (integer, clips reported)</option>
      </select>
    </div>`,
  overwrite: () => `
    <div class="form-row">
      <label>Overwrite</label>
      ${knobUnitHtml({ id: 'muOverwrite', label: 'Overwrite', value: '0', binary: true, leftCap: 'Keep', rightCap: 'Over' })}
    </div>`,
  dryrun: () => `
    <div class="form-row">
      <label>Dry run</label>
      ${knobUnitHtml({ id: 'muDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>`,
  // Future entries only (sft/base): rendered iff the model's knobs[] lists them.
  negative: () => `
    <div class="form-row">
      <label for="muNegative">Negative</label>
      <textarea id="muNegative" rows="2" placeholder="what to avoid (CFG models only)"></textarea>
    </div>`,
  steps: () => `
    <div class="form-row">
      <label for="muSteps">Steps</label>
      ${knobUnitHtml({ id: 'muSteps', label: 'Steps', value: '50' })}
    </div>`,
  guidance: () => `
    <div class="form-row">
      <label for="muGuidance">Guidance</label>
      ${knobUnitHtml({ id: 'muGuidance', label: 'Scale', value: '7.0' })}
    </div>`,
};

async function renderMusicForm() {
  const st = _muState();
  let catalog = {};
  try {
    catalog = await _muCatalog();
  } catch (_) {
    catalog = {};
  }
  const names = Object.keys(catalog).filter((k) => !k.startsWith('__'));
  if (!names.length) {
    document.getElementById('actionPanelForm').innerHTML = `
      <div class="panel-title-desc dense"><h3>Music · text-to-music</h3>
      <p class="dream-hint">Music backend unreachable — is the server up with music_ops registered?</p></div>`;
    return;
  }
  if (!catalog[st.model]) st.model = 'acestep-v15-turbo';
  const spec = catalog[st.model] || {};
  const knobs = Array.isArray(spec.knobs) ? spec.knobs : [];

  const modelHtml = names.map((name) => {
    const m = catalog[name] || {};
    const dis = m.enabled === false ? ` disabled title="${(m.disabled_reason || 'unavailable').replace(/"/g, '&quot;')}"` : '';
    const suffix = m.enabled === false ? ` (needs: ${m.disabled_reason || 'export'})` : '';
    return `<option value="${name}"${name === st.model ? ' selected' : ''}${dis}>${m.label || name}${suffix}</option>`;
  }).join('');

  const html = `
    <div class="panel-title-desc dense">
      <h3>Music · text-to-music</h3>
      <p class="dream-hint">
        ACE-Step on the iGPU (HETERO: 24 DiT blocks GPU, proj_out CPU pin).
        Prompt + seed in, WAV out. Needs one-time GPU Setup below.
      </p>
    </div>
    <div class="form-row">
      <label for="muModel">Model</label>
      <select id="muModel">${modelHtml}</select>
      <span class="form-row-hint" id="muOvStatus">GPU status: checking…</span>
    </div>
    <div class="form-row-hint" id="muModelNote" style="margin:-4px 0 8px 0">${spec.notes || ''}</div>
    <div class="form-row" id="muLoraRow">
      <label for="muLora">LoRA</label>
      <select id="muLora">${loraHtml(st.model)}</select>
      <span class="form-row-hint">Baked checkpoint+adapter pairs. Strength is merge-time.</span>
    </div>
    ${knobs.map((k) => (KNOB_RENDER[k] ? KNOB_RENDER[k](st) : '')).join('')}
    <div class="form-row" id="muGpuSetupRow">
      <button type="button" class="btn" id="btnMuOvSetup">GPU Setup</button>
      <button type="button" class="btn" id="btnMuOvRefresh">Refresh</button>
      <span class="form-row-hint">One-time manifest verify + CPU smoke + GPU probe.</span>
    </div>
  `;
  document.getElementById('actionPanelForm').innerHTML = html;

  if (knobs.includes('seed')) {
    setupContinuousKnob({
      knobId: 'muSeedKnob', indicatorId: 'muSeedKnobInd', valueId: 'muSeedVal', hiddenId: 'muSeed',
      min: 0, max: 9999, step: 1, decimals: 0,
    });
    document.getElementById('btnMuDice')?.addEventListener('click', () => {
      const v = String(Math.floor(Math.random() * 10000));
      const hid = document.getElementById('muSeed');
      if (hid) { hid.value = v; hid.dispatchEvent(new Event('change', { bubbles: true })); }
      const val = document.getElementById('muSeedVal');
      if (val) val.textContent = v;
      _muState().seed = parseInt(v, 10);
    });
  }
  if (knobs.includes('duration')) {
    setupContinuousKnob({
      knobId: 'muDurationKnob', indicatorId: 'muDurationKnobInd', valueId: 'muDurationVal', hiddenId: 'muDuration',
      min: 10, max: 60, step: 1, decimals: 0,
    });
  }
  if (knobs.includes('steps')) {
    setupContinuousKnob({
      knobId: 'muStepsKnob', indicatorId: 'muStepsKnobInd', valueId: 'muStepsVal', hiddenId: 'muSteps',
      min: 8, max: 60, step: 1, decimals: 0,
    });
  }
  if (knobs.includes('guidance')) {
    setupContinuousKnob({
      knobId: 'muGuidanceKnob', indicatorId: 'muGuidanceKnobInd', valueId: 'muGuidanceVal', hiddenId: 'muGuidance',
      min: 1.0, max: 15.0, step: 0.5, decimals: 1,
    });
  }
  if (knobs.includes('overwrite')) {
    setupBinaryKnob({
      knobId: 'muOverwriteKnob', indicatorId: 'muOverwriteKnobInd', hiddenId: 'muOverwrite',
      leftValue: '0', rightValue: '1', initial: '0',
    });
  }
  if (knobs.includes('dryrun')) {
    setupBinaryKnob({
      knobId: 'muDryRunKnob', indicatorId: 'muDryRunKnobInd', hiddenId: 'muDryRun',
      leftValue: '0', rightValue: '1', initial: '0',
    });
  }

  document.getElementById('muModel')?.addEventListener('change', (e) => {
    _muState().model = e.target.value;
    _muState().lora = '';
    renderMusicForm();
  });
  document.getElementById('muLora')?.addEventListener('change', (e) => {
    const id = e.target.value || '';
    _muState().lora = id;
    const pair = MUSIC_LORAS.find((p) => p.id === id);
    if (pair && pair.trigger) {
      const cur = document.getElementById('muPrompt')?.value || _muState().prompt || '';
      if (!cur.trimStart().startsWith(pair.trigger)) {
        const next = `${pair.trigger}, ${cur}`.trim();
        _muState().prompt = next;
        const el = document.getElementById('muPrompt');
        if (el) el.value = next;
      }
    }
  });
  for (const [id, key, parse] of [
    ['muPrompt', 'prompt', (v) => v],
    ['muLyrics', 'lyrics', (v) => v],
    ['muNegative', 'negative', (v) => v],
    ['muBpm', 'bpm', (v) => v.trim()],
    ['muKey', 'key', (v) => v.trim()],
    ['muTimesig', 'timesig', (v) => v.trim()],
    ['muOutDir', 'outDir', (v) => v],
    ['muDevice', 'device', (v) => v],
    ['muFormat', 'format', (v) => v],
  ]) {
    document.getElementById(id)?.addEventListener('input', (e) => {
      _muState()[key] = parse(e.target.value);
    });
    document.getElementById(id)?.addEventListener('change', (e) => {
      _muState()[key] = parse(e.target.value);
    });
  }
  document.getElementById('muSeed')?.addEventListener('change', (e) => {
    _muState().seed = parseInt(e.target.value || '42', 10);
  });
  document.getElementById('muDuration')?.addEventListener('change', (e) => {
    _muState().duration = Math.min(60, Math.max(10, parseFloat(e.target.value || '12')));
  });
  document.getElementById('muSteps')?.addEventListener('change', (e) => {
    _muState().steps = Math.min(60, Math.max(8, parseInt(e.target.value || '50', 10)));
  });
  document.getElementById('muGuidance')?.addEventListener('change', (e) => {
    _muState().guidance = Math.min(15, Math.max(1, parseFloat(e.target.value || '7.0')));
  });
  document.getElementById('btnMuOutDirBrowse')?.addEventListener('click', () => {
    try { openFileBrowser('muOutDir', true, 'dir', 'all'); }
    catch (_) { /* file browser unavailable */ }
  });
  document.getElementById('btnMuOvSetup')?.addEventListener('click', async () => {
    try {
      await runOpWithCancel('music_ov_setup', { action: 'install', dry_run: false, deep: true },
        { label: 'Music GPU setup (verify + smoke + probe)…' });
    } catch (_) { /* logged */ }
    MUSIC_CATALOG = null;
    renderMusicForm();
  });
  document.getElementById('btnMuOvRefresh')?.addEventListener('click', () => {
    MUSIC_CATALOG = null;
    renderMusicForm();
  });
  _refreshMuOvStatus();
}

async function _refreshMuOvStatus() {
  const box = document.getElementById('muOvStatus');
  if (!box) return;
  box.textContent = 'GPU status: checking…';
  try {
    const res = await fetch('/api/music_ov/status');
    const data = await res.json();
    const models = data.models || {};
    const ready = Object.entries(models).filter(([, m]) => m.enabled && m.ir_present).map(([k]) => k);
    box.textContent = 'GPU status: '
      + (ready.length ? `${ready.join(', ')} ok` : 'IRs MISSING — run GPU Setup')
      + ' · devices ' + ((data.devices || []).join('/') || '?');
  } catch (err) {
    box.textContent = 'GPU status check failed — ' + err.message;
  }
}

function collectMusicBody() {
  const st = _muState();
  const model = document.getElementById('muModel')?.value || st.model || 'acestep-v15-turbo';
  st.model = model;
  const lora = document.getElementById('muLora')?.value || '';
  st.lora = lora;
  const prompt = (document.getElementById('muPrompt')?.value || st.prompt || '').trim();
  if (!prompt) {
    alert('Type a prompt first.');
    return null;
  }
  st.prompt = prompt;
  const lyrics = (document.getElementById('muLyrics')?.value ?? st.lyrics ?? '[Instrumental]').trim() || '[Instrumental]';
  st.lyrics = lyrics;
  const seed = parseInt(document.getElementById('muSeed')?.value ?? String(st.seed ?? 42), 10);
  st.seed = Number.isFinite(seed) ? seed : 42;
  const duration = Math.min(60, Math.max(10,
    parseFloat(document.getElementById('muDuration')?.value ?? String(st.duration ?? 12))));
  st.duration = duration;
  const bpm = (document.getElementById('muBpm')?.value ?? st.bpm ?? '').trim();
  const key = (document.getElementById('muKey')?.value ?? st.key ?? '').trim();
  const timesig = (document.getElementById('muTimesig')?.value ?? st.timesig ?? '').trim();
  st.bpm = bpm; st.key = key; st.timesig = timesig;
  const negative = (document.getElementById('muNegative')?.value ?? st.negative ?? '').trim();
  st.negative = negative;
  const steps = Math.min(60, Math.max(8,
    parseInt(document.getElementById('muSteps')?.value ?? String(st.steps ?? 50), 10)));
  st.steps = Number.isFinite(steps) ? steps : 50;
  const guidance = Math.min(15, Math.max(1,
    parseFloat(document.getElementById('muGuidance')?.value ?? String(st.guidance ?? 7.0))));
  st.guidance = Number.isFinite(guidance) ? guidance : 7.0;
  return {
    prompt,
    lyrics,
    negative,
    steps: st.steps,
    guidance: st.guidance,
    seed: st.seed,
    duration_sec: duration,
    model,
    device: document.getElementById('muDevice')?.value || st.device || 'HETERO',
    lora,
    bpm, key, timesig,
    output_dir: document.getElementById('muOutDir')?.value?.trim() || null,
    output_format: document.getElementById('muFormat')?.value || 'wav-f32',
    overwrite: document.getElementById('muOverwrite')?.value === '1',
    dry_run: document.getElementById('muDryRun')?.value === '1',
  };
}

export { renderMusicForm, collectMusicBody };
