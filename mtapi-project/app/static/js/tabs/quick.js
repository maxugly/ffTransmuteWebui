import { state, elements, logConsole, switchTab, checkHealth, addPathsToPool, renderPoolGrid } from '/app.js';
import { escapeHtml } from '/js/utils.js';
import { displayOpResult } from '/js/job-control.js';
import { refreshPoolToolbarCounts } from '/js/pool/persistence.js';

// ── Quick Transmute settings tab ──────────────────────────────────────────

const QUICK_LS_KEY = 'fftransmute.quick';

function loadQuickSettings() {
  try {
    const raw = localStorage.getItem(QUICK_LS_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      if (['pad', 'crop', 'stretch'].includes(o.reconcile)) state.quick.reconcile = o.reconcile;
      if (typeof o.aspect === 'string' && o.aspect) state.quick.aspect = o.aspect;
      if (typeof o.aspectCustom === 'string') state.quick.aspectCustom = o.aspectCustom;
    }
  } catch (_) { /* ignore */ }
}

function saveQuickSettings() {
  try {
    localStorage.setItem(QUICK_LS_KEY, JSON.stringify({
      reconcile: state.quick.reconcile || 'pad',
      aspect: state.quick.aspect || 'auto',
      aspectCustom: state.quick.aspectCustom || '',
    }));
  } catch (_) { /* ignore */ }
}

function resolveQuickAspect() {
  let aspect = state.quick.aspect || 'auto';
  if (aspect === 'custom') {
    aspect = (state.quick.aspectCustom || '').trim();
    if (!aspect || !/^(\d+:\d+|\d+x\d+)$/i.test(aspect)) {
      return { ok: false, error: 'Custom AR needs W:H (e.g. 5:4) or WxH (e.g. 1080x1920).' };
    }
  }
  return { ok: true, aspect, mode: state.quick.reconcile || 'pad' };
}

function quickTransmuteLabel() {
  const r = resolveQuickAspect();
  if (!r.ok) return 'Quick Transmute (configure…)';
  const mode = r.mode;
  const ar = r.aspect || 'auto';
  return `Quick Transmute (${mode} · ${ar})`;
}

