// Voice Extract tab — pyannote diarization + ECAPA-TDNN speaker matching
// Minimal controls to run the job and track progress.

import { escapeHtml } from '/js/utils.js';

let _pollInterval = null;

function _veState() {
  if (!window.__veState) {
    window.__veState = {
      audioPath: '',
      refClipPath: '',
      outputDir: '',
      threshold: 0.55,
      jobId: null,
    };
  }
  return window.__veState;
}

export function renderVoiceExtractForm() {
  const st = _veState();
  const panel = document.getElementById('actionPanel') || document.querySelector('.action-panel');
  if (!panel) return;

  panel.innerHTML = `
    <div class="panel-title-desc dense">
      <h3>Voice Extract</h3>
      <p class="dream-hint">
        Speaker diarization (pyannote 3) + ECAPA-TDNN speaker matching.
        Give a long audio file and a clean reference clip of the target speaker —
        gets all their segments and writes a combined <code>.opus</code>.
      </p>
    </div>

    <div class="form-row">
      <label for="veAudio">Episode audio</label>
      <div class="input-row">
        <input type="text" id="veAudio" placeholder="/path/to/episode.opus"
          value="${escapeHtml(st.audioPath)}">
        <button type="button" class="btn" id="btnVeAudioBrowse">Browse</button>
      </div>
    </div>

    <div class="form-row">
      <label for="veRef">Reference clip</label>
      <div class="input-row">
        <input type="text" id="veRef" placeholder="Short clip of target speaker (opus/wav/mp3…)"
          value="${escapeHtml(st.refClipPath)}">
        <button type="button" class="btn" id="btnVeRefBrowse">Browse</button>
      </div>
    </div>

    <div class="form-row">
      <label for="veOutDir">Output folder</label>
      <div class="input-row">
        <input type="text" id="veOutDir" placeholder="blank = sibling dir of episode"
          value="${escapeHtml(st.outputDir)}">
        <button type="button" class="btn" id="btnVeOutBrowse">Folder</button>
      </div>
    </div>

    <div class="form-row">
      <label for="veThreshold">Min similarity</label>
      <input type="number" id="veThreshold" min="0.1" max="0.99" step="0.01"
        value="${st.threshold}" style="width:6em">
      <span class="form-row-hint">Cosine similarity floor (0.55 = conservative, raise to tighten)</span>
    </div>

    <div class="form-row">
      <button type="button" class="btn btn-primary" id="btnVeRun">Run Voice Extract</button>
      <button type="button" class="btn" id="btnVeCancel" style="display:none">Cancel poll</button>
    </div>

    <div id="veProgress" style="display:none;margin-top:1em">
      <div style="display:flex;align-items:center;gap:.75em;margin-bottom:.5em">
        <div id="veBar" style="flex:1;height:8px;background:var(--color-border,#333);border-radius:4px;overflow:hidden">
          <div id="veBarFill" style="height:100%;width:0%;background:var(--color-accent,#6cf);transition:width .3s"></div>
        </div>
        <span id="vePct" style="min-width:3em;text-align:right">0%</span>
      </div>
      <pre id="veLog" style="max-height:14em;overflow-y:auto;font-size:.78em;
        background:var(--color-bg-raised,#1a1a1a);padding:.5em .75em;border-radius:4px;
        white-space:pre-wrap;word-break:break-word"></pre>
    </div>

    <div id="veResult" style="display:none;margin-top:1em">
      <div class="form-row-hint" id="veResultMsg"></div>
      <div class="form-row" style="margin-top:.5em">
        <label>Combined file</label>
        <input type="text" id="veCombinedPath" readonly style="flex:1">
        <button type="button" class="btn" id="btnVeCopyPath">Copy</button>
      </div>
    </div>
  `;

  // ── browse buttons ─────────────────────────────────────────────────────────
  async function browse(fieldId) {
    try {
      const res = await fetch('/api/picker?mode=files&filter=all&start_path=');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const p = (data.paths && data.paths[0]) || data.path;
      if (p) {
        document.getElementById(fieldId).value = p;
        if (fieldId === 'veAudio') _veState().audioPath = p;
        if (fieldId === 'veRef')   _veState().refClipPath = p;
      }
    } catch (err) { alert(`Picker failed: ${err.message}`); }
  }

  document.getElementById('btnVeAudioBrowse').addEventListener('click', () => browse('veAudio'));
  document.getElementById('btnVeRefBrowse').addEventListener('click', () => browse('veRef'));
  document.getElementById('btnVeOutBrowse').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/picker?mode=dirs&filter=all&start_path=');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const p = (data.paths && data.paths[0]) || data.path;
      if (p) document.getElementById('veOutDir').value = p;
    } catch (err) { alert(`Picker failed: ${err.message}`); }
  });

  // ── run ────────────────────────────────────────────────────────────────────
  document.getElementById('btnVeRun').addEventListener('click', async () => {
    const audio = document.getElementById('veAudio').value.trim();
    const ref   = document.getElementById('veRef').value.trim();
    const outDir = document.getElementById('veOutDir').value.trim();
    const threshold = parseFloat(document.getElementById('veThreshold').value || '0.55');

    if (!audio) { alert('Set the episode audio path.'); return; }
    if (!ref)   { alert('Set a reference clip path.'); return; }

    const st = _veState();
    st.audioPath = audio;
    st.refClipPath = ref;
    st.outputDir = outDir;
    st.threshold = threshold;

    _stopPoll();
    document.getElementById('veProgress').style.display = '';
    document.getElementById('veResult').style.display = 'none';
    document.getElementById('veLog').textContent = '';
    _setBar(0);
    document.getElementById('btnVeCancel').style.display = '';

    try {
      const res = await fetch('/api/voiceextract/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_path: audio,
          ref_clip_path: ref,
          output_dir: outDir || null,
          similarity_threshold: threshold,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Server error');
      st.jobId = data.job_id;
      _startPoll(st.jobId);
    } catch (err) {
      alert(`Failed to start job: ${err.message}`);
      document.getElementById('btnVeCancel').style.display = 'none';
    }
  });

  document.getElementById('btnVeCancel').addEventListener('click', _stopPoll);

  document.getElementById('btnVeCopyPath')?.addEventListener('click', () => {
    const p = document.getElementById('veCombinedPath').value;
    if (p) navigator.clipboard.writeText(p).catch(() => {});
  });

  // resume poll if a job was already running
  if (st.jobId) _startPoll(st.jobId);
}

