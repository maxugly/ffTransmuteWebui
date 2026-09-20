import re

with open('mtapi-project/app/static/app.js', 'r') as f:
    js = f.read()

new_status = """function updateStatusIndicators() {
  const tab = state.activeTab;
  const accepts = activeTabAccepts();
  const gi = window.globalInputs;
  
  var el = document.getElementById('giMediaInStatus');
  if (!el) return;
  
  if (accepts === 'none') {
    el.textContent = '';
    el.title = '';
    return;
  }
  
  let valid = false;
  if (accepts === 'video' && gi.video) valid = true;
  if (accepts === 'image' && gi.image) valid = true;
  if (accepts === 'any' && (gi.video || gi.image || gi.pathIn)) valid = true;
  if (accepts === 'directory' && gi.pathIn) valid = true;
  
  if (!valid && (gi.video || gi.image || gi.pathIn)) {
     el.textContent = '⚠ Type mismatch';
     el.style.color = 'var(--text-dim)';
  } else {
     el.textContent = '';
  }
"""

js = re.sub(
    r'function updateStatusIndicators\(\) \{.*?(?=\n\}\n)',
    new_status,
    js,
    flags=re.DOTALL
)

with open('mtapi-project/app/static/app.js', 'w') as f:
    f.write(js)
