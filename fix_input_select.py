import re

with open('mtapi-project/app/static/css/forms.css', 'r') as f:
    css = f.read()

css += """
.knob-unit .daw-knob-value-input {
  user-select: text;
  -webkit-user-select: text;
}
"""

with open('mtapi-project/app/static/css/forms.css', 'w') as f:
    f.write(css)

