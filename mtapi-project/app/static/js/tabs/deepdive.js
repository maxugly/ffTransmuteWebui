/** Deep Dive tab — run every analysis model on one track.
 *
 * Entry: the Media Catalog's 🔬 Dive action (or pick a track here directly).
 * One job (`deep_dive` op) orchestrates, server-side, with the standard job
 * machinery (progress + cancel free): Demucs stems, Essentia key/tempo/beats/
 * onsets with competing engine opinions, Basic Pitch note transcription +
 * tempo-map MIDI, and an optional CDP pipeline echo for browser execution.
 *
 * One model failing never fails the dive — each result lands with its own
 * ok badge, and generated artifacts are stamped in the Media Catalog as they
 * complete. Results play inline (stems) and the dive report is a sibling
 * `<track>.deepdive.json`.
 */
import { state, elements, switchTab, logConsole } from '/app.js?v=2';
import { runOpWithCancel } from '/js/job-control.js';
import { escapeHtml } from '/js/utils.js';

const DEMUCS_MODELS = {
  htdemucs: { label: 'htdemucs · 4 stems', stems: ['drums', 'bass', 'other', 'vocals'] },
  htdemucs_6s: { label: 'htdemucs_6s · 6 stems (+guitar/piano)', stems: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] },
  htdemucs_ft: { label: 'htdemucs_ft · 4 stems (4-model bag)', stems: ['drums', 'bass', 'other', 'vocals'] },
};
const ALL_STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
const STEM_ICONS = { drums: '🥁', bass: '🎸', other: '🎹', vocals: '🎤', guitar: '🎸', piano: '🎹' };

const PENDING_KEY = 'deepdive_pending_path';
const LS_OPTS = 'deepdive_options';

let lastResult = null;

function _el(id) { return document.getElementById(id); }
function _esc(s) { return escapeHtml(String(s == null ? '' : s)); }
function _log(msg, kind) { try { logConsole(msg, kind); } catch (_) { /* ignore */ } }

