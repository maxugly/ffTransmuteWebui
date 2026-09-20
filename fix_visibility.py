import re

with open('mtapi-project/app/static/app.js', 'r') as f:
    js = f.read()

old_sync = """function syncGlobalPanelVisibility() {
  var panel = document.getElementById('globalInputsPanel');
  if (!panel) return;
  var hasAny = !!(window.globalInputs.video.trim() || window.globalInputs.image.trim() || window.globalInputs.audio.trim() ||
                   window.globalInputs.pathIn.trim() || window.globalInputs.pathOut.trim());
  panel.classList.toggle('populated', hasAny);
  
  const btnI = document.getElementById('btnQuickI');
  if (btnI) btnI.classList.toggle('active', !!(window.globalInputs.video.trim() || window.globalInputs.image.trim() || window.globalInputs.audio.trim() || window.globalInputs.pathIn.trim()));
  const btnO = document.getElementById('btnQuickO');
  if (btnO) btnO.classList.toggle('active', !!window.globalInputs.pathOut.trim());
}"""

new_sync = """function syncGlobalPanelVisibility() {
  var panel = document.getElementById('globalInputsPanel');
  if (!panel) return;
  var hasAny = !!(window.globalInputs.video.trim() || window.globalInputs.image.trim() || window.globalInputs.audio.trim() ||
                   window.globalInputs.pathIn.trim() || window.globalInputs.pathOut.trim());
  panel.classList.toggle('populated', hasAny);
  
  const inStr = window.globalInputs.video.trim() || window.globalInputs.image.trim() || window.globalInputs.audio.trim() || window.globalInputs.pathIn.trim();
  const outStr = window.globalInputs.pathOut.trim();
  
  const btnI = document.getElementById('btnQuickI');
  if (btnI) btnI.classList.toggle('active', !!inStr);
  const btnO = document.getElementById('btnQuickO');
  if (btnO) btnO.classList.toggle('active', !!outStr);

  const inRow = document.querySelector('.global-row[data-input="mediaIn"]');
  const outRow = document.querySelector('.global-row[data-input="mediaOut"]');
  if (inRow) inRow.style.display = (!inStr && outStr) ? 'none' : '';
  if (outRow) outRow.style.display = (!outStr && inStr) ? 'none' : '';
}"""

js = js.replace(old_sync, new_sync)

with open('mtapi-project/app/static/app.js', 'w') as f:
    f.write(js)
