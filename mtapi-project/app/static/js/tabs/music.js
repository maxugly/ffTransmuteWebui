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

const MU_MODEL_KEY = 'mtapi.music.model';
const MU_KNOWN_MODELS = ['acestep-v15-turbo', 'acestep-v15-base', 'acestep-v15-sft'];

function _muStoredModel() {
  try {
    const m = localStorage.getItem(MU_MODEL_KEY);
    return MU_KNOWN_MODELS.includes(m) ? m : null;
  } catch (_) {
    return null;
  }
}

const MU_SCALES = [
  { group: 'Major / minor', items: ['C major', 'G major', 'D major', 'A major', 'E major',
    'B major', 'F# major', 'Db major', 'Ab major', 'Eb major', 'Bb major',
    'F major', 'A minor', 'E minor', 'B minor', 'F# minor', 'C# minor',
    'G# minor', 'Eb minor', 'Bb minor', 'F minor', 'C minor', 'G minor', 'D minor'] },
  { group: 'Church modes', items: ['Ionian', 'Dorian', 'Phrygian', 'Lydian',
    'Mixolydian', 'Aeolian', 'Locrian'] },
  { group: 'Blues / jazz', items: ['Major Blues', 'Minor Blues (hexatonic)',
    'Harmonic Minor', 'Melodic Minor (jazz minor)', 'Bebop Dominant'] },
  { group: 'Synthetic', items: ['Whole Tone', 'Diminished (whole-half)',
    'Diminished (half-whole)', 'Augmented'] },
  { group: 'Maqam (Middle East)', items: ['Bayati', 'Hijaz', 'Rast', 'Saba', 'Nahawand'] },
  { group: 'East Asian pentatonics', items: ['Yo', 'Insen', 'Hirajoshi', 'Iwato',
    'Gong', 'Shang', 'Jiao', 'Zhi', 'Yu'] },
  { group: 'Raga frameworks', items: ['Bhairav', 'Todi', 'Yaman', 'Kafi', 'Bilawal'] },
];

const MU_TIMESIGS = ['', '4/4', '2/2', '3/4', '2/4', '6/8', '5/4', '7/4', '7/8',
  '5/8', '9/8', '11/8', '12/8', '13/8'];

