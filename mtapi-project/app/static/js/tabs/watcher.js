import { state, elements } from '/app.js';
import { escapeHtml } from '/js/utils.js';
import { setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { isApplyingFormState } from '/js/pool/persistence.js';

// ── Folder Watcher tab ────────────────────────────────────────────────────

async function fetchWatcherStatus() {
  try {
    const r = await fetch('/api/watcher');
    const data = await r.json();
    state.watcher.status = data;
    if (typeof data.enabled === 'boolean') state.watcher.enabled = data.enabled;
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
  return data;
}

function renderWatcherForm() {
  const st = state.watcher.status || {};
  const enabled = !!state.watcher.enabled;
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

  const statusLabel = enabled
    ? (running ? 'Watching' : 'Starting…')
    : 'Off';
  const statusClass = enabled ? (running ? 'ok' : 'warn') : 'off';

  elements.actionPanel.innerHTML = `
    <div class="panel-title-desc">
      <h3>Folder Watcher</h3>
      <p>
        Drop videos into the <strong>input</strong> folder. While the knob is
        <strong>On</strong>, they are converted to Resolve-friendly DNxHR
        <code>.mov</code> in the <strong>output</strong> folder. Sources move to
        a <code>dun/</code> subfolder under input when finished.
        Default is <strong>Off</strong> — nothing runs until you turn it on.
      </p>
    </div>

    <div class="form-group watcher-controls">
      <div class="knob-row" style="display:flex; align-items:flex-end; gap:28px; flex-wrap:wrap;">
        ${knobUnitHtml({
          id: 'watcherEnabled',
          label: 'Watcher',
          value: enabled ? '1' : '0',
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
      <label>Input directory</label>
      <div class="input-row">
        <input type="text" id="watcherInDir" placeholder="/absolute/path/to/in" value="${escapeHtml(inDir)}">
        <button type="button" class="btn" id="btnWatcherInBrowse">Browse</button>
      </div>
      <span class="field-desc">Polled every ~2s for new video files (mp4, mov, mkv, …).</span>
    </div>

    <div class="form-group">
      <label>Output directory</label>
      <div class="input-row">
        <input type="text" id="watcherOutDir" placeholder="/absolute/path/to/out" value="${escapeHtml(outDir)}">
        <button type="button" class="btn" id="btnWatcherOutBrowse">Browse</button>
      </div>
      <span class="field-desc">Finished files land here as <code>*_resolve.mov</code>.</span>
    </div>

    <div class="form-group">
      <label>Aspect fit (when AR ≠ 16:9)</label>
      <select id="watcherResizeMode">
        <option value="letterbox" ${mode === 'letterbox' ? 'selected' : ''}>Letterbox (pad, no scale-up)</option>
        <option value="crop" ${mode === 'crop' ? 'selected' : ''}>Crop (center, no scale-up)</option>
      </select>
    </div>

    <div class="form-group watcher-stats" id="watcherStats">
      <label>Activity</label>
      <div class="quick-summary-box">
        <div>Processed: <strong id="watcherProcessed">${st.processed_count ?? 0}</strong>
          · Failed: <strong id="watcherFailed">${st.failed_count ?? 0}</strong></div>
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

  document.getElementById('btnWatcherInBrowse')?.addEventListener('click', () => {
    openFileBrowser('watcherInDir', true, 'dir', 'all');
  });
  document.getElementById('btnWatcherOutBrowse')?.addEventListener('click', () => {
    openFileBrowser('watcherOutDir', true, 'dir', 'all');
  });

  const applyPaths = async () => {
    const in_dir = document.getElementById('watcherInDir')?.value?.trim() || '';
    const out_dir = document.getElementById('watcherOutDir')?.value?.trim() || '';
    const resize_mode = document.getElementById('watcherResizeMode')?.value || 'letterbox';
    state.watcher.in_dir = in_dir;
    state.watcher.out_dir = out_dir;
    state.watcher.resize_mode = resize_mode;
    return postWatcherConfig({
      enabled: document.getElementById('watcherEnabled')?.value === '1',
      in_dir,
      out_dir,
      resize_mode,
    });
  };

  document.getElementById('watcherEnabled')?.addEventListener('change', async () => {
    const on = document.getElementById('watcherEnabled')?.value === '1';
    state.watcher.enabled = on;
    if (isApplyingFormState()) return;
    const data = await applyPaths();
    if (data && data.ok === false) {
      alert(data.error || data.last_error || 'Could not enable watcher');
      state.watcher.enabled = false;
      const hid = document.getElementById('watcherEnabled');
      if (hid) hid.value = '0';
      // snap knob back to Off without firing change again
      const knob = document.getElementById('watcherEnabledKnob');
      const ind = document.getElementById('watcherEnabledKnobInd');
      if (knob && ind) {
        ind.style.transform = 'translate(-50%, -100%) rotate(-110deg)';
        knob.classList.remove('is-right');
        knob.parentElement?.querySelector('.cap-left')?.classList.add('cap-on');
        knob.parentElement?.querySelector('.cap-right')?.classList.remove('cap-on');
      }
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
  const enabled = !!st.enabled;
  const running = !!st.running;
  const pill = document.getElementById('watcherStatusPill');
  const text = document.getElementById('watcherStatusText');
  if (pill && text) {
    pill.classList.remove('status-ok', 'status-warn', 'status-off');
    const cls = enabled ? (running ? 'ok' : 'warn') : 'off';
    pill.classList.add(`status-${cls}`);
    text.textContent = enabled ? (running ? 'Watching' : 'Starting…') : 'Off';
  }
  const proc = document.getElementById('watcherProcessed');
  const fail = document.getElementById('watcherFailed');
  if (proc) proc.textContent = String(st.processed_count ?? 0);
  if (fail) fail.textContent = String(st.failed_count ?? 0);
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
