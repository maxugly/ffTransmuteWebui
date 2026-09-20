import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

old_move = """    // Logarithmic scale: S_new = S_old * exp(deltaX * factor)
    currentSens = startSens * Math.exp(deltaX * 0.008);
    currentSens = Math.min(300.0, Math.max(1.0, currentSens));"""

new_move = """    // Asymmetric logarithmic scale
    let newSens;
    if (deltaX >= 0) {
      // Dragging right: smoothly reach 300% over ~400 pixels
      newSens = startSens * Math.exp(deltaX * (Math.log(3.0) / 400.0));
    } else {
      // Dragging left: smoothly reach 1.0% over ~800 pixels
      newSens = startSens * Math.exp(deltaX * (Math.log(100.0) / 800.0));
    }
    currentSens = Math.min(300.0, Math.max(1.0, newSens));"""

js = js.replace(old_move, new_move)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
