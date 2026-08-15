/** Settings: local preferences with a small server mirror for media routes. */
import { state, elements } from '/app.js';
import { setupContinuousKnob } from '/js/ui/knobs.js';

const SIZE_LABELS = ['L', 'M', 'H'];

function settingsSnapshot() {
  return {
    ...state.settings,
    thumbnailSize: SIZE_LABELS[Math.max(0, Math.min(2, Number(state.settings.thumbnailSizeIndex ?? 2)))],
    thumbnailsToRam: !!state.settings.thumbnailsToRam,
    phashToRam: !!state.settings.phashToRam,
    warmModels: { ...(state.settings.warmModels || {}) },
  };
}

async function saveSettings(patch = {}) {
  const prevSize = state.settings.thumbnailSize;
  state.settings = {
    ...state.settings,
    ...patch,
    warmModels: { ...(state.settings.warmModels || {}), ...(patch.warmModels || {}) },
  };
  const payload = settingsSnapshot();
  try { localStorage.setItem('mtapi.settings', JSON.stringify(state.settings)); } catch (_) {}
  try {
    await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thumbnail_size: payload.thumbnailSize,
        thumbnails_to_ram: payload.thumbnailsToRam,
        phash_to_ram: payload.phashToRam,
        autosave_interval: payload.autosaveInterval,
        warm_models: payload.warmModels,
      }),
    });
  } catch (_) { /* localStorage remains authoritative for the browser */ }
  // No import of persistence.js — avoid a cycle. Prefer the global callback.
  if (typeof window.scheduleSavePoolState === 'function') {
    window.scheduleSavePoolState();
  } else {
    window.dispatchEvent(new CustomEvent('mtapi.saveSettings'));
  }
  if (payload.thumbnailSize !== prevSize || patch.thumbnailSize || patch.thumbnailSizeIndex != null) {
    window.dispatchEvent(new CustomEvent('mtapi.settingsChanged', {
      detail: { thumbnailSize: payload.thumbnailSize },
    }));
  }
}

function switchHtml(id, label, checked) {
  return `<label class="settings-switch-row" for="${id}">
    <span><strong>${label}</strong></span>
    <input type="checkbox" id="${id}" role="switch" ${checked ? 'checked' : ''}>
    <span class="settings-switch" aria-hidden="true"></span>
  </label>`;
}

