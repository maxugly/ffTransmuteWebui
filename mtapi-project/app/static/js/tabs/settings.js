/** Settings: local preferences with a small server mirror for media routes. */
import { state, elements } from '/app.js';
import { setupContinuousKnob } from '/js/ui/knobs.js';

const SIZE_LABELS = ['L', 'M', 'H'];
const SCROLLBAR_MIN = 6;
const SCROLLBAR_MAX = 30;
const SCROLLBAR_STEP = 2;

const SCROLLBAR_LS_KEY = 'mtapi.scrollbarWidth';

function clampScrollbarWidth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return SCROLLBAR_MIN;
  const snapped = Math.round(n / SCROLLBAR_STEP) * SCROLLBAR_STEP;
  return Math.max(SCROLLBAR_MIN, Math.min(SCROLLBAR_MAX, snapped));
}

function readStoredScrollbarWidth() {
  try {
    const direct = Number(localStorage.getItem(SCROLLBAR_LS_KEY));
    if (Number.isFinite(direct) && direct > 0) return clampScrollbarWidth(direct);
  } catch (_) { /* ignore */ }
  try {
    const raw = JSON.parse(localStorage.getItem('mtapi.settings') || 'null');
    if (raw && raw.scrollbarWidth != null) return clampScrollbarWidth(raw.scrollbarWidth);
  } catch (_) { /* ignore */ }
  return SCROLLBAR_MIN;
}

function persistScrollbarWidth(px) {
  const w = clampScrollbarWidth(px);
  try { localStorage.setItem(SCROLLBAR_LS_KEY, String(w)); } catch (_) { /* ignore */ }
  return w;
}

function applyUiTweaks(width) {
  const px = clampScrollbarWidth(width != null ? width : (state.settings?.scrollbarWidth ?? readStoredScrollbarWidth()));
  if (state.settings) state.settings.scrollbarWidth = px;
  persistScrollbarWidth(px);
  const root = document.documentElement;
  root.style.setProperty('--scrollbar-width', `${px}px`);
  root.dataset.scrollbar = px > SCROLLBAR_MIN ? 'thick' : 'thin';
  // Chromium does not recompute ::-webkit-scrollbar width from a CSS variable.
  // Rewrite a real stylesheet so the bar actually changes.
  let tag = document.getElementById('mtapi-scrollbar-style');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'mtapi-scrollbar-style';
    document.head.appendChild(tag);
  }
  tag.textContent = `::-webkit-scrollbar{width:${px}px !important;height:${px}px !important;}`;
}

