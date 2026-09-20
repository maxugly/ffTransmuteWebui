import re

with open('mtapi-project/app/static/app.js', 'r') as f:
    js = f.read()

# Add to SETTINGS_DEFAULTS
replacement = """  restoreSession: true,
  knobBotCurve: 'log10',
  knobMidSet: 100,
  knobTopCurve: 'lin',
  knobMax: 125,
  autoAddToSequence: false,"""

js = js.replace("  autoAddToSequence: false,", replacement)

with open('mtapi-project/app/static/app.js', 'w') as f:
    f.write(js)
