import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# For setupContinuousKnob:
find_cont = "function setupContinuousKnob"
pos = js.find(find_cont)
pos_attach = js.find("target.addEventListener('mousedown', onMouseDown);", pos)

cont_block = """target.addEventListener('mousedown', onMouseDown);
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
js = js[:pos_attach] + cont_block + js[pos_attach + len("target.addEventListener('mousedown', onMouseDown);"):]

# For setupBinaryKnob:
find_bin = "function setupBinaryKnob"
pos2 = js.find(find_bin)
pos_attach2 = js.find("target.addEventListener('mousedown', onMouseDown);", pos2)

bin_block = """target.addEventListener('mousedown', onMouseDown);
  const resetBtn = brick?.querySelector('.knob-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const def = hiddenInput.getAttribute('data-default');
      if (def) updateUI(def);
    });
  }"""
js = js[:pos_attach2] + bin_block + js[pos_attach2 + len("target.addEventListener('mousedown', onMouseDown);"):]

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