function settingsSnapshot() {
  return {
    ...state.settings,
    thumbnailSize: SIZE_LABELS[Math.max(0, Math.min(2, Number(state.settings.thumbnailSizeIndex ?? 2)))],
    thumbnailsToRam: !!state.settings.thumbnailsToRam,
    phashToRam: !!state.settings.phashToRam,
    wallStyle: state.settings.wallStyle === 'first' ? 'first' : 'pair',
    scrollbarWidth: clampScrollbarWidth(state.settings.scrollbarWidth),
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
  if (patch.scrollbarWidth != null) applyUiTweaks(payload.scrollbarWidth);
  try {
    await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thumbnail_size: payload.thumbnailSize,
        thumbnails_to_ram: payload.thumbnailsToRam,
        phash_to_ram: payload.phashToRam,
        autosave_interval: payload.autosaveInterval,
        scrollbar_width: payload.scrollbarWidth,
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
  if (
    payload.thumbnailSize !== prevSize
    || patch.thumbnailSize
    || patch.thumbnailSizeIndex != null
    || patch.wallStyle
  ) {
    window.dispatchEvent(new CustomEvent('mtapi.settingsChanged', {
      detail: { thumbnailSize: payload.thumbnailSize, wallStyle: payload.wallStyle },
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
      <p class="settings-lede">Performance controls are stored locally and mirrored to the media server.</p>
      <section class="settings-card settings-performance" aria-labelledby="settingsPerformanceTitle">
        <div class="settings-card-head">
          <span class="settings-card-kicker">Performance</span>
          <h4 class="settings-card-name" id="settingsPerformanceTitle">Pool &amp; cache</h4>
        </div>
        <div class="settings-knob-row">
          <div class="settings-discrete-knob">
            <span class="knob-unit-label">Thumbnail size</span>
            <div class="daw-knob" id="settingsThumbKnob">
              <div class="daw-knob-dial"></div><div class="daw-knob-indicator" id="settingsThumbKnobInd"></div>
            </div>
            <input class="daw-knob-value-input" id="settingsThumbValue" value="${SIZE_LABELS[sizeIndex]}" readonly>
            <input type="hidden" id="settingsThumbIndex" value="${sizeIndex}">
          </div>
          <div class="settings-autosave-knob">
            <span class="knob-unit-label">Autosave</span>
            <div class="daw-knob" id="settingsAutosaveKnob">
              <div class="daw-knob-dial"></div><div class="daw-knob-indicator" id="settingsAutosaveKnobInd"></div>
            </div>
            <input class="daw-knob-value-input" id="settingsAutosaveValue" value="30s" readonly>
            <input type="hidden" id="settingsAutosaveIndex" value="${[5,30,60].indexOf(Number(state.settings.autosaveInterval)) >= 0 ? [5,30,60].indexOf(Number(state.settings.autosaveInterval)) : 1}">
          </div>
          <div class="settings-switches">
            ${switchHtml('settingsThumbRam', 'Keep thumbnails in RAM', state.settings.thumbnailsToRam)}
            ${switchHtml('settingsPhashRam', 'Keep hashes in RAM', state.settings.phashToRam)}
            ${switchHtml('settingsWallPair', 'First + last wall', state.settings.wallStyle !== 'first')}
          </div>
        </div>
        <p class="settings-card-desc">Wall default is one JPEG: first|last side by side at 120px each.<br>Off shows the single first-frame preview. L/M/H is match-size only.</p>
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
      <section class="settings-card settings-ui" aria-labelledby="settingsUiTitle">
        <div class="settings-card-head">
          <span class="settings-card-kicker">Display</span>
          <h4 class="settings-card-name" id="settingsUiTitle">UI tweaks</h4>
        </div>
        <div class="settings-knob-row">
          <div class="settings-discrete-knob">
            <span class="knob-unit-label">Scrollbar</span>
            <div class="daw-knob" id="settingsScrollbarKnob">
              <div class="daw-knob-dial"></div><div class="daw-knob-indicator" id="settingsScrollbarKnobInd"></div>
            </div>
            <input class="daw-knob-value-input" id="settingsScrollbarValue" value="${clampScrollbarWidth(state.settings.scrollbarWidth)}px" readonly>
            <input type="hidden" id="settingsScrollbarWidth" value="${clampScrollbarWidth(state.settings.scrollbarWidth)}">
          </div>
        </div>
        <p class="settings-card-desc">Width of every scroll bar. ${SCROLLBAR_MIN}px is the current default<br>and the minimum. ${SCROLLBAR_MAX}px is as thick as this goes.</p>
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
  setupContinuousKnob({
    knobId: 'settingsScrollbarKnob', indicatorId: 'settingsScrollbarKnobInd',
    valueId: 'settingsScrollbarValue', hiddenId: 'settingsScrollbarWidth',
    min: SCROLLBAR_MIN, max: SCROLLBAR_MAX, step: SCROLLBAR_STEP, decimals: 0,
    format: (v) => `${clampScrollbarWidth(v)}px`,
    onChange: (v) => {
      const px = clampScrollbarWidth(v);
      applyUiTweaks(px);
      if (elements.actionPanel?.dataset.settingsReady === '1') {
        saveSettings({ scrollbarWidth: px });
      }
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
  document.getElementById('settingsWallPair')?.addEventListener('change', (e) => {
    saveSettings({ wallStyle: e.target.checked ? 'pair' : 'first' });
  });
  document.getElementById('settingsWarmDeepdream')?.addEventListener('change', e => saveSettings({ warmModels: { deepdream: e.target.checked } }));
  document.getElementById('settingsWarmStyle')?.addEventListener('change', e => saveSettings({ warmModels: { styletransfer: e.target.checked } }));
  document.getElementById('settingsWarmFastsam')?.addEventListener('change', e => saveSettings({ warmModels: { fastsam: e.target.checked } }));
}

export { saveSettings, applyUiTweaks, clampScrollbarWidth, readStoredScrollbarWidth };