export function renderDeepDiveForm() {
  const saved = JSON.parse(localStorage.getItem(LS_OPTS) || '{}');
  const pending = localStorage.getItem(PENDING_KEY);
  if (pending) {
    localStorage.removeItem(PENDING_KEY);
    localStorage.setItem('deepdive_input', pending);
    // The universal form-state restore runs right after this render and would
    // overwrite the input with the last session's snapshot (measured: the
    // stale path won over the catalog handoff) — re-assert after that pass.
    setTimeout(() => {
      const input = _el('ddInput');
      if (input && input.value !== pending) {
        input.value = pending;
        localStorage.setItem('deepdive_input', pending);
      }
    }, 0);
  }
  const lastInput = localStorage.getItem('deepdive_input') || '';

  elements.actionPanel.innerHTML = `
    <div class="dd-workspace" id="ddWorkspace">
      <div class="dd-topbar">
        <span class="panel-title-desc dense">Deep Dive — every analysis model on one track</span>
        <span class="dd-pill" id="ddStatus">ready</span>
      </div>
      <div class="dd-cols">
        <section class="dd-opts card">
          <div class="dd-field">
            <label for="ddInput">Track</label>
            <div class="dd-input-row">
              <input type="text" id="ddInput" placeholder="/absolute/path/to/track.flac" value="${_esc(lastInput)}"
                     data-help-title="Track to dive on" data-help-text="Any media file with an audio track. Demucs handles video input itself; analysis decodes via ffmpeg." />
              <button type="button" class="btn" id="btnDdPick" data-help-title="Browse" data-help-text="Open the in-app file picker.">Browse…</button>
            </div>
          </div>

          <div class="dd-group-title">Demucs stems</div>
          <div class="dd-row">
            <select id="ddModel" data-help-title="Demucs model" data-help-text="4-stem, 6-stem (adds guitar/piano), or the 4-model fine-tuned bag.">
              ${Object.entries(DEMUCS_MODELS).map(([id, m]) => `<option value="${id}"${saved.demucs_model === id ? ' selected' : ''}>${_esc(m.label)}</option>`).join('')}
            </select>
            <select id="ddDevice" data-help-title="Device" data-help-text="OpenVINO device. GPU is strict — it fails loudly rather than silently falling back to CPU.">
              ${['GPU', 'GPU.0', 'CPU'].map((d) => `<option${saved.demucs_device === d || (!saved.demucs_device && d === 'GPU') ? ' selected' : ''}>${d}</option>`).join('')}
            </select>
          </div>
          <div class="dd-stems" id="ddStems"></div>

          <div class="dd-group-title">Analysis</div>
          <label class="dd-toggle"><input type="checkbox" id="ddKey" ${saved.analyze_key !== false ? 'checked' : ''} data-help-title="Key" data-help-text="Essentia key + confidence." /> Key</label>
          <label class="dd-toggle"><input type="checkbox" id="ddTempo" ${saved.analyze_tempo !== false ? 'checked' : ''} data-help-title="Tempo" data-help-text="Essentia BPM detection." /> Tempo</label>
          <label class="dd-toggle"><input type="checkbox" id="ddBeats" ${saved.analyze_beats !== false ? 'checked' : ''} data-help-title="Beats & onsets" data-help-text="Beat grid, downbeat phase (assumed 4/4), and onset density." /> Beats &amp; onsets</label>
          <label class="dd-toggle"><input type="checkbox" id="ddPitch" ${saved.basic_pitch !== false ? 'checked' : ''} data-help-title="Basic Pitch" data-help-text="Neural note transcription → .notes.mid, plus a tempo-map .mid." /> Basic Pitch MIDI</label>
          <label class="dd-toggle"><input type="checkbox" id="ddLegacy" ${saved.include_legacy !== false ? 'checked' : ''} data-help-title="Legacy engines" data-help-text="madmom + librosa competing opinions (~5× slower). OFF is Essentia only." /> Competing engines</label>

          <div class="dd-group-title">Generation</div>
          <label class="dd-toggle"><input type="checkbox" id="ddCdp" data-help-title="CDP pipeline after" data-help-text="Echo the CDP tab's current pipeline for browser execution after the dive — transform the track or its stems in the CDP tab." /> CDP pipeline (from CDP tab)</label>
          <div class="dd-row">
            <select id="ddFormat" data-help-title="Stem format" data-help-text="float32 default; pcm24 = integer with clipping report.">
              <option value="wav-f32"${saved.output_format === 'wav-pcm24' ? '' : ' selected'}>wav-f32</option>
              <option value="wav-pcm24"${saved.output_format === 'wav-pcm24' ? ' selected' : ''}>wav-pcm24</option>
            </select>
            <label class="dd-toggle"><input type="checkbox" id="ddOverwrite" ${saved.overwrite ? 'checked' : ''} data-help-title="Overwrite" data-help-text="Overwrite existing outputs. Default: never — new files get _0001 suffixes." /> Overwrite</label>
          </div>

          <div class="dd-run-row">
            <button type="button" class="btn primary" id="btnDdRun" data-help-title="Run Deep Dive" data-help-text="One job runs Demucs, Essentia, Basic Pitch and the CDP echo. A model failing never fails the dive — every result lands with its own badge.">Dive</button>
            <button type="button" class="btn" id="btnDdDry" data-help-title="Dry run" data-help-text="Plan the dive (Demucs side) without writing anything.">Dry run</button>
          </div>
        </section>

        <section class="dd-results card" id="ddResults">
          <div class="dd-empty">run a dive to see per-model results</div>
        </section>
      </div>
    </div>`;

  renderStemCheckboxes();
  _el('ddModel')?.addEventListener('change', renderStemCheckboxes);
  _el('btnDdPick')?.addEventListener('click', pickTrack);
  _el('ddInput')?.addEventListener('change', () => localStorage.setItem('deepdive_input', _el('ddInput').value.trim()));
  _el('btnDdRun')?.addEventListener('click', () => runDive(false));
  _el('btnDdDry')?.addEventListener('click', () => runDive(true));

  // a dive result can be opened from the catalog while this tab is cached —
  // re-render a fresh run state only when the action panel was remounted
  if (lastResult) renderResults(lastResult);
}

