import re

with open('mtapi-project/app/static/css/forms.css', 'r') as f:
    css = f.read()

old_css = """  -webkit-user-select: none;
  -webkit-user-drag: none;"""
new_css = """  -webkit-user-select: none;
  -webkit-user-drag: none;
  touch-action: none;"""

css = css.replace(old_css, new_css)

with open('mtapi-project/app/static/css/forms.css', 'w') as f:
    f.write(css)

