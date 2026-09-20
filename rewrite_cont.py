import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# Replace setupContinuousKnob attaching logic and UI updates
# We need to make sure valueDisplay is updated properly if it exists
js = js.replace("const valueDisplay = document.getElementById(opts.valueId);", 
                "const valueDisplay = document.getElementById(opts.valueId);\n  const valueDispTxt = document.getElementById(opts.hiddenId + 'ValDisp');")

# Find updateUI and make it update valueDispTxt
old_updateUI = """  function updateUI(val) {
    let disp = val;
    if (opts.format) disp = opts.format(val);
    else if (opts.decimals != null && opts.decimals > 0) disp = parseFloat(val).toFixed(opts.decimals);
    else disp = String(val);

    valueDisplay.value = disp;
    hiddenInput.value = val;
    const pct = (val - minVal) / (maxVal - minVal);
    const angle = -135 + pct * 270;
    indicator.style.transform = `translate(-50%, -100%) rotate(${angle}deg)`;
  }"""

new_updateUI = """  function updateUI(val) {
    let disp = val;
    if (opts.format) disp = opts.format(val);
    else if (opts.decimals != null && opts.decimals > 0) disp = parseFloat(val).toFixed(opts.decimals);
    else disp = String(val);

    valueDisplay.value = disp;
    if (valueDispTxt) valueDispTxt.textContent = disp;
    hiddenInput.value = val;
    const pct = (val - minVal) / (maxVal - minVal);
    const angle = -135 + pct * 270;
    indicator.style.transform = `translate(-50%, -100%) rotate(${angle}deg)`;
  }"""
js = js.replace(old_updateUI, new_updateUI)

# Replace the event listeners setup in setupContinuousKnob
old_attach = """  knob.addEventListener('mousedown', onMouseDown);
  knob.addEventListener('wheel', onWheel, { passive: false });
  // Wheel over the numeric readout also adjusts the knob
  valueDisplay.addEventListener('wheel', onWheel, { passive: false });
  valueDisplay.addEventListener('change', onTextSubmit);
  valueDisplay.addEventListener('blur', onTextSubmit);
  valueDisplay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { valueDisplay.blur(); e.preventDefault(); }
  });"""

new_attach = """  const brick = document.getElementById(opts.hiddenId + 'Brick');
  const target = brick || knob;
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('wheel', onWheel, { passive: false });
  valueDisplay.addEventListener('wheel', onWheel, { passive: false });
  valueDisplay.addEventListener('change', onTextSubmit);
  valueDisplay.addEventListener('blur', (e) => {
    if (brick) brick.classList.remove('editing');
    onTextSubmit();
  });
  valueDisplay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { valueDisplay.blur(); e.preventDefault(); }
  });
  if (brick) {
    brick.addEventListener('dblclick', () => {
      brick.classList.add('editing');
      valueDisplay.focus();
      valueDisplay.select();
    });
    brick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === brick) {
        brick.classList.add('editing');
        valueDisplay.focus();
        valueDisplay.select();
        e.preventDefault();
      }
    });
  }
  const resetBtn = brick?.querySelector('.knob-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    resetBtn.addEventListener('dblclick', (e) => e.stopPropagation());
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const def = parseFloat(hiddenInput.getAttribute('data-default'));
      if (!isNaN(def)) {
        exactVal = def;
        updateUI(def);
        hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }"""
js = js.replace(old_attach, new_attach)

# Replace the event listeners setup in setupBinaryKnob
old_bin_attach = """  knob.addEventListener('mousedown', onMouseDown);
  knob.addEventListener('wheel', onWheel, { passive: false });
  if (!knob.getAttribute('title') || /click to toggle/i.test(knob.getAttribute('title') || '')) {
    knob.title = 'Click to toggle · scroll wheel';
  }"""

new_bin_attach = """  const brick = document.getElementById(opts.hiddenId + 'Brick');
  const target = brick || knob;
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('wheel', onWheel, { passive: false });
  if (!knob.getAttribute('title') || /click to toggle/i.test(knob.getAttribute('title') || '')) {
    knob.title = 'Click to toggle · scroll wheel';
  }
  const resetBtn = brick?.querySelector('.knob-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    resetBtn.addEventListener('dblclick', (e) => e.stopPropagation());
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const def = hiddenInput.getAttribute('data-default');
      if (def) {
        updateUI(def);
        hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }"""
js = js.replace(old_bin_attach, new_bin_attach)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