function _setBar(pct) {
  const fill = document.getElementById('veBarFill');
  const label = document.getElementById('vePct');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `${pct}%`;
}

function _startPoll(jobId) {
  _stopPoll();
  _pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/voiceextract/status/${jobId}`);
      const data = await res.json();
      if (!data.ok) { _stopPoll(); return; }

      _setBar(data.pct || 0);

      const logEl = document.getElementById('veLog');
      if (logEl && Array.isArray(data.log)) {
        logEl.textContent = data.log.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
      }

      if (data.status === 'done') {
        _stopPoll();
        document.getElementById('btnVeCancel').style.display = 'none';
        _setBar(100);

        const resultDiv = document.getElementById('veResult');
        const msg = document.getElementById('veResultMsg');
        const pathEl = document.getElementById('veCombinedPath');

        if (resultDiv) resultDiv.style.display = '';
        if (msg) msg.textContent =
          `✓ ${data.total_segments} segments · ${(data.total_duration_s/60).toFixed(1)} min · saved to ${data.out_dir}`;
        if (pathEl) pathEl.value = data.combined_path || '';

        _veState().jobId = null;
      } else if (data.status === 'error') {
        _stopPoll();
        document.getElementById('btnVeCancel').style.display = 'none';
        const logEl = document.getElementById('veLog');
        if (logEl) logEl.textContent += `\n\nERROR: ${data.error}`;
        alert(`Voice Extract failed:\n${data.error}`);
        _veState().jobId = null;
      }
    } catch (_) { /* network hiccup, keep polling */ }
  }, 1500);
}

function _stopPoll() {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
}
