import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# Make sure we add draggable="false" to the html generation just to be absolutely bulletproof
old_html = """<div class="knob-unit" id="${id}Brick" tabindex="0">"""
new_html = """<div class="knob-unit" id="${id}Brick" tabindex="0" draggable="false">"""

js = js.replace(old_html, new_html)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)