export function renderSettingsForm() {
  const sizeIndex = state.settings.thumbnailSizeIndex ??
    ({ L: 0, M: 1, H: 2 }[state.settings.thumbnailSize] ?? 2);
  state.settings.thumbnailSizeIndex = sizeIndex;
  const warm = state.settings.warmModels || {};
  elements.actionPanel.innerHTML = `
    <div class="settings-workspace" id="settingsWorkspace">
      <div class="settings-hero">
        <div class="settings-icon" aria-hidden="true">⚙</div>
        <h3 class="settings-title">Settings</h3>
        <p class="settings-lede">Performance controls are stored locally and mirrored to the media server. Drag knobs vertically or use the mouse wheel.</p>
      </div>
      <section class="settings-card settings-performance" aria-labelledby="settingsPerformanceTitle">
        <div class="settings-card-head">
          <span class="settings-card-kicker">Performance</span>
          <h4 class="settings-card-name" id="settingsPerformanceTitle">Pool &amp; cache</h4>
        </div>
        <div class="settings-knob-row">
          <div class="settings-discrete-knob">
            <span class="knob-unit-label">Thumbnail size</span>
            <div class="daw-knob" id="settingsThumbKnob" title="Drag up/down · scroll wheel">
              <div class="daw-knob-dial"></div><div class="daw-knob-indicator" id="settingsThumbKnobInd"></div>
            </div>
            <input class="daw-knob-value-input" id="settingsThumbValue" value="${SIZE_LABELS[sizeIndex]}" readonly>
            <input type="hidden" id="settingsThumbIndex" value="${sizeIndex}">
          </div>
          <div class="settings-autosave-knob">
            <span class="knob-unit-label">Autosave</span>
            <div class="daw-knob" id="settingsAutosaveKnob" title="Drag up/down · scroll wheel">
              <div class="daw-knob-dial"></div><div class="daw-knob-indicator" id="settingsAutosaveKnobInd"></div>
            </div>
            <input class="daw-knob-value-input" id="settingsAutosaveValue" value="30s" readonly>
            <input type="hidden" id="settingsAutosaveIndex" value="${[5,30,60].indexOf(Number(state.settings.autosaveInterval)) >= 0 ? [5,30,60].indexOf(Number(state.settings.autosaveInterval)) : 1}">
          </div>
          <div class="settings-switches">
            ${switchHtml('settingsThumbRam', 'Keep thumbnails in RAM', state.settings.thumbnailsToRam)}
            ${switchHtml('settingsPhashRam', 'Keep hashes in RAM', state.settings.phashToRam)}
          </div>
        </div>
        <p class="settings-card-desc">L = 120px, M = 240px, H = 480px. RAM caches are byte-bounded<br>and can be cleared by restarting the server.</p>
      </section>
      <section class="settings-card settings-warm" aria-labelledby="settingsWarmTitle">
        <div class="settings-card-head">
          <span class="settings-card-kicker">Neural FX</span>
          <h4 class="settings-card-name" id="settingsWarmTitle">Keep models warm</h4>
        </div>
        <div class="settings-warm-row">
          ${switchHtml('settingsWarmDeepdream', 'DeepDream', warm.deepdream)}
          ${switchHtml('settingsWarmStyle', 'Style Transfer', warm.styletransfer)}
          ${switchHtml('settingsWarmFastsam', 'FastSAM', warm.fastsam)}
        </div>
        <p class="settings-card-desc">Keeps the selected worker/model warm when supported. Default is off<br>to avoid VRAM pressure.</p>
      </section>
    </div>`;

  setupContinuousKnob({
    knobId: 'settingsThumbKnob', indicatorId: 'settingsThumbKnobInd',
    valueId: 'settingsThumbValue', hiddenId: 'settingsThumbIndex',
    min: 0, max: 2, step: 1, decimals: 0, format: v => SIZE_LABELS[Math.round(v)],
    onChange: (v) => {
      state.settings.thumbnailSizeIndex = Math.round(v);
      state.settings.thumbnailSize = SIZE_LABELS[state.settings.thumbnailSizeIndex] || 'H';
      if (elements.actionPanel?.dataset.settingsReady === '1') saveSettings({ thumbnailSize: state.settings.thumbnailSize, thumbnailSizeIndex: state.settings.thumbnailSizeIndex });
    },
  });
  setupContinuousKnob({
    knobId: 'settingsAutosaveKnob', indicatorId: 'settingsAutosaveKnobInd',
    valueId: 'settingsAutosaveValue', hiddenId: 'settingsAutosaveIndex',
    min: 0, max: 2, step: 1, decimals: 0,
    format: v => `${[5, 30, 60][Math.round(v)]}s`,
    onChange: (v) => {
      if (elements.actionPanel?.dataset.settingsReady === '1') saveSettings({ autosaveInterval: [5, 30, 60][Math.round(v)] || 30 });
    },
  });
  elements.actionPanel.dataset.settingsReady = '1';

  document.getElementById('settingsThumbIndex')?.addEventListener('change', (e) => {
    state.settings.thumbnailSizeIndex = Number(e.target.value);
    state.settings.thumbnailSize = SIZE_LABELS[state.settings.thumbnailSizeIndex] || 'H';
    saveSettings({ thumbnailSize: state.settings.thumbnailSize, thumbnailSizeIndex: state.settings.thumbnailSizeIndex });
  });
  document.getElementById('settingsAutosaveIndex')?.addEventListener('change', (e) => {
    saveSettings({ autosaveInterval: [5, 30, 60][Number(e.target.value)] || 30 });
  });
  const bindSwitch = (id, patch) => document.getElementById(id)?.addEventListener('change', (e) => saveSettings({ [patch]: e.target.checked }));
  bindSwitch('settingsThumbRam', 'thumbnailsToRam');
  bindSwitch('settingsPhashRam', 'phashToRam');
  document.getElementById('settingsWarmDeepdream')?.addEventListener('change', e => saveSettings({ warmModels: { deepdream: e.target.checked } }));
  document.getElementById('settingsWarmStyle')?.addEventListener('change', e => saveSettings({ warmModels: { styletransfer: e.target.checked } }));
  document.getElementById('settingsWarmFastsam')?.addEventListener('change', e => saveSettings({ warmModels: { fastsam: e.target.checked } }));
}

export { saveSettings };
