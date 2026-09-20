import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# I will replace the getSensX logic with the simple linear logic.
start_str = "function setupContinuousKnob(opts) {"
end_str = "/**\n * Two-position snap knob"

start_idx = js.find(start_str)
end_idx = js.find(end_str)

new_func = """function setupContinuousKnob(opts) {
  const knob = document.getElementById(opts.knobId);
  const indicator = document.getElementById(opts.indicatorId);
  const valueDisplay = document.getElementById(opts.valueId);
  const valueDispTxt = document.getElementById(opts.hiddenId + 'ValDisp');
  const hiddenInput = document.getElementById(opts.hiddenId);
  if (!knob || !indicator || !valueDisplay || !hiddenInput) return;

  const minVal = opts.min != null ? opts.min : 0;
  const maxVal = opts.max != null ? opts.max : 100;
  const rangeVal = maxVal - minVal;
  const sensitivity = opts.sensitivity || 140; 
  const decimals = opts.decimals != null ? opts.decimals : 2;

  let currentVal = parseFloat(hiddenInput.value);
  if (isNaN(currentVal)) currentVal = minVal;
  
  let exactVal = currentVal;
  let currentSens = 100.0;
  let lastY = 0;
  let startX = 0;
  let startSens = 100.0;

  function updateUI(val) {
    let disp = val;
    if (opts.format) disp = opts.format(val);
    else if (opts.decimals != null && opts.decimals > 0) disp = parseFloat(val).toFixed(opts.decimals);
    else disp = String(val);

    valueDisplay.value = disp;
    if (valueDispTxt) valueDispTxt.textContent = disp;
    hiddenInput.value = val;
    const pct = rangeVal === 0 ? 0 : (val - minVal) / rangeVal;
    const angle = -135 + pct * 270;
    indicator.style.transform = `translate(-50%, -100%) rotate(${angle}deg)`;
    currentVal = val;
  }

  const brick = document.getElementById(opts.hiddenId + 'Brick');

  function onMouseDown(e) {
    if (brick && brick.classList.contains('editing')) return;
    knob.classList.add('active');
    exactVal = currentVal;
    lastY = e.clientY;
    startX = e.clientX;
    startSens = currentSens;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();

    let st = document.getElementById('knobSensTooltip');
    if (!st) {
      st = document.createElement('div');
      st.id = 'knobSensTooltip';
      st.style.position = 'fixed';
      st.style.background = 'rgba(15, 23, 42, 0.95)';
      st.style.color = '#38bdf8';
      st.style.padding = '6px 10px';
      st.style.borderRadius = '6px';
      st.style.fontSize = '0.7rem';
      st.style.fontFamily = 'monospace';
      st.style.pointerEvents = 'none';
      st.style.zIndex = '9999';
      st.style.border = '1px solid #38bdf8';
      st.style.transform = 'translate(-50%, -100%)';
      st.style.boxShadow = '0 4px 12px rgba(0,0,0,0.7)';
      st.style.display = 'flex';
      st.style.flexDirection = 'column';
      st.style.alignItems = 'center';
      st.style.gap = '4px';
      
      const label = document.createElement('div');
      label.id = 'kstLabel';
      st.appendChild(label);
      
      const track = document.createElement('div');
      track.style.width = '70px';
      track.style.height = '4px';
      track.style.background = '#334155';
      track.style.borderRadius = '2px';
      track.style.overflow = 'hidden';
      
      const fill = document.createElement('div');
      fill.id = 'kstFill';
      fill.style.height = '100%';
      fill.style.background = '#38bdf8';
      fill.style.width = '100%';
      track.appendChild(fill);
      
      st.appendChild(track);
      document.body.appendChild(st);
    }
    
    const targetEl = brick || knob;
    const rect = targetEl.getBoundingClientRect();
    st.style.left = (rect.left + rect.width / 2) + 'px';
    st.style.top = (rect.top - 8) + 'px';
    st.style.display = 'flex';
    
    document.getElementById('kstLabel').textContent = `Sens: ${currentSens.toFixed(1)}%`;
    document.getElementById('kstFill').style.width = `${(currentSens / 300.0) * 100}%`;
  }
  
  function onMouseMove(e) {
    const deltaX = e.clientX - startX;
    
    // Linear math (The stable version)
    currentSens = startSens + (deltaX * 0.5);
    currentSens = Math.min(300.0, Math.max(0.1, currentSens));
    
    const stLabel = document.getElementById('kstLabel');
    if (stLabel) stLabel.textContent = `Sens: ${currentSens.toFixed(1)}%`;
    const stFill = document.getElementById('kstFill');
    if (stFill) stFill.style.width = `${(currentSens / 300.0) * 100}%`;

    const deltaY = lastY - e.clientY;
    if (deltaY !== 0) {
      let sensMultiplier = currentSens / 100.0;
      let valChange = (deltaY / sensitivity) * rangeVal * sensMultiplier;
      exactVal += valChange;
      exactVal = Math.min(maxVal, Math.max(minVal, exactVal));

      let newVal = exactVal;
      if (opts.step && opts.step > 0) {
        newVal = Math.round(exactVal / opts.step) * opts.step;
        newVal = Math.min(maxVal, Math.max(minVal, newVal));
      }
      updateUI(newVal);
      lastY = e.clientY;
    }
  }

  function onMouseUp() {
    knob.classList.remove('active');
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    const st = document.getElementById('knobSensTooltip');
    if (st) st.style.display = 'none';
    hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function onTextSubmit() {
    let raw = valueDisplay.value.replace(/[^0-9.+\-eE]/g, '').trim();
    let val = parseFloat(raw);
    if (isNaN(val)) val = currentVal;
    val = Math.min(maxVal, Math.max(minVal, val));
    if (opts.step && opts.step > 0) {
      val = Math.round(val / opts.step) * opts.step;
    }
    exactVal = val;
    updateUI(val);
    hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function snapVal(v) {
    let newVal = Math.min(maxVal, Math.max(minVal, v));
    if (opts.step && opts.step > 0) {
      newVal = Math.round(newVal / opts.step) * opts.step;
      newVal = Math.min(maxVal, Math.max(minVal, newVal));
    }
    return newVal;
  }

  function onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
    if (!dir) return;
    let step;
    if (opts.step && opts.step > 0) {
      const coarseMul = Math.max(1, Math.round(rangeVal / (opts.step * 40)) || 1);
      step = opts.step * (e.shiftKey ? 1 : coarseMul);
    } else if (decimals <= 0) {
      step = e.shiftKey ? 1 : Math.max(1, Math.round(rangeVal / 50) || 1);
    } else {
      step = rangeVal / (e.shiftKey ? 200 : 50);
    }
    let nVal = snapVal(currentVal + dir * step);
    exactVal = nVal;
    updateUI(nVal);
    hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

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
    const resetBtn = brick.querySelector('.knob-reset-btn');
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
    }
  }

  updateUI(currentVal);
}
"""

js = js[:start_idx] + new_func + js[end_idx:]

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
