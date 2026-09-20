import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

old = """  const indicator = document.getElementById(opts.indicatorId);
  const valueDisplay = document.getElementById(opts.valueId);
  const valueDispTxt = document.getElementById(opts.hiddenId + 'ValDisp');"""

new = """  const indicator = document.getElementById(opts.indicatorId);
  const valueId = opts.valueId || (opts.hiddenId + 'Val');
  const valueDisplay = document.getElementById(valueId);
  const valueDispTxt = document.getElementById(opts.hiddenId + 'ValDisp');"""

js = js.replace(old, new)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
