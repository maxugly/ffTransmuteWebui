import re

with open('mtapi-project/app/static/css/forms.css', 'r') as f:
    css = f.read()

css += """
.knob-unit * {
  -webkit-user-drag: none;
}
"""

with open('mtapi-project/app/static/css/forms.css', 'w') as f:
    f.write(css)

