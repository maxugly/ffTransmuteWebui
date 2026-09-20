import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

old_brick_keydown = """    brick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && document.activeElement === brick) {
        startEditing();
        e.preventDefault();
      }
    });"""

new_brick_keydown = """    brick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === brick) {
        startEditing();
        e.preventDefault();
      }
    });"""

js = js.replace(old_brick_keydown, new_brick_keydown)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
