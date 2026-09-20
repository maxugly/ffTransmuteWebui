import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# 1. Add the helper functions at the top of the file
helpers = """function getSensX(s) {
  if (s <= 100) return (Math.log(s) / Math.log(100.0)) * 1000.0;
  return 1000.0 + (s - 100.0) * 5.0;
}
function getSensFromX(x) {
  if (x <= 1000) return Math.exp(x * (Math.log(100.0) / 1000.0));
  return 100.0 + (x - 1000.0) * 0.2;
}

"""
# Prepend helpers if not there
if "function getSensX" not in js:
    js = helpers + js

# 2. Update variables in setupContinuousKnob
old_vars = """  let exactVal = currentVal;
  let currentSens = 100.0;
  let lastY = 0;
  let startX = 0;
  let startSens = 100.0;"""

new_vars = """  let exactVal = currentVal;
  let currentSens = 100.0;
  let lastY = 0;
  let startX = 0;
  let startXVirtual = 1000.0;"""

js = js.replace(old_vars, new_vars)

# 3. Update onMouseDown
old_down = """    exactVal = currentVal;
    lastY = e.clientY;
    startX = e.clientX;
    startSens = currentSens;"""

new_down = """    exactVal = currentVal;
    lastY = e.clientY;
    startX = e.clientX;
    startXVirtual = getSensX(currentSens);"""

js = js.replace(old_down, new_down)

old_down_fill = """    const fillPct = (Math.log(currentSens) / Math.log(300.0)) * 100;
    document.getElementById('kstFill').style.width = `${fillPct}%`;"""

new_down_fill = """    const fillPct = (getSensX(currentSens) / 2000.0) * 100.0;
    document.getElementById('kstFill').style.width = `${fillPct}%`;"""

js = js.replace(old_down_fill, new_down_fill)

# 4. Update onMouseMove
old_move = """    // Asymmetric logarithmic scale
    let newSens;
    if (deltaX >= 0) {
      // Dragging right: smoothly reach 300% over ~400 pixels
      newSens = startSens * Math.exp(deltaX * (Math.log(3.0) / 400.0));
    } else {
      // Dragging left: smoothly reach 1.0% over ~800 pixels
      newSens = startSens * Math.exp(deltaX * (Math.log(100.0) / 800.0));
    }
    currentSens = Math.min(300.0, Math.max(1.0, newSens));
    
    const stLabel = document.getElementById('kstLabel');
    if (stLabel) stLabel.textContent = `Sens: ${currentSens.toFixed(1)}%`;
    const stFill = document.getElementById('kstFill');
    if (stFill) {
      const fillPct = (Math.log(currentSens) / Math.log(300.0)) * 100;
      stFill.style.width = `${fillPct}%`;
    }"""

new_move = """    const currentXVirtual = startXVirtual + deltaX;
    currentSens = getSensFromX(currentXVirtual);
    currentSens = Math.min(300.0, Math.max(1.0, currentSens));
    
    const stLabel = document.getElementById('kstLabel');
    if (stLabel) stLabel.textContent = `Sens: ${currentSens.toFixed(1)}%`;
    const stFill = document.getElementById('kstFill');
    if (stFill) {
      const fillPct = (getSensX(currentSens) / 2000.0) * 100.0;
      stFill.style.width = `${fillPct}%`;
    }"""

js = js.replace(old_move, new_move)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
