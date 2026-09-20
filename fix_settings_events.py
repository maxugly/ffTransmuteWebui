import re

with open('mtapi-project/app/static/js/tabs/settings.js', 'r') as f:
    js = f.read()

# Add the event listeners back, because `setupContinuousKnob` doesn't natively fire `opts.onChange`
# We'll inject them before `bindSwitch('settingsRestoreSession', 'restoreSession');`

listeners = """
  document.getElementById('settingsKnobBotCurve')?.addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    saveSettings({ knobBotCurve: ['lin', 'log2', 'log10'][v] || 'log10' });
  });
  document.getElementById('settingsKnobMidSet')?.addEventListener('change', e => saveSettings({ knobMidSet: parseInt(e.target.value, 10) || 100 }));
  document.getElementById('settingsKnobTopCurve')?.addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    saveSettings({ knobTopCurve: ['lin', 'log2', 'log10'][v] || 'lin' });
  });
  document.getElementById('settingsKnobMax')?.addEventListener('change', e => saveSettings({ knobMax: parseInt(e.target.value, 10) || 125 }));
"""

js = js.replace("  bindSwitch('settingsRestoreSession', 'restoreSession');", listeners + "  bindSwitch('settingsRestoreSession', 'restoreSession');")

with open('mtapi-project/app/static/js/tabs/settings.js', 'w') as f:
    f.write(js)