function _muState() {
  if (!state.music || typeof state.music !== 'object') {
    state.music = {
      model: _muStoredModel() || 'acestep-v15-base',
      prompt: 'wu-tang, hip hop, boom bap, gritty instrumental, 95bpm, sampled guitar riff, sampled woodwinds, tight snare, dirty kick',
      lyrics: '[Instrumental]',
      seed: 42,
      duration: 12,
      device: 'HETERO',
      outDir: '',
      format: 'wav-f32',
      lora: '',
      task: 'text2music',
      srcAudio: '',
      bpm: '',
      key: '',
      timesig: '',
      negative: '',
      steps: 20,
      guidance: 7.0,
      shift: 3.0,
      apg: '1',
      seedRand: '1',
    };
  }
  if (!MU_KNOWN_MODELS.includes(state.music.model)) {
    state.music.model = _muStoredModel() || 'acestep-v15-base';
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
${knobUnitHtml({ id: 'muSeed', label: 'Seed', value: String(st.seed ?? 42), helpTitle: 'Seed — fixed RNG seed [0–4294967295]', helpText: 'Fixed seeds replay bit-identical; Rand mode or the dice draws a new seed per run. Sane: any 0–4294967295; default 42.' })}
        <button type="button" class="btn" id="btnMuDice" data-help-title="Random seed">🎲</button>
      </div>
      <span class="form-row-hint">Same prompt + seed = bit-identical clip.</span>
    </div>`,
  duration: (st) => `
    <div class="form-row">
      <label for="muDuration">Duration</label>
      ${knobUnitHtml({ id: 'muDuration', label: 'Seconds', value: String(st.duration ?? 12), helpTitle: 'Seconds — clip length in seconds [10–60]', helpText: 'Length of the generated clip. Below 10 is under the model floor. Sane: 10–60; default 12.' })}
      <span class="form-row-hint">10–60 s (below 10 is under the model floor).</span>
    </div>`,
  bpm: (st) => `
    <div class="form-row">
      <label for="muBpm">BPM</label>
      ${knobUnitHtml({ id: 'muBpm', label: 'BPM', value: String(st.bpm ?? '0'), helpTitle: 'BPM — Beats Per Minute [0-300, 0=auto]', helpText: 'Sets tempo for the SFT template. 0 lets the model estimate the tempo. Sane: 60–180; default 0 (auto).' })}
      <span class="form-row-hint">20.000–300.000, 3 decimals for stem sync (0 or blank = model estimates).</span>
    </div>`,
  key: (st) => {
    const opts = `<option value=""${(st.key || '') === '' ? ' selected' : ''}>N/A (model estimates)</option>`
      + MU_SCALES.map((g) =>
        `<optgroup label="${g.group}">` + g.items.map((s) =>
          `<option value="${s}"${(st.key || '') === s ? ' selected' : ''}>${s}</option>`).join('') + `</optgroup>`).join('');
    return `
    <div class="form-row">
      <label for="muKey">Scale</label>
      <select id="muKey">${opts}</select>
      <span class="form-row-hint">Hint text for the SFT template — any entry is accepted verbatim.</span>
    </div>`;
  },
  timesig: (st) => {
    const opts = MU_TIMESIGS.map((s) =>
      `<option value="${s}"${(st.timesig || '') === s ? ' selected' : ''}>${s || 'N/A (model estimates)'}</option>`).join('');
    return `
    <div class="form-row">
      <label for="muTimesig">Timing</label>
      <select id="muTimesig">${opts}</select>
    </div>`;
  },
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
      ${knobUnitHtml({ id: 'muOverwrite', label: 'Overwrite', value: '0', binary: true, leftCap: 'Keep', rightCap: 'Over', helpTitle: 'Overwrite — Keep / Over', helpText: 'Over writes over an existing output file; Keep leaves existing files in place. Left = Keep, right = Over; default Keep.' })}
    </div>`,
  dryrun: () => `
    <div class="form-row">
      <label>Dry run</label>
      ${knobUnitHtml({ id: 'muDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry', helpTitle: 'Dry run — Run / Dry', helpText: 'Validates params and prints the command without writing output files.' })}
    </div>`,
  // CFG entries (base/sft): rendered iff the model's knobs[] lists them.
  negative: (st) => `
    <div class="form-row">
      <label for="muNegative">Negative</label>
      <textarea id="muNegative" rows="2" placeholder="what to avoid (CFG models only)">${(st.negative || '').replace(/</g, '&lt;')}</textarea>
    </div>`,
  steps: (st) => `
    <div class="form-row">
      <label for="muSteps">Steps</label>
      ${knobUnitHtml({ id: 'muSteps', label: 'Steps', value: String(st.steps ?? 50), helpTitle: 'Steps — diffusion denoise steps [8–60]', helpText: 'Diffusion denoise steps. More = higher quality, slower. Sane: 20–50; default 50.' })}
    </div>`,
  guidance: (st) => `
    <div class="form-row">
      <label for="muGuidance">Guidance</label>
      ${knobUnitHtml({ id: 'muGuidance', label: 'Scale', value: String(st.guidance ?? 7.0), helpTitle: 'Scale — guidance [1–15]', helpText: 'How strongly the prompt is followed (CFG base/sft only). Sane: 1–12 (turbo bakes it out); default 7.0.' })}
    </div>`,
  shift: (st) => `
    <div class="form-row">
      <label for="muShift">Shift</label>
      ${knobUnitHtml({ id: 'muShift', label: 'Shift', value: String(st.shift ?? 3.0), helpTitle: 'Shift — CFG shift [0.5–8]', helpText: 'Shifts the prompt conditioning offset on the schedule; classic 3.0, 1.0 = turbo-shift1 recipe. Tune ~1–8. Sane: 1–8; default 3.0.' })}
      <span class="form-row-hint">Schedule shift: 3.0 default, 1.0 = turbo-shift1 recipe.</span>
    </div>`,
  apg: (st) => `
    <div class="form-row">
      <label>APG</label>
      ${knobUnitHtml({ id: 'muApg', label: 'APG', value: (st.apg ?? '1'), binary: true, leftCap: 'CFG', rightCap: 'APG', helpTitle: 'APG — CFG / APG', helpText: 'APG adaptive guidance vs plain CFG (base/sft only). Left = plain CFG, right = APG; default APG.' })}
      <span class="form-row-hint">APG adaptive guidance vs plain CFG (base/sft only).</span>
    </div>`,
};

// ── Layout partitions (same knobs, DeepDream-style density) ───────────────
// Full-width rows: text areas and file rows. Everything else collapses into
// one knob bank (continuous/binary knobs) and one selects grid (short dropdowns).
const MU_BANK_KNOBS = ['seed', 'duration', 'bpm', 'steps', 'guidance', 'shift',
  'apg', 'overwrite', 'dryrun'];
const MU_GRID_KNOBS = ['device', 'format', 'key', 'timesig'];

function muBankHtml(st, knobs) {
  let bank = knobs.filter((k) => MU_BANK_KNOBS.includes(k));
  // Random-seed toggle rides with the seed knob on CFG models (base/sft).
  if (bank.includes('seed') && knobs.includes('steps') && !bank.includes('seedrand')) {
    bank = bank.flatMap((k) => (k === 'seed' ? [k, 'seedrand'] : [k]));
  }
  if (!bank.length) return '';
  const units = {
    seed: `<span class="mu-seed-wrap">${knobUnitHtml({ id: 'muSeed', label: 'Seed', value: String(st.seed ?? 42), helpTitle: 'Seed — fixed RNG seed [0–4294967295]', helpText: 'Fixed seeds replay bit-identical; Rand mode or the dice draws a new seed per run. Sane: any 0–4294967295; default 42.' })}
      <button type="button" class="btn mu-dice" id="btnMuDice" data-help-title="Random seed">🎲</button></span>`,
    seedrand: knobUnitHtml({ id: 'muSeedRand', label: 'Seed?', value: (st.seedRand ?? '1'), binary: true, leftCap: 'Fixed', rightCap: 'Rand', helpTitle: 'Seed Mode — Fixed / Rand', helpText: 'Fixed (left) uses the fixed seed for repeatable output · Random (right) rolls a new seed per Run.' }),
    duration: knobUnitHtml({ id: 'muDuration', label: 'Seconds', value: String(st.duration ?? 12), helpTitle: 'Seconds — clip length in seconds [10–60]', helpText: 'Length of the generated clip. Below 10 is under the model floor. Sane: 10–60; default 12.' }),
    bpm: knobUnitHtml({ id: 'muBpm', label: 'BPM', value: String(st.bpm ?? '0'), helpTitle: 'BPM — Beats Per Minute [0-300, 0=auto]', helpText: 'Sets tempo for the SFT template. 0 lets the model estimate the tempo. Sane: 60–180; default 0 (auto).' }),
    steps: knobUnitHtml({ id: 'muSteps', label: 'Steps', value: String(st.steps ?? 50), helpTitle: 'Steps — diffusion denoise steps [8–60]', helpText: 'Diffusion denoise steps. More = higher quality, slower. Sane: 20–50; default 50.' }),
    guidance: knobUnitHtml({ id: 'muGuidance', label: 'Scale', value: String(st.guidance ?? 7.0), helpTitle: 'Scale — guidance [1–15]', helpText: 'How strongly the prompt is followed (CFG base/sft only). Sane: 1–12 (turbo bakes it out); default 7.0.' }),
    shift: knobUnitHtml({ id: 'muShift', label: 'Shift', value: String(st.shift ?? 3.0), helpTitle: 'Shift — CFG shift [0.5–8]', helpText: 'Shifts the prompt conditioning offset on the schedule; classic 3.0, 1.0 = turbo-shift1 recipe. Tune ~1–8. Sane: 1–8; default 3.0.' }),
    apg: knobUnitHtml({ id: 'muApg', label: 'APG', value: (st.apg ?? '1'), binary: true, leftCap: 'CFG', rightCap: 'APG', helpTitle: 'APG — CFG / APG', helpText: 'APG adaptive guidance vs plain CFG (base/sft only). Left = plain CFG, right = APG; default APG.' }),
    overwrite: knobUnitHtml({ id: 'muOverwrite', label: 'Overwrite', value: '0', binary: true, leftCap: 'Keep', rightCap: 'Over', helpTitle: 'Overwrite — Keep / Over', helpText: 'Over writes over an existing output file; Keep leaves existing files in place. Left = Keep, right = Over; default Keep.' }),
    dryrun: knobUnitHtml({ id: 'muDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry', helpTitle: 'Dry run — Run / Dry', helpText: 'Validates params and prints the command without writing output files.' }),
  };
  return `
    <div class="knob-row">
      <div class="knob-bank">${bank.map((k) => units[k] || '').join('')}</div>
      <p class="knob-row-legend">
        <strong>Seed</strong> 🎲 = dice (bit-identical). <strong>Seconds</strong> 10–60.
        <strong>BPM</strong> 0 = model estimates. <strong>Steps</strong> 8–60.
        <strong>Scale</strong> guidance (CFG base/sft). <strong>Shift</strong> 3.0 default.
      </p>
    </div>`;
}

function muGridHtml(st, knobs) {
  const grid = knobs.filter((k) => MU_GRID_KNOBS.includes(k));
  if (!grid.length) return '';
  const cells = {
    device: `
      <div class="mu-cell"><label for="muDevice">Device</label>
      <select id="muDevice">
        <option value="HETERO"${st.device !== 'CPU' ? ' selected' : ''}>HETERO · proven</option>
        <option value="CPU"${st.device === 'CPU' ? ' selected' : ''}>CPU · fallback</option>
      </select></div>`,
    format: `
      <div class="mu-cell"><label for="muFormat">Format</label>
      <select id="muFormat">
        <option value="wav-f32"${st.format !== 'wav-pcm24' ? ' selected' : ''}>WAV float32</option>
        <option value="wav-pcm24"${st.format === 'wav-pcm24' ? ' selected' : ''}>WAV PCM24</option>
      </select></div>`,
    key: `
      <div class="mu-cell"><label for="muKey">Scale</label>
      <select id="muKey"><option value="">N/A (model estimates)</option>${MU_SCALES.map((g) =>
        `<optgroup label="${g.group}">` + g.items.map((s) =>
          `<option value="${s}"${(st.key || '') === s ? ' selected' : ''}>${s}</option>`).join('') +
        `</optgroup>`).join('')}</select></div>`,
    timesig: `
      <div class="mu-cell"><label for="muTimesig">Timing</label>
      <select id="muTimesig">${MU_TIMESIGS.map((s) =>
        `<option value="${s}"${(st.timesig || '') === s ? ' selected' : ''}>${s || 'N/A'}</option>`).join('')}</select></div>`,
  };
  return `<div class="mu-grid">${grid.map((k) => cells[k] || '').join('')}</div>`;
}

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
  if (!catalog[st.model]) st.model = _muStoredModel() || 'acestep-v15-base';
  const spec = catalog[st.model] || {};
  const knobs = Array.isArray(spec.knobs) ? spec.knobs : [];
  const isCfgModel = knobs.includes('steps');
  // Base/sft defaults (turbo keeps 0=N/A): BPM 95, seed random on.
  if (isCfgModel && !st.bpm) st.bpm = '95';
  if (st.seedRand !== '0' && st.seedRand !== '1') st.seedRand = isCfgModel ? '1' : '0';

  const modelHtml = names.map((name) => {
    const m = catalog[name] || {};
    const dis = m.enabled === false ? ` disabled data-help-title="${(m.disabled_reason || 'unavailable').replace(/"/g, '&quot;')}"` : '';
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
    ${spec.cover ? `
    <div class="form-row">
      <label for="muTask">Task</label>
      <select id="muTask">
        <option value="text2music">text2music</option>
        <option value="cover"${st.task === 'cover' ? ' selected' : ''}>cover · restyle audio</option>
      </select>
    </div>
    <div class="form-row" id="muSrcRow" style="${st.task === 'cover' ? '' : 'display:none'}">
      <label for="muSrc">Source</label>
      <div class="input-row">
        <input type="text" id="muSrc" placeholder="audio file to restyle (48 kHz stereo ideal)"
          value="${(st.srcAudio || '').replace(/"/g, '&quot;')}">
        <button type="button" class="btn" id="btnMuSrcBrowse">Browse</button>
      </div>
      <span class="form-row-hint">Looped ×2 for a ~38 s output. Turbo can't do this (base/sft only).</span>
    </div>` : ''}
    <div class="form-row" id="muLoraRow">
      <label for="muLora">LoRA</label>
      <select id="muLora">${loraHtml(st.model)}</select>
      <span class="form-row-hint">Baked checkpoint+adapter pairs. Strength is merge-time.</span>
    </div>
    ${knobs.filter((k) => !MU_BANK_KNOBS.includes(k) && !MU_GRID_KNOBS.includes(k)).map((k) => (KNOB_RENDER[k] ? KNOB_RENDER[k](st) : '')).join('')}
    ${muBankHtml(st, knobs)}
    ${muGridHtml(st, knobs)}
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
      min: 0, max: 4294967295, step: 1, decimals: 0,
    });
    if (document.getElementById('muSeedRand')) {
      setupBinaryKnob({
        knobId: 'muSeedRandKnob', indicatorId: 'muSeedRandKnobInd', hiddenId: 'muSeedRand',
        leftValue: '0', rightValue: '1', initial: _muState().seedRand ?? '1',
      });
    }
    const diceBtn2 = document.getElementById('btnMuDice');
    if (diceBtn2) { diceBtn2.setAttribute('data-help-title','Randomize Seed'); diceBtn2.setAttribute('data-help-text','Rolls a new random seed and updates display. Click to randomize.'); }
    document.getElementById('btnMuDice')?.addEventListener('click', () => {
      const n = Math.floor(Math.random() * 4294967296);
      const v = String(n);
      const hid = document.getElementById('muSeed');
      if (hid) { hid.value = v; hid.dispatchEvent(new Event('change', { bubbles: true })); }
      const val = document.getElementById('muSeedVal');
      if (val) val.value = v;
      const ind = document.getElementById('muSeedKnobInd');
      if (ind) ind.style.transform = `translate(-50%, -100%) rotate(${-135 + (n / 4294967295) * 270}deg)`;
      _muState().seed = n;
    });
  }
  if (knobs.includes('duration')) {
    setupContinuousKnob({
      knobId: 'muDurationKnob', indicatorId: 'muDurationKnobInd', valueId: 'muDurationVal', hiddenId: 'muDuration',
      min: 10, max: 60, step: 1, decimals: 0,
    });
  }
  if (knobs.includes('bpm')) {
    setupContinuousKnob({
      knobId: 'muBpmKnob', indicatorId: 'muBpmKnobInd', valueId: 'muBpmVal', hiddenId: 'muBpm',
      min: 0, max: 300, step: 0.001, decimals: 3,
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
  if (knobs.includes('shift')) {
    setupContinuousKnob({
      knobId: 'muShiftKnob', indicatorId: 'muShiftKnobInd', valueId: 'muShiftVal', hiddenId: 'muShift',
      min: 0.5, max: 8.0, step: 0.1, decimals: 1,
    });
  }
  if (knobs.includes('apg')) {
    setupBinaryKnob({
      knobId: 'muApgKnob', indicatorId: 'muApgKnobInd', hiddenId: 'muApg',
      leftValue: '0', rightValue: '1', initial: _muState().apg ?? '1',
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
    try { localStorage.setItem(MU_MODEL_KEY, e.target.value); } catch (_) { /* private mode */ }
    _muState().lora = '';
    _muState().task = 'text2music';
    renderMusicForm();
  });
  document.getElementById('muTask')?.addEventListener('change', (e) => {
    _muState().task = e.target.value;
    const row = document.getElementById('muSrcRow');
    if (row) row.style.display = e.target.value === 'cover' ? '' : 'none';
  });
  document.getElementById('muSrc')?.addEventListener('input', (e) => {
    _muState().srcAudio = e.target.value.trim();
  });
  document.getElementById('muSrc')?.addEventListener('change', (e) => {
    _muState().srcAudio = e.target.value.trim();
  });
  document.getElementById('btnMuSrcBrowse')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/picker?mode=files&filter=all&start_path=');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const p = (data.paths && data.paths[0]) || data.path;
      if (p) {
        _muState().srcAudio = p;
        const el = document.getElementById('muSrc');
        if (el) el.value = p;
      }
    } catch (err) {
      alert(`Picker failed: ${err.message}`);
    }
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
    const n = parseInt(e.target.value || '42', 10);
    _muState().seed = Number.isFinite(n) ? Math.min(4294967295, Math.max(0, n)) : 42;
  });
  document.getElementById('muSeedRand')?.addEventListener('change', (e) => {
    _muState().seedRand = e.target.value === '1' ? '1' : '0';
  });
  document.getElementById('muBpm')?.addEventListener('change', (e) => {
    _muState().bpm = e.target.value.trim();
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
  document.getElementById('muShift')?.addEventListener('change', (e) => {
    const v = parseFloat(e.target.value || '3.0');
    _muState().shift = Number.isFinite(v) ? Math.min(8, Math.max(0.5, v)) : 3.0;
  });
  document.getElementById('muApg')?.addEventListener('change', (e) => {
    _muState().apg = e.target.value === '1' ? '1' : '0';
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
  const model = document.getElementById('muModel')?.value || st.model || 'acestep-v15-base';
  st.model = model;
  const task = document.getElementById('muTask')?.value || 'text2music';
  st.task = task;
  const srcAudio = (document.getElementById('muSrc')?.value || st.srcAudio || '').trim();
  st.srcAudio = srcAudio;
  if (task === 'cover' && !srcAudio) {
    alert('Pick a source audio file for cover mode.');
    return null;
  }
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
  const seedRand = document.getElementById('muSeedRand')?.value ?? st.seedRand ?? '0';
  st.seedRand = seedRand === '1' ? '1' : '0';
  let seed;
  if (st.seedRand === '1') {
    seed = Math.floor(Math.random() * 4294967296);
    const hid = document.getElementById('muSeed');
    if (hid) { hid.value = String(seed); hid.dispatchEvent(new Event('change', { bubbles: true })); }
    const val = document.getElementById('muSeedVal');
    if (val) val.textContent = String(seed);
  } else {
    const seedRaw = parseInt(document.getElementById('muSeed')?.value ?? String(st.seed ?? 42), 10);
    seed = Number.isFinite(seedRaw) ? Math.min(4294967295, Math.max(0, seedRaw)) : 42;
  }
  st.seed = seed;
  const duration = Math.min(60, Math.max(10,
    parseFloat(document.getElementById('muDuration')?.value ?? String(st.duration ?? 12))));
  st.duration = duration;
  const bpmRaw = (document.getElementById('muBpm')?.value ?? st.bpm ?? '').trim();
  let bpm = '';
  if (bpmRaw !== '' && bpmRaw !== '0' && bpmRaw !== '0.000') {
    const bf = parseFloat(bpmRaw);
    if (Number.isFinite(bf)) bpm = String(Math.min(300, Math.max(20, bf)));
  }
  const key = document.getElementById('muKey')?.value ?? st.key ?? '';
  const timesig = document.getElementById('muTimesig')?.value ?? st.timesig ?? '';
  st.bpm = bpmRaw; st.key = key; st.timesig = timesig;
  const negative = (document.getElementById('muNegative')?.value ?? st.negative ?? '').trim();
  st.negative = negative;
  const steps = Math.min(60, Math.max(8,
    parseInt(document.getElementById('muSteps')?.value ?? String(st.steps ?? 50), 10)));
  st.steps = Number.isFinite(steps) ? steps : 50;
  const guidance = Math.min(15, Math.max(1,
    parseFloat(document.getElementById('muGuidance')?.value ?? String(st.guidance ?? 7.0))));
  st.guidance = Number.isFinite(guidance) ? guidance : 7.0;
  const shiftRaw = parseFloat(document.getElementById('muShift')?.value ?? String(st.shift ?? 3.0));
  const shift = Number.isFinite(shiftRaw) ? Math.min(8, Math.max(0.5, shiftRaw)) : 3.0;
  st.shift = shift;
  const apg = (document.getElementById('muApg')?.value ?? st.apg ?? '1') !== '0';
  st.apg = apg ? '1' : '0';
  return {
    prompt,
    lyrics,
    negative,
    steps: st.steps,
    guidance: st.guidance,
    shift: st.shift,
    apg,
    seed: st.seed,
    duration_sec: duration,
    model,
    device: document.getElementById('muDevice')?.value || st.device || 'HETERO',
    lora,
    task,
    src_audio: srcAudio,
    bpm, key, timesig,
    output_dir: document.getElementById('muOutDir')?.value?.trim() || null,
    output_format: document.getElementById('muFormat')?.value || 'wav-f32',
    overwrite: document.getElementById('muOverwrite')?.value === '1',
    dry_run: document.getElementById('muDryRun')?.value === '1',
  };
}

export { renderMusicForm, collectMusicBody };
