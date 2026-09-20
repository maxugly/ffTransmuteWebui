import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# 1. Update onMouseDown bar fill
old_down_fill = """    const fillPct = ((Math.log(currentSens) - Math.log(0.1)) / (Math.log(300.0) - Math.log(0.1))) * 100;"""
new_down_fill = """    const fillPct = (Math.log(currentSens) / Math.log(300.0)) * 100;"""
js = js.replace(old_down_fill, new_down_fill)

# 2. Update onMouseMove calculation and bar fill
old_move = """    // Logarithmic scale: S_new = S_old * exp(deltaX * factor)
    currentSens = startSens * Math.exp(deltaX * 0.015);
    currentSens = Math.min(300.0, Math.max(0.1, currentSens));
    
    const stLabel = document.getElementById('kstLabel');
    if (stLabel) stLabel.textContent = `Sens: ${currentSens.toFixed(1)}%`;
    const stFill = document.getElementById('kstFill');
    if (stFill) {
      const fillPct = ((Math.log(currentSens) - Math.log(0.1)) / (Math.log(300.0) - Math.log(0.1))) * 100;
      stFill.style.width = `${fillPct}%`;
    }"""

new_move = """    // Logarithmic scale: S_new = S_old * exp(deltaX * factor)
    currentSens = startSens * Math.exp(deltaX * 0.008);
    currentSens = Math.min(300.0, Math.max(1.0, currentSens));
    
    const stLabel = document.getElementById('kstLabel');
    if (stLabel) stLabel.textContent = `Sens: ${currentSens.toFixed(1)}%`;
    const stFill = document.getElementById('kstFill');
    if (stFill) {
      const fillPct = (Math.log(currentSens) / Math.log(300.0)) * 100;
      stFill.style.width = `${fillPct}%`;
    }"""

js = js.replace(old_move, new_move)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
