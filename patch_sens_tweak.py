import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# Fix bounds in onMouseMove
old_bounds = """    currentSens = Math.min(100.0, Math.max(0.1, currentSens));"""
new_bounds = """    currentSens = Math.min(300.0, Math.max(0.1, currentSens));"""
js = js.replace(old_bounds, new_bounds)

# Fix fill width in onMouseDown
old_fill_down = """    document.getElementById('kstFill').style.width = `${currentSens}%`;"""
new_fill_down = """    document.getElementById('kstFill').style.width = `${(currentSens / 300.0) * 100}%`;"""
js = js.replace(old_fill_down, new_fill_down)

# Fix fill width in onMouseMove
old_fill_move = """    if (stFill) stFill.style.width = `${currentSens}%`;"""
new_fill_move = """    if (stFill) stFill.style.width = `${(currentSens / 300.0) * 100}%`;"""
js = js.replace(old_fill_move, new_fill_move)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
