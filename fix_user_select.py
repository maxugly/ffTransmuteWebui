import re

with open('mtapi-project/app/static/css/forms.css', 'r') as f:
    css = f.read()

old_css = """.knob-unit {
  background: rgba(255, 255, 255, 0.03);"""
new_css = """.knob-unit {
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  background: rgba(255, 255, 255, 0.03);"""

css = css.replace(old_css, new_css)

with open('mtapi-project/app/static/css/forms.css', 'w') as f:
    f.write(css)