function renderQuickTransmuteForm() {
  const rec = state.quick.reconcile || 'pad';
  const aspect = state.quick.aspect || 'auto';
  const custom = state.quick.aspectCustom || '';
  const html = `
    <div class="panel-title-desc">
      <h3>Quick Transmute defaults</h3>
      <p>
        Same Fit / AR as sequence stitch. Configure once here, then
        <strong>right-click</strong> any Media Pool clip → <em>Quick Transmute</em>.
        One click: auto-names next to the source, no dialogs.
      </p>
    </div>

    <div class="form-group">
      <label>Fit mode</label>
      <select id="quickReconcile">
        <option value="pad" ${rec === 'pad' ? 'selected' : ''}>Pad (scale up, letterbox if AR differs)</option>
        <option value="crop" ${rec === 'crop' ? 'selected' : ''}>Crop (scale up, center-crop if AR differs)</option>
        <option value="stretch" ${rec === 'stretch' ? 'selected' : ''}>Stretch (warp AR)</option>
      </select>
    </div>

    <div class="form-group">
      <label>Target aspect ratio</label>
      <div class="input-row" style="gap:8px; flex-wrap:wrap;">
        <select id="quickAspect" style="flex:1; min-width:140px;">
          <option value="auto" ${aspect === 'auto' ? 'selected' : ''}>Auto (source AR)</option>
          <option value="1:1" ${aspect === '1:1' ? 'selected' : ''}>1:1</option>
          <option value="16:9" ${aspect === '16:9' ? 'selected' : ''}>16:9</option>
          <option value="9:16" ${aspect === '9:16' ? 'selected' : ''}>9:16</option>
          <option value="3:2" ${aspect === '3:2' ? 'selected' : ''}>3:2</option>
          <option value="2:3" ${aspect === '2:3' ? 'selected' : ''}>2:3</option>
          <option value="4:3" ${aspect === '4:3' ? 'selected' : ''}>4:3</option>
          <option value="3:4" ${aspect === '3:4' ? 'selected' : ''}>3:4</option>
          <option value="custom" ${aspect === 'custom' ? 'selected' : ''}>Custom…</option>
        </select>
        <input type="text" id="quickAspectCustom" class="pool-aspect-custom"
          placeholder="W:H or WxH" title="Custom aspect e.g. 5:4 or 1080x1920"
          value="${escapeHtml(custom)}"
          style="display:${aspect === 'custom' ? 'inline-block' : 'none'}; width: 140px;">
      </div>
    </div>

    <div class="form-group quick-summary" id="quickSummary">
      <label>Active preset</label>
      <div class="quick-summary-box">
        <code id="quickSummaryText">${escapeHtml(quickTransmuteLabel())}</code>
        <p class="quick-summary-hint">
          Right-click a pool card or use <strong>Send to → Quick Transmute</strong>.
          Output lands beside the source as
          <code>name_&lt;fit&gt;_&lt;ar&gt;_&lt;WxH&gt;.mp4</code>.
        </p>
      </div>
    </div>

    <div class="form-group" style="display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" class="btn" id="btnQuickCopySeq">Copy from sequence settings</button>
      <button type="button" class="btn" id="btnQuickToPool">Open Media Pool</button>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  const syncSummary = () => {
    const el = document.getElementById('quickSummaryText');
    if (el) el.textContent = quickTransmuteLabel();
  };

  document.getElementById('quickReconcile')?.addEventListener('change', (e) => {
    state.quick.reconcile = e.target.value;
    saveQuickSettings();
    syncSummary();
  });
  document.getElementById('quickAspect')?.addEventListener('change', (e) => {
    state.quick.aspect = e.target.value;
    const customEl = document.getElementById('quickAspectCustom');
    if (customEl) customEl.style.display = state.quick.aspect === 'custom' ? 'inline-block' : 'none';
    saveQuickSettings();
    syncSummary();
  });
  document.getElementById('quickAspectCustom')?.addEventListener('input', (e) => {
    state.quick.aspectCustom = e.target.value.trim();
    saveQuickSettings();
    syncSummary();
  });
  document.getElementById('btnQuickCopySeq')?.addEventListener('click', () => {
    state.quick.reconcile = state.pool.reconcile || 'pad';
    state.quick.aspect = state.pool.aspect || 'auto';
    state.quick.aspectCustom = state.pool.aspectCustom || '';
    saveQuickSettings();
    renderQuickTransmuteForm();
    logConsole(`[QUICK]: Copied sequence settings → ${quickTransmuteLabel()}`);
  });
  document.getElementById('btnQuickToPool')?.addEventListener('click', () => switchTab('pool'));
}

/**
 * One-click fit using Quick Transmute settings. No dialogs; auto-named output.
 */
async function runQuickTransmute(path) {
  if (!path) return;
  const cfg = resolveQuickAspect();
  if (!cfg.ok) {
    alert(cfg.error + '\nOpen the Quick Transmute tab to fix AR.');
    switchTab('quick');
    return;
  }

  const body = {
    input_path: path,
    mode: cfg.mode,
    aspect: cfg.aspect,
    output_path: null,
    dry_run: false,
  };

  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Quick Transmute…';
  logConsole(`[QUICK]: POST /ops/fit\n${JSON.stringify(body, null, 2)}`);

  try {
    const response = await fetch('/ops/fit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    displayOpResult(data);
    if (data.ok && data.output_path) {
      addPathsToPool([data.output_path]);
      if (state.activeTab === 'pool') {
        renderPoolGrid();
        refreshPoolToolbarCounts();
      }
      logConsole(`[QUICK]: Done → ${data.output_path}`);
      elements.statusText.textContent = 'Quick Transmute done';
    } else if (!data.ok) {
      throw new Error(data.error || 'fit failed');
    }
  } catch (err) {
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Quick Transmute failed';
    logConsole(`[QUICK FAILED]: ${err.message}`, 'error');
    alert(`Quick Transmute failed: ${err.message}`);
  } finally {
    await checkHealth();
  }
}

export {
  QUICK_LS_KEY, loadQuickSettings, saveQuickSettings,
  resolveQuickAspect, quickTransmuteLabel,
  renderQuickTransmuteForm, runQuickTransmute,
};
