import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

old_click = """    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();"""
new_click = """    resetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    resetBtn.addEventListener('dblclick', (e) => e.stopPropagation());
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();"""
js = js.replace(old_click, new_click)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
