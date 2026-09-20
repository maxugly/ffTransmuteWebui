import re

with open('mtapi-project/app/static/js/tabs/settings.js', 'r') as f:
    js = f.read()

# Add to the HTML template in settings.js
ui_injection = """
      <section class="settings-card settings-knobs" aria-labelledby="settingsKnobTitle">
        <div class="settings-card-head">
          <span class="settings-card-kicker">Controls</span>
          <h4 class="settings-card-name" id="settingsKnobTitle">Knob Sensitivity</h4>
        </div>
        <div class="form-row">
          <label>Curve (Bot)</label>
          <select id="settingsKnobBotCurve">
            <option value="lin" ${state.settings.knobBotCurve === 'lin' ? 'selected' : ''}>Linear</option>
            <option value="log2" ${state.settings.knobBotCurve === 'log2' ? 'selected' : ''}>Log2</option>
            <option value="log10" ${state.settings.knobBotCurve === 'log10' ? 'selected' : ''}>Log10</option>
          </select>
        </div>
        <div class="form-row">
          <label>Mid Setpt</label>
          <input type="number" id="settingsKnobMidSet" value="${state.settings.knobMidSet || 100}" min="1" max="500">
        </div>
        <div class="form-row">
          <label>Curve (Top)</label>
          <select id="settingsKnobTopCurve">
            <option value="lin" ${state.settings.knobTopCurve === 'lin' ? 'selected' : ''}>Linear</option>
            <option value="log2" ${state.settings.knobTopCurve === 'log2' ? 'selected' : ''}>Log2</option>
            <option value="log10" ${state.settings.knobTopCurve === 'log10' ? 'selected' : ''}>Log10</option>
          </select>
        </div>
        <div class="form-row">
          <label>Ceiling %</label>
          <input type="number" id="settingsKnobMax" value="${state.settings.knobMax || 125}" min="101" max="999">
        </div>
        <p class="settings-card-desc">Fine-tune the mathematical acceleration when you drag knobs horizontally.</p>
      </section>

      <section class="settings-card settings-system" aria-labelledby="settingsSystemTitle">
        <div class="settings-card-head">
          <span class="settings-card-kicker">System</span>
          <h4 class="settings-card-name" id="settingsSystemTitle">Session & Data</h4>
        </div>
        <div class="settings-system-row">
          ${switchHtml('settingsRestoreSession', 'Restore previous session inputs on load', state.settings.restoreSession !== false)}
        </div>
        <div class="form-row" style="margin-top:12px;">
          <button type="button" class="btn" style="background:#800;color:#fff;font-weight:bold;width:100%;border:2px solid #f00" id="btnDukeNukem">☢️ DEFAULT ERRRTHANG ☢️</button>
        </div>
        <p class="settings-card-desc">Nukes all localStorage settings and session memory. Use with caution.</p>
      </section>
"""

# Insert before UI Tweaks section
js = js.replace("""      <section class="settings-card settings-ui" aria-labelledby="settingsUiTitle">""", ui_injection + "\n      <section class=\"settings-card settings-ui\" aria-labelledby=\"settingsUiTitle\">")

# Add event listeners for the new elements
listeners = """
  document.getElementById('settingsKnobBotCurve')?.addEventListener('change', e => saveSettings({ knobBotCurve: e.target.value }));
  document.getElementById('settingsKnobMidSet')?.addEventListener('change', e => saveSettings({ knobMidSet: parseInt(e.target.value, 10) || 100 }));
  document.getElementById('settingsKnobTopCurve')?.addEventListener('change', e => saveSettings({ knobTopCurve: e.target.value }));
  document.getElementById('settingsKnobMax')?.addEventListener('change', e => saveSettings({ knobMax: parseInt(e.target.value, 10) || 125 }));
  bindSwitch('settingsRestoreSession', 'restoreSession');
  
  document.getElementById('btnDukeNukem')?.addEventListener('click', () => {
    if (confirm('Are you absolutely sure you want to nuke all UI settings and session memory? This will clear everything.')) {
      localStorage.clear();
      window.location.reload();
    }
  });
"""

# Insert into event listener section (after elements.actionPanel.dataset.settingsReady = '1';)
js = js.replace("elements.actionPanel.dataset.settingsReady = '1';", "elements.actionPanel.dataset.settingsReady = '1';\n" + listeners)

with open('mtapi-project/app/static/js/tabs/settings.js', 'w') as f:
    f.write(js)
