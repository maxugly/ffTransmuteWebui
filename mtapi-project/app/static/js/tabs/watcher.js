import { state, elements } from '/app.js';
import { escapeHtml } from '/js/utils.js';
import { setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { isApplyingFormState } from '/js/pool/persistence.js';

// In-flight user toggles, immune to poll re-sync until their POST lands.
// (A poll that predates the POST must not snap the knob back — that race
// silently drops the enable.)
const watcherPendingToggles = {};

// ── Folder Watcher tab ────────────────────────────────────────────────────

async function fetchWatcherStatus() {
  try {
    const r = await fetch('/api/watcher');
    const data = await r.json();
    state.watcher.status = data;
    if (typeof data.enabled === 'boolean') state.watcher.enabled = data.enabled;
    if (typeof data.pool_ingest === 'boolean') state.watcher.pool_ingest = data.pool_ingest;
    if (typeof data.pool_add_sequence === 'boolean') state.watcher.pool_add_sequence = data.pool_add_sequence;
    if (data.in_dir != null && data.in_dir !== '') state.watcher.in_dir = data.in_dir;
    if (data.out_dir != null && data.out_dir !== '') state.watcher.out_dir = data.out_dir;
    if (data.resize_mode) state.watcher.resize_mode = data.resize_mode;
    return data;
  } catch (e) {
    console.warn('watcher status', e);
    return null;
  }
}

async function postWatcherConfig(body) {
  const r = await fetch('/api/watcher', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  state.watcher.status = data;
  if (typeof data.enabled === 'boolean') state.watcher.enabled = data.enabled;
  if (typeof data.pool_ingest === 'boolean') state.watcher.pool_ingest = data.pool_ingest;
  if (typeof data.pool_add_sequence === 'boolean') state.watcher.pool_add_sequence = data.pool_add_sequence;
  return data;
}

function renderWatcherForm() {
  const st = state.watcher.status || {};
  const enabled = !!state.watcher.enabled;
  const poolIngest = !!state.watcher.pool_ingest;
  const poolAddSeq = !!state.watcher.pool_add_sequence;
  const inDir = state.watcher.in_dir || st.in_dir || '';
  const outDir = state.watcher.out_dir || st.out_dir || '';
  const mode = state.watcher.resize_mode || st.resize_mode || 'letterbox';
  const running = !!st.running;
  const processing = st.processing || '';
  const lastErr = st.last_error || st.error || '';
  const logs = Array.isArray(st.log_lines) ? st.log_lines.slice().reverse() : [];
  const logHtml = logs.length
    ? logs.map(l => `<div class="watcher-log-line">${escapeHtml(l)}</div>`).join('')
    : `<div class="watcher-log-line dim">No events yet.</div>`;

  const anyOn = enabled || poolIngest;
  const statusLabel = anyOn
    ? (running ? 'Watching' : 'Starting…')
    : 'Off';
  const statusClass = anyOn ? (running ? 'ok' : 'warn') : 'off';

  elements.actionPanel.innerHTML = `
    <div class="panel-title-desc">
      <h3>Folder Watcher</h3>
      <p>
        Drop videos into the <strong>input</strong> folder. Two independent jobs
        share the one poll loop — run either, both, or neither:
      </p>
    </div>

    <div class="form-group watcher-controls">
      <div class="knob-row" style="display:flex; align-items:flex-end; gap:28px; flex-wrap:wrap;">
        ${knobUnitHtml({
          id: 'watcherEnabled',
          label: 'DNxHR',
          value: enabled ? '1' : '0',
          binary: true,
          leftCap: 'Off',
          rightCap: 'On',
        })}
        ${knobUnitHtml({
          id: 'watcherPoolIngest',
          label: 'Pool import',
          value: poolIngest ? '1' : '0',
          binary: true,
          leftCap: 'Off',
          rightCap: 'On',
        })}
        <div class="watcher-status-pill status-${statusClass}" id="watcherStatusPill">
          <span class="watcher-status-dot"></span>
          <span id="watcherStatusText">${escapeHtml(statusLabel)}</span>
        </div>
      </div>
    </div>

    <div class="form-group">
      <label>Input directory (both jobs)</label>
      <div class="input-row">
        <input type="text" id="watcherInDir" placeholder="/absolute/path/to/in" value="${escapeHtml(inDir)}">
        <button type="button" class="btn" id="btnWatcherInBrowse">Browse</button>
      </div>
      <span class="field-desc">Polled every ~2s for new video files (mp4, mov, mkv, …).</span>
    </div>

    <div class="form-group">
      <label>DNxHR — output directory</label>
      <div class="input-row">
        <input type="text" id="watcherOutDir" placeholder="/absolute/path/to/out" value="${escapeHtml(outDir)}">
        <button type="button" class="btn" id="btnWatcherOutBrowse">Browse</button>
      </div>
      <span class="field-desc">While the <strong>DNxHR</strong> knob is
        <strong>On</strong>, arrivals are converted to Resolve-friendly DNxHR
        <code>.mov</code> here as <code>*_resolve.mov</code>. Each output is
        registered as a <code>dnxhr</code> proxy variant of the original, so the
        Sequence file picker lists Original / dnxhr (/ rifed) from one record.
        Sources move to a <code>dun/</code> subfolder under input when finished.
      </span>
    </div>

    <div class="form-group">
      <label>Aspect fit (when AR ≠ 16:9)</label>
      <select id="watcherResizeMode">
        <option value="letterbox" ${mode === 'letterbox' ? 'selected' : ''}>Letterbox (pad, no scale-up)</option>
        <option value="crop" ${mode === 'crop' ? 'selected' : ''}>Crop (center, no scale-up)</option>
      </select>
    </div>

    <div class="form-group">
      <label>Pool import</label>
      <div class="quick-summary-box">
        <div>While the <strong>Pool import</strong> knob is <strong>On</strong>,
          every stabilized arrival is appended to the Video Pool straight from
          the server (works with the browser closed — pick it up on next load),
          then moved to <code>dun/</code>. RIFE never runs here: Sequence
          Instant-RIFE and auto first/last fire through the normal import funnel
          once the clip lands.</div>
        <label style="display:flex; align-items:center; gap:8px; margin-top:8px;">
          <input type="checkbox" id="watcherPoolAddSeq" ${poolAddSeq ? 'checked' : ''}>
          Also add to Sequence
        </label>
      </div>
    </div>

    <div class="form-group watcher-stats" id="watcherStats">
      <label>Activity</label>
      <div class="quick-summary-box">
        <div>Transcoded: <strong id="watcherProcessed">${st.processed_count ?? 0}</strong>
          · Failed: <strong id="watcherFailed">${st.failed_count ?? 0}</strong>
          · Pool-imported: <strong id="watcherPoolIngested">${st.pool_ingested_count ?? 0}</strong></div>
        <div id="watcherProcessingLine" class="field-desc" style="margin-top:6px;">
          ${processing ? `Working on: <code>${escapeHtml(processing)}</code>` : 'Idle'}
        </div>
        ${lastErr ? `<div class="watcher-error" style="margin-top:8px; color:var(--danger, #f66);">${escapeHtml(lastErr)}</div>` : ''}
      </div>
    </div>

    <div class="form-group">
      <label>Log</label>
      <div class="watcher-log" id="watcherLog">${logHtml}</div>
    </div>
  `;

  setupBinaryKnob({
    knobId: 'watcherEnabledKnob',
    indicatorId: 'watcherEnabledKnobInd',
    hiddenId: 'watcherEnabled',
    leftValue: '0',
    rightValue: '1',
    initial: enabled ? '1' : '0',
  });

  setupBinaryKnob({
    knobId: 'watcherPoolIngestKnob',
    indicatorId: 'watcherPoolIngestKnobInd',
    hiddenId: 'watcherPoolIngest',
    leftValue: '0',
    rightValue: '1',
    initial: poolIngest ? '1' : '0',
  });

  // Snap a binary knob back to Off without firing change again (enable refused).
  const snapKnobOff = (base) => {
    const hid = document.getElementById(base);
    if (hid) hid.value = '0';
    const knob = document.getElementById(`${base}Knob`);
    const ind = document.getElementById(`${base}KnobInd`);
    if (knob && ind) {
      ind.style.transform = 'translate(-50%, -100%) rotate(-110deg)';
      knob.classList.remove('is-right');
      knob.parentElement?.querySelector('.cap-left')?.classList.add('cap-on');
      knob.parentElement?.querySelector('.cap-right')?.classList.remove('cap-on');
    }
  };

  document.getElementById('btnWatcherInBrowse')?.addEventListener('click', () => {
    openFileBrowser('watcherInDir', true, 'dir', 'all');
  });
  document.getElementById('btnWatcherOutBrowse')?.addEventListener('click', () => {
    openFileBrowser('watcherOutDir', true, 'dir', 'all');
  });

  // Serialize config POSTs: knob + checkbox + path edits all post full
  // snapshots, and overlapping fetches can land out of order (last write
  // wins — e.g. a slow checkbox POST re-disabling a just-enabled job).
  let watcherPostChain = Promise.resolve();
  const applyPaths = () => {
    watcherPostChain = watcherPostChain.then(() => applyPathsOnce());
    return watcherPostChain;
  };

  const applyPathsOnce = async () => {
    const in_dir = document.getElementById('watcherInDir')?.value?.trim() || '';
    const out_dir = document.getElementById('watcherOutDir')?.value?.trim() || '';
    const resize_mode = document.getElementById('watcherResizeMode')?.value || 'letterbox';
    const pool_add_sequence = !!document.getElementById('watcherPoolAddSeq')?.checked;
    state.watcher.in_dir = in_dir;
    state.watcher.out_dir = out_dir;
    state.watcher.resize_mode = resize_mode;
    state.watcher.pool_add_sequence = pool_add_sequence;
    return postWatcherConfig({
      enabled: document.getElementById('watcherEnabled')?.value === '1',
      pool_ingest: document.getElementById('watcherPoolIngest')?.value === '1',
      pool_add_sequence,
      in_dir,
      out_dir,
      resize_mode,
    });
  };

  document.getElementById('watcherEnabled')?.addEventListener('change', async () => {
    const hid = document.getElementById('watcherEnabled');
    if (!hid || !hid.isConnected) return; // stale render — never POST ghosts
    const on = hid.value === '1';
    state.watcher.enabled = on;
    if (isApplyingFormState()) return;
    watcherPendingToggles.watcherEnabled = on ? '1' : '0';
    let data = null;
    try {
      data = await applyPaths();
    } finally {
      delete watcherPendingToggles.watcherEnabled;
    }
    if (data && data.ok === false && on && !data.enabled) {
      alert(data.error || data.last_error || 'Could not enable DNxHR watcher');
      state.watcher.enabled = false;
      snapKnobOff('watcherEnabled');
    }
    updateWatcherLiveUI(data || state.watcher.status);
  });

  document.getElementById('watcherPoolIngest')?.addEventListener('change', async () => {
    const hid = document.getElementById('watcherPoolIngest');
    if (!hid || !hid.isConnected) return; // stale render — never POST ghosts
    const on = hid.value === '1';
    state.watcher.pool_ingest = on;
    if (isApplyingFormState()) return;
    watcherPendingToggles.watcherPoolIngest = on ? '1' : '0';
    let data = null;
    try {
      data = await applyPaths();
    } finally {
      delete watcherPendingToggles.watcherPoolIngest;
    }
    if (data && data.ok === false && on && !data.pool_ingest) {
      alert(data.error || data.last_error || 'Could not enable pool import');
      state.watcher.pool_ingest = false;
      snapKnobOff('watcherPoolIngest');
    }
    updateWatcherLiveUI(data || state.watcher.status);
  });

  document.getElementById('watcherPoolAddSeq')?.addEventListener('change', async () => {
    const box = document.getElementById('watcherPoolAddSeq');
    if (!box || !box.isConnected) return; // stale render — never POST ghosts
    state.watcher.pool_add_sequence = !!box.checked;
    if (isApplyingFormState()) return;
    watcherPendingToggles.watcherPoolAddSeq = true;
    let data = null;
    try {
      data = await applyPaths();
    } finally {
      delete watcherPendingToggles.watcherPoolAddSeq;
    }
    updateWatcherLiveUI(data || state.watcher.status);
  });

  const bindWatcherField = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    const sync = () => {
      if (key === 'resize_mode') state.watcher.resize_mode = el.value || 'letterbox';
      else state.watcher[key] = el.value?.trim() || '';
    };
    el.addEventListener('input', sync);
    el.addEventListener('change', () => {
      sync();
      if (!isApplyingFormState()) applyPaths();
    });
  };
  bindWatcherField('watcherInDir', 'in_dir');
  bindWatcherField('watcherOutDir', 'out_dir');
  bindWatcherField('watcherResizeMode', 'resize_mode');

  // Initial fetch + poll while tab open
  fetchWatcherStatus().then((data) => {
    if (!data) return;
    // refresh fields if server had saved paths
    const inEl = document.getElementById('watcherInDir');
    const outEl = document.getElementById('watcherOutDir');
    if (inEl && data.in_dir) inEl.value = data.in_dir;
    if (outEl && data.out_dir) outEl.value = data.out_dir;
    updateWatcherLiveUI(data);
  });

  if (state.watcher.pollTimer) clearInterval(state.watcher.pollTimer);
  state.watcher.pollTimer = setInterval(async () => {
    if (state.activeTab !== 'watcher') return;
    const data = await fetchWatcherStatus();
    if (data) updateWatcherLiveUI(data);
  }, 2000);
}

function updateWatcherLiveUI(st) {
  if (!st || state.activeTab !== 'watcher') return;
  if (typeof st.enabled === 'boolean') state.watcher.enabled = st.enabled;
  if (typeof st.pool_ingest === 'boolean') state.watcher.pool_ingest = st.pool_ingest;
  if (typeof st.pool_add_sequence === 'boolean') state.watcher.pool_add_sequence = st.pool_add_sequence;
  // Server is truth: re-sync knob visuals (covers reload-while-on; the
  // change handlers already POST before the next poll, so this converges).
  // In-flight user toggles are immune: a poll that predates their POST must
  // not snap the knob back (that race silently drops the enable).
  const syncKnob = (base, on) => {
    if (watcherPendingToggles[base] != null) return;
    const hid = document.getElementById(base);
    if (!hid) return;
    const want = on ? '1' : '0';
    if (hid.value === want) return;
    hid.value = want;
    const knob = document.getElementById(`${base}Knob`);
    const ind = document.getElementById(`${base}KnobInd`);
    if (knob && ind) {
      ind.style.transform = `translate(-50%, -100%) rotate(${on ? 110 : -110}deg)`;
      knob.classList.toggle('is-right', !!on);
      knob.parentElement?.querySelector('.cap-left')?.classList.toggle('cap-on', !on);
      knob.parentElement?.querySelector('.cap-right')?.classList.toggle('cap-on', !!on);
    }
  };
  syncKnob('watcherEnabled', !!st.enabled);
  syncKnob('watcherPoolIngest', !!st.pool_ingest);
  const seqBox = document.getElementById('watcherPoolAddSeq');
  if (seqBox && typeof st.pool_add_sequence === 'boolean'
      && watcherPendingToggles.watcherPoolAddSeq == null) {
    seqBox.checked = !!st.pool_add_sequence;
  }
  const anyOn = !!(st.enabled || st.pool_ingest);
  const running = !!st.running;
  const pill = document.getElementById('watcherStatusPill');
  const text = document.getElementById('watcherStatusText');
  if (pill && text) {
    pill.classList.remove('status-ok', 'status-warn', 'status-off');
    const cls = anyOn ? (running ? 'ok' : 'warn') : 'off';
    pill.classList.add(`status-${cls}`);
    text.textContent = anyOn ? (running ? 'Watching' : 'Starting…') : 'Off';
  }
  const proc = document.getElementById('watcherProcessed');
  const fail = document.getElementById('watcherFailed');
  if (proc) proc.textContent = String(st.processed_count ?? 0);
  if (fail) fail.textContent = String(st.failed_count ?? 0);
  const ing = document.getElementById('watcherPoolIngested');
  if (ing) ing.textContent = String(st.pool_ingested_count ?? 0);
  const pl = document.getElementById('watcherProcessingLine');
  if (pl) {
    pl.innerHTML = st.processing
      ? `Working on: <code>${escapeHtml(st.processing)}</code>`
      : 'Idle';
  }
  const logEl = document.getElementById('watcherLog');
  if (logEl && Array.isArray(st.log_lines)) {
    const logs = st.log_lines.slice().reverse();
    logEl.innerHTML = logs.length
      ? logs.map(l => `<div class="watcher-log-line">${escapeHtml(l)}</div>`).join('')
      : `<div class="watcher-log-line dim">No events yet.</div>`;
  }
}

export { fetchWatcherStatus, postWatcherConfig, renderWatcherForm, updateWatcherLiveUI };