function renderStemCheckboxes() {
  const box = _el('ddStems');
  if (!box) return;
  const model = _el('ddModel')?.value || 'htdemucs';
  const allowed = DEMUCS_MODELS[model].stems;
  const saved = JSON.parse(localStorage.getItem(LS_OPTS) || '{}');
  const chosen = saved.demucs_stems || allowed;
  box.innerHTML = ALL_STEMS.map((s) => {
    const on = allowed.includes(s) && chosen.includes(s);
    return `<label class="dd-stem${allowed.includes(s) ? '' : ' off'}">
      <input type="checkbox" data-stem="${s}" ${on ? 'checked' : ''} ${allowed.includes(s) ? '' : 'disabled'} />
      ${STEM_ICONS[s] || ''} ${s}
    </label>`;
  }).join('');
}

async function pickTrack() {
  const res = await fetch('/api/picker?mode=file');
  if (!res.ok) return;
  const data = await res.json();
  if (!data.path) return;
  _el('ddInput').value = data.path;
  localStorage.setItem('deepdive_input', data.path);
}

function collectOptions(dryRun) {
  const model = _el('ddModel')?.value || 'htdemucs';
  const allowed = DEMUCS_MODELS[model].stems;
  const stems = [...document.querySelectorAll('#ddStems input:checked')]
    .map((c) => c.dataset.stem).filter((s) => allowed.includes(s));
  const opts = {
    input_path: (_el('ddInput')?.value || '').trim(),
    demucs_model: model,
    demucs_device: _el('ddDevice')?.value || 'GPU',
    demucs_stems: stems.length ? stems : null,
    analyze_key: _el('ddKey')?.checked ?? true,
    analyze_tempo: _el('ddTempo')?.checked ?? true,
    analyze_beats: _el('ddBeats')?.checked ?? true,
    basic_pitch: _el('ddPitch')?.checked ?? true,
    include_legacy: _el('ddLegacy')?.checked ?? true,
    output_format: _el('ddFormat')?.value || 'wav-f32',
    overwrite: _el('ddOverwrite')?.checked ?? false,
    dry_run: !!dryRun,
  };
  if (_el('ddCdp')?.checked) {
    const pipe = localStorage.getItem('cdp_pipeline_autosave');
    if (pipe) opts.cdp_pipeline_json = pipe;
  }
  localStorage.setItem(LS_OPTS, JSON.stringify(opts));
  return opts;
}

async function runDive(dryRun) {
  const opts = collectOptions(dryRun);
  if (!opts.input_path) {
    _log('[Deep Dive] pick a track first', 'error');
    return;
  }
  const status = _el('ddStatus');
  if (status) { status.textContent = dryRun ? 'planning…' : 'diving…'; status.className = 'dd-pill run'; }
  const results = _el('ddResults');
  if (results) results.innerHTML = '<div class="dd-empty">running — progress in the console drawer</div>';
  lastResult = null;

  const out = await runOpWithCancel('deep_dive', opts, {
    label: dryRun ? 'Deep Dive (dry run)' : 'Deep Dive',
  });

  if (status) {
    status.textContent = out?.ok ? 'dive complete' : 'dive failed (see console)';
    status.className = out?.ok ? 'dd-pill ok' : 'dd-pill bad';
  }
  if (out?.ok && out.meta) {
    lastResult = out.meta;
    renderResults(out.meta);
    _log(`[Deep Dive] complete — report ${out.meta.report || ''}`);
  } else if (out && !out.ok) {
    if (results) results.innerHTML = `<div class="dd-error">${_esc(out.error || 'dive failed')}</div>`;
    _log(`[Deep Dive] failed — ${out.error || 'unknown'}`, 'error');
  }
}

