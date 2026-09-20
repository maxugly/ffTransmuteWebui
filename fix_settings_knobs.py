import re

with open('mtapi-project/app/static/js/tabs/settings.js', 'r') as f:
    js = f.read()

# Replace HTML
old_html = """        <div class="form-row">
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
        </div>"""

new_html = """        <div class="settings-knob-row">
          <div class="settings-discrete-knob">
            <span class="knob-unit-label">Curve (Bot)</span>
            <div class="daw-knob" id="settingsBotCurveKnob">
              <div class="daw-knob-dial"></div><div class="daw-knob-indicator" id="settingsBotCurveKnobInd"></div>
            </div>
            <input class="daw-knob-value-input" id="settingsBotCurveValue" value="${state.settings.knobBotCurve || 'log10'}" readonly>
            <input type="hidden" id="settingsKnobBotCurve" value="${['lin','log2','log10'].indexOf(state.settings.knobBotCurve || 'log10')}">
          </div>
          <div class="settings-discrete-knob">
            <span class="knob-unit-label">Mid Setpt</span>
            <div class="daw-knob" id="settingsMidSetKnob">
              <div class="daw-knob-dial"></div><div class="daw-knob-indicator" id="settingsMidSetKnobInd"></div>
            </div>
            <input class="daw-knob-value-input" id="settingsMidSetValue" value="${state.settings.knobMidSet || 100}%" readonly>
            <input type="hidden" id="settingsKnobMidSet" value="${state.settings.knobMidSet || 100}">
          </div>
          <div class="settings-discrete-knob">
            <span class="knob-unit-label">Curve (Top)</span>
            <div class="daw-knob" id="settingsTopCurveKnob">
              <div class="daw-knob-dial"></div><div class="daw-knob-indicator" id="settingsTopCurveKnobInd"></div>
            </div>
            <input class="daw-knob-value-input" id="settingsTopCurveValue" value="${state.settings.knobTopCurve || 'lin'}" readonly>
            <input type="hidden" id="settingsKnobTopCurve" value="${['lin','log2','log10'].indexOf(state.settings.knobTopCurve || 'lin')}">
          </div>
          <div class="settings-discrete-knob">
            <span class="knob-unit-label">Ceiling %</span>
            <div class="daw-knob" id="settingsMaxKnob">
              <div class="daw-knob-dial"></div><div class="daw-knob-indicator" id="settingsMaxKnobInd"></div>
            </div>
            <input class="daw-knob-value-input" id="settingsMaxValue" value="${state.settings.knobMax || 125}%" readonly>
            <input type="hidden" id="settingsKnobMax" value="${state.settings.knobMax || 125}">
          </div>
        </div>"""

js = js.replace(old_html, new_html)

# Now we need to remove the old event listeners and inject the `setupContinuousKnob` configurations
old_listeners = """  document.getElementById('settingsKnobBotCurve')?.addEventListener('change', e => saveSettings({ knobBotCurve: e.target.value }));
  document.getElementById('settingsKnobMidSet')?.addEventListener('change', e => saveSettings({ knobMidSet: parseInt(e.target.value, 10) || 100 }));
  document.getElementById('settingsKnobTopCurve')?.addEventListener('change', e => saveSettings({ knobTopCurve: e.target.value }));
  document.getElementById('settingsKnobMax')?.addEventListener('change', e => saveSettings({ knobMax: parseInt(e.target.value, 10) || 125 }));"""

new_knobs = """  const CURVES = ['lin', 'log2', 'log10'];
  setupContinuousKnob({
    knobId: 'settingsBotCurveKnob', indicatorId: 'settingsBotCurveKnobInd',
    valueId: 'settingsBotCurveValue', hiddenId: 'settingsKnobBotCurve',
    min: 0, max: 2, step: 1, decimals: 0, format: v => CURVES[Math.round(v)],
    onChange: (v) => {
      if (elements.actionPanel?.dataset.settingsReady === '1') saveSettings({ knobBotCurve: CURVES[Math.round(v)] });
    }
  });
  setupContinuousKnob({
    knobId: 'settingsMidSetKnob', indicatorId: 'settingsMidSetKnobInd',
    valueId: 'settingsMidSetValue', hiddenId: 'settingsKnobMidSet',
    min: 1, max: 500, step: 1, decimals: 0, format: v => `${v}%`,
    onChange: (v) => {
      if (elements.actionPanel?.dataset.settingsReady === '1') saveSettings({ knobMidSet: v });
    }
  });
  setupContinuousKnob({
    knobId: 'settingsTopCurveKnob', indicatorId: 'settingsTopCurveKnobInd',
    valueId: 'settingsTopCurveValue', hiddenId: 'settingsKnobTopCurve',
    min: 0, max: 2, step: 1, decimals: 0, format: v => CURVES[Math.round(v)],
    onChange: (v) => {
      if (elements.actionPanel?.dataset.settingsReady === '1') saveSettings({ knobTopCurve: CURVES[Math.round(v)] });
    }
  });
  setupContinuousKnob({
    knobId: 'settingsMaxKnob', indicatorId: 'settingsMaxKnobInd',
    valueId: 'settingsMaxValue', hiddenId: 'settingsKnobMax',
    min: 101, max: 999, step: 1, decimals: 0, format: v => `${v}%`,
    onChange: (v) => {
      if (elements.actionPanel?.dataset.settingsReady === '1') saveSettings({ knobMax: v });
    }
  });"""

js = js.replace(old_listeners, new_knobs)

with open('mtapi-project/app/static/js/tabs/settings.js', 'w') as f:
    f.write(js)
