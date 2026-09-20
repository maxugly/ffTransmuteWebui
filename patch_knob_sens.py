import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

old_vars = """  let startY = 0;
  let startVal = currentVal;"""

new_vars = """  let exactVal = currentVal;
  let currentSens = 100.0;
  let lastY = 0;
  let startX = 0;
  let startSens = 100.0;"""

js = js.replace(old_vars, new_vars)

old_mousedown = """  function onMouseDown(e) {
    if (brick && brick.classList.contains('editing')) return;
    knob.classList.add('active');
    startY = e.clientY;
    startVal = currentVal;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  }"""

new_mousedown = """  function onMouseDown(e) {
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
    
    const rect = target.getBoundingClientRect();
    st.style.left = (rect.left + rect.width / 2) + 'px';
    st.style.top = (rect.top - 8) + 'px';
    st.style.display = 'flex';
    
    document.getElementById('kstLabel').textContent = `Sens: ${currentSens.toFixed(1)}%`;
    document.getElementById('kstFill').style.width = `${currentSens}%`;
  }"""

js = js.replace(old_mousedown, new_mousedown)

old_mousemove = """  function onMouseMove(e) {
    const deltaY = startY - e.clientY;
    let newVal = startVal + (deltaY / sensitivity) * rangeVal;
    newVal = Math.min(maxVal, Math.max(minVal, newVal));
    if (opts.step && opts.step > 0) {
      newVal = Math.round(newVal / opts.step) * opts.step;
      newVal = Math.min(maxVal, Math.max(minVal, newVal));
    }
    updateUI(newVal);
  }"""

new_mousemove = """  function onMouseMove(e) {
    const deltaX = e.clientX - startX;
    // 2 pixels = 1% sensitivity change
    currentSens = startSens + (deltaX * 0.5);
    currentSens = Math.min(100.0, Math.max(0.1, currentSens));
    
    const stLabel = document.getElementById('kstLabel');
    if (stLabel) stLabel.textContent = `Sens: ${currentSens.toFixed(1)}%`;
    const stFill = document.getElementById('kstFill');
    if (stFill) stFill.style.width = `${currentSens}%`;

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
  }"""

js = js.replace(old_mousemove, new_mousemove)

old_mouseup = """  function onMouseUp() {
    knob.classList.remove('active');
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }"""

new_mouseup = """  function onMouseUp() {
    knob.classList.remove('active');
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    const st = document.getElementById('knobSensTooltip');
    if (st) st.style.display = 'none';
  }"""

js = js.replace(old_mouseup, new_mouseup)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