function renderResults(meta) {
  const box = _el('ddResults');
  if (!box) return;
  const r = meta.results || {};
  const failures = meta.failures || {};

  const badge = (ok, text) => `<span class="dd-badge${ok ? ' ok' : ' bad'}">${ok ? '✓' : '✗'} ${_esc(text)}</span>`;

  // Demucs
  let stemsHtml = '';
  const demucs = r.demucs || {};
  if (demucs.ok && demucs.stems) {
    stemsHtml = Object.entries(demucs.stems).map(([name, path]) => `
      <div class="dd-stem-out">
        <span class="dd-stem-name">${STEM_ICONS[name] || ''} ${_esc(name)}</span>
        <span class="dd-stem-path" title="${_esc(path)}">${_esc(path)}</span>
        <audio controls src="/api/video?path=${encodeURIComponent(path)}"></audio>
      </div>`).join('');
  }

  // Essentia
  const es = r.essentia || {};
  let essentiaHtml = '';
  if (es.ok) {
    const rows = [
      ['key', es.key ? `${es.key} (${(es.key_confidence ?? 0).toFixed(2)})` : '—'],
      ['tempo', es.tempo != null ? `${es.tempo} BPM${es.tempo_implausible ? ' ⚠ implausible' : ''}` : '—'],
      ['beats', es.beats_count != null ? `${es.beats_count} · downbeats ${es.downbeats?.length ?? '—'}` : '—'],
      ['onsets', es.onset_rate != null ? `${es.onset_rate}/s` : '—'],
      ['meter', es.meter_assumed ? '4/4 (assumed)' : (es.time_signature || '—')],
      ['content', es.content_class || '—'],
      ['engines', es.tempo_engine && es.key_engine ? `${es.tempo_engine} · ${es.key_engine}` : '—'],
      ['spread', es.tempo_spread_bpm != null ? `${es.tempo_spread_bpm} BPM across engines` : '—'],
    ].map(([k, v]) => `<tr><td>${k}</td><td>${_esc(String(v))}</td></tr>`).join('');
    essentiaHtml = `<table class="dd-table">${rows}</table>`;
    if (es.sidecar_json_path) {
      essentiaHtml += `<div class="dd-out-meta">sidecar: ${_esc(es.sidecar_json_path)}</div>`;
    }
  }

  // Basic Pitch / MIDI
  const bp = r.basic_pitch || {};
  let midiHtml = '';
  if (bp.ok) {
    if (bp.notes) {
      midiHtml += `<div class="dd-out-meta">notes: ${_esc(bp.notes)} (${bp.note_count ?? '?'} notes)</div>`;
    }
    if (bp.tempo_map) {
      midiHtml += `<div class="dd-out-meta">tempo map: ${_esc(bp.tempo_map)}</div>`;
    }
  }

  // CDP echo
  const cdp = r.cdp || {};
  let cdpHtml = '';
  if (cdp.ok) {
    cdpHtml = `<button type="button" class="btn" id="btnDdOpenCdp" data-help-title="Open the CDP pipeline" data-help-text="Switches to the CDP tab in Pipeline mode with the echoed chain loaded — transform this track right away.">Open in CDP pipeline mode →</button>`;
  }

  const failList = Object.entries(failures).map(([k, v]) =>
    `<div class="dd-out-meta bad">${_esc(k)}: ${_esc(v)}</div>`).join('');

  box.innerHTML = `
    <div class="dd-report">
      <div class="dd-model-card">
        <div class="dd-model-head">${badge(demucs.ok, `Demucs stems · ${demucs.model || meta.failures?.demucs ? (demucs.model || '?') : ''}`)}
          ${demucs.ok ? `<span class="dd-out-meta">device ${_esc(demucs.device_settled || '?')} · ${demucs.infer_s != null ? (demucs.infer_s).toFixed(1) + ' s' : ''}</span>` : ''}</div>
        ${stemsHtml}
      </div>
      <div class="dd-model-card">
        <div class="dd-model-head">${badge(es.ok, 'Essentia analysis')}</div>
        ${essentiaHtml}
      </div>
      <div class="dd-model-card">
        <div class="dd-model-head">${badge(bp.ok, 'Basic Pitch · MIDI')}</div>
        ${midiHtml}
      </div>
      <div class="dd-model-card">
        <div class="dd-model-head">${badge(cdp.ok, 'CDP pipeline')}
          ${cdp.ok ? '' : `<span class="dd-out-meta">${_esc(cdp.reason || '')}</span>`}</div>
        ${cdpHtml}
      </div>
      ${failList ? `<div class="dd-model-card"><div class="dd-model-head">failures</div>${failList}</div>` : ''}
      ${meta.report ? `<div class="dd-out-meta">dive report: ${_esc(meta.report)}</div>` : ''}
    </div>`;

  _el('btnDdOpenCdp')?.addEventListener('click', () => {
    localStorage.setItem('cdp_start_mode', 'pipeline');
    switchTab('cdp');
  });
}
