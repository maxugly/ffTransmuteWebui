import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# Add to setupContinuousKnob
old_cont_attach = """  const target = brick || knob;
  target.addEventListener('mousedown', onMouseDown);"""
new_cont_attach = """  const target = brick || knob;
  target.addEventListener('mousedown', onMouseDown);
  const resetBtn = brick?.querySelector('.knob-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const def = parseFloat(hiddenInput.getAttribute('data-default'));
      if (!isNaN(def)) {
        exactVal = def;
        updateUI(def);
      }
    });
  }"""
js = js.replace(old_cont_attach, new_cont_attach)

# Add to setupBinaryKnob
old_bin_attach = """  const target = brick || knob;
  target.addEventListener('mousedown', onMouseDown);"""
new_bin_attach = """  const target = brick || knob;
  target.addEventListener('mousedown', onMouseDown);
  const resetBtn = brick?.querySelector('.knob-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const def = hiddenInput.getAttribute('data-default');
      if (def) updateUI(def);
    });
  }"""
js = js.replace(old_bin_attach, new_bin_attach)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
