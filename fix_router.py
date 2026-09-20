import re

with open('mtapi-project/app/static/app.js', 'r') as f:
    js = f.read()

router_old = """          const targetEl = document.getElementById(targetId);
          if (targetEl) {
              targetEl.value = val;
              targetEl.dispatchEvent(new Event('input'));
          }"""

router_new = """          const targetEl = document.getElementById(targetId);
          if (targetEl) {
              // Clear other legacy inputs so they can hide
              ['giVideo', 'giImage', 'giAudio', 'giPathIn'].forEach(id => {
                  if (id !== targetId) {
                      const el = document.getElementById(id);
                      if (el && el.value) {
                          el.value = '';
                          el.dispatchEvent(new Event('input'));
                      }
                  }
              });
              targetEl.value = val;
              targetEl.dispatchEvent(new Event('input'));
          }"""

js = js.replace(router_old, router_new)

with open('mtapi-project/app/static/app.js', 'w') as f:
    f.write(js)
