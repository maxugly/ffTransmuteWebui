/**
 * Settings tab — bare workspace (sidebar nav only; no global inputs / preview / Run).
 * Blank scaffold for performance prefs and other app settings.
 */
import { elements } from '/app.js';

export function renderSettingsForm() {
  elements.actionPanel.innerHTML = `
    <div class="settings-workspace" id="settingsWorkspace">
      <div class="settings-hero">
        <div class="settings-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </div>
        <h3 class="settings-title">Settings</h3>
        <p class="settings-lede">
          App preferences will live here — pool performance, Instant RIFE defaults,
          preview behavior, and more. Nothing wired yet; this tab is a blank home.
        </p>
      </div>
      <div class="settings-grid" aria-hidden="true">
        <div class="settings-card settings-card-placeholder">
          <div class="settings-card-kicker">Coming soon</div>
          <div class="settings-card-name">Performance</div>
          <p class="settings-card-desc">Pool thumbs, probe concurrency, virtualization.</p>
        </div>
        <div class="settings-card settings-card-placeholder">
          <div class="settings-card-kicker">Coming soon</div>
          <div class="settings-card-name">Sequence</div>
          <p class="settings-card-desc">Instant RIFE defaults and densify limits.</p>
        </div>
        <div class="settings-card settings-card-placeholder">
          <div class="settings-card-kicker">Coming soon</div>
          <div class="settings-card-name">Interface</div>
          <p class="settings-card-desc">Chrome density, auto-save, console noise.</p>
        </div>
      </div>
    </div>
  `;
  (elements.actionPanelRoot || elements.actionPanel).classList.add('settings-active');
}
