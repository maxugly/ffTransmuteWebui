import re

with open('mtapi-project/app/static/app.js', 'r') as f:
    js = f.read()

if 'audio:   ' not in js:
    js = js.replace("image:   '',   // newline-separated image paths", "image:   '',\n  audio:   '',")

# 1. replace updateGlobalInputs
old_update = js[js.find('function updateGlobalInputs() {'):js.find('function syncGlobalPanelVisibility() {')]
new_update = """function updateGlobalInputs() {
  const prevVideo = window.globalInputs.video;
  const mediaIn = document.getElementById('giMediaIn')?.value || '';
  const mediaOut = document.getElementById('giMediaOut')?.value || '';
  
  const firstLine = (mediaIn.split(/[\\r\\n]+/)[0] || '').trim();
  const ext = firstLine.split('.').pop().toLowerCase();
  
  const videoExts = ['mp4','mkv','avi','mov','m4v','webm','mpg','mpeg','wmv','flv','ts','m2ts'];
  const imageExts = ['png','jpg','jpeg','webp','bmp','gif','tif','tiff','ppm','pgm','svg'];
  const audioExts = ['wav','mp3','aif','aiff','flac','ogg','m4a'];

  let mode = 'unknown';
  if (!firstLine) mode = 'unknown';
  else if (videoExts.includes(ext)) mode = 'video';
  else if (imageExts.includes(ext)) mode = 'image';
  else if (audioExts.includes(ext)) mode = 'audio';
  else if (!firstLine.includes('.')) mode = 'directory';

  const giMediaInEl = document.getElementById('giMediaIn');
  const btnQuickI = document.getElementById('btnQuickI');
  
  if (giMediaInEl) {
    giMediaInEl.className = '';
    if (mode !== 'unknown' && mode !== 'directory') {
      giMediaInEl.classList.add('media-mode-' + mode);
    }
  }
  if (btnQuickI) {
    btnQuickI.className = btnQuickI.className.replace(/media-mode-\\w+/g, '').trim();
    if (mode !== 'unknown' && mode !== 'directory') {
      btnQuickI.classList.add('media-mode-' + mode);
    }
  }

  const giMediaOutEl = document.getElementById('giMediaOut');
  if (giMediaOutEl && mediaOut) {
      const outExt = mediaOut.split('.').pop().toLowerCase();
      let outMode = 'unknown';
      if (videoExts.includes(outExt)) outMode = 'video';
      else if (imageExts.includes(outExt)) outMode = 'image';
      else if (audioExts.includes(outExt)) outMode = 'audio';
      giMediaOutEl.className = '';
      if (outMode !== 'unknown') giMediaOutEl.classList.add('media-mode-' + outMode);
  } else if (giMediaOutEl) {
      giMediaOutEl.className = '';
  }

  window.globalInputs.video = (mode === 'video') ? mediaIn : '';
  window.globalInputs.image = (mode === 'image') ? mediaIn : '';
  window.globalInputs.audio = (mode === 'audio') ? mediaIn : '';
  window.globalInputs.pathIn = (mode === 'directory' || mode === 'unknown') ? mediaIn : '';
  window.globalInputs.pathOut = mediaOut;

  const first = (window.globalInputs.video || '').split(/[\\r\\n]+/).map(l => l.trim()).find(Boolean) || '';
  const prevFirst = (prevVideo || '').split(/[\\r\\n]+/).map(l => l.trim()).find(Boolean) || '';
  if (first !== prevFirst) {
    window.globalInputs._probeOk = false;
  }
  updateStatusIndicators();
  _syncTabInputFromGlobal();
  
  try { refreshInputPreview(); } catch (_) {}
  syncGlobalPanelVisibility();
}

"""
js = js.replace(old_update, new_update)

old_sync = js[js.find('function syncGlobalPanelVisibility() {'):js.find('function _syncTabInputFromGlobal() {')]
new_sync = """function syncGlobalPanelVisibility() {
  var panel = document.getElementById('globalInputsPanel');
  if (!panel) return;
  var hasAny = !!(window.globalInputs.video.trim() || window.globalInputs.image.trim() || window.globalInputs.audio.trim() ||
                   window.globalInputs.pathIn.trim() || window.globalInputs.pathOut.trim());
  panel.classList.toggle('populated', hasAny);
  
  const btnI = document.getElementById('btnQuickI');
  if (btnI) btnI.classList.toggle('active', !!(window.globalInputs.video.trim() || window.globalInputs.image.trim() || window.globalInputs.audio.trim() || window.globalInputs.pathIn.trim()));
  const btnO = document.getElementById('btnQuickO');
  if (btnO) btnO.classList.toggle('active', !!window.globalInputs.pathOut.trim());
}
"""
js = js.replace(old_sync, new_sync)

old_listeners = js[js.find("var btnQuickVIn = document.getElementById('btnQuickVIn');"):js.find("var btnToggle = document.getElementById('btnGlobalToggle');")]
new_listeners = """  var btnQuickI = document.getElementById('btnQuickI');
  if (btnQuickI) {
    btnQuickI.addEventListener('click', function() {
      if (typeof window.openFileBrowser === 'function') {
        window.openFileBrowser('giMediaIn', false, 'files', 'all');
      }
    });
  }
  var btnQuickO = document.getElementById('btnQuickO');
  if (btnQuickO) {
    btnQuickO.addEventListener('click', function() {
      if (typeof window.openFileBrowser === 'function') {
        window.openFileBrowser('giMediaOut', true, 'dir', 'all');
      }
    });
  }
  
  const inEl = document.getElementById('giMediaIn');
  if (inEl) inEl.addEventListener('input', updateGlobalInputs);
  const outEl = document.getElementById('giMediaOut');
  if (outEl) outEl.addEventListener('input', updateGlobalInputs);

  """
js = js.replace(old_listeners, new_listeners)

old_status = js[js.find('function updateStatusIndicators() {'):js.find('function allInputPaths(fieldId) {')]
new_status = """function updateStatusIndicators() {
  const accepts = activeTabAccepts();
  const gi = window.globalInputs;
  const el = document.getElementById('giMediaInStatus');
  if (!el) return;
  
  if (accepts === 'none') {
    el.textContent = '';
    return;
  }
  
  let valid = false;
  if (accepts === 'video' && gi.video) valid = true;
  if (accepts === 'image' && gi.image) valid = true;
  if (accepts === 'any' && (gi.video || gi.image || gi.pathIn || gi.audio)) valid = true;
  if (accepts === 'directory' && gi.pathIn) valid = true;
  
  if (!valid && (gi.video || gi.image || gi.pathIn || gi.audio)) {
     el.textContent = '⚠ Type mismatch';
     el.style.color = 'var(--text-dim)';
  } else {
     el.textContent = '';
  }
}

/**
 * All non-empty paths from global video/image (multi-line) or a local field.
 * Prefer global video for video/any tabs, else global image, else local field
 * (also multi-line). Order preserved; de-dupe exact paths.
 */
"""
js = js.replace(old_status, new_status)

with open('mtapi-project/app/static/app.js', 'w') as f:
    f.write(js)
