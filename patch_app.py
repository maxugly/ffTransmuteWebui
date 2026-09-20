import re

with open('mtapi-project/app/static/app.js', 'r') as f:
    js = f.read()

new_update = """function updateGlobalInputs() {
  const prevVideo = window.globalInputs.video;
  const mediaIn = document.getElementById('giMediaIn')?.value || '';
  const mediaOut = document.getElementById('giMediaOut')?.value || '';
  
  const firstLine = (mediaIn.split('\\n')[0] || '').trim();
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
  if (giMediaInEl) {
    giMediaInEl.className = '';
    if (mode !== 'unknown' && mode !== 'directory') {
      giMediaInEl.classList.add('media-mode-' + mode);
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
  window.globalInputs.pathIn = (mode === 'directory' || mode === 'audio' || mode === 'unknown') ? mediaIn : '';
  window.globalInputs.pathOut = mediaOut;

  const first = (window.globalInputs.video || '').split('\\n').map(l => l.trim()).find(Boolean) || '';
  const prevFirst = (prevVideo || '').split('\\n').map(l => l.trim()).find(Boolean) || '';
  if (first !== prevFirst) {
    window.globalInputs._probeOk = false;
  }
  updateStatusIndicators();
  _syncTabInputFromGlobal();
  
  try { refreshInputPreview(); } catch (_) {}
  syncGlobalPanelVisibility();
}

function syncGlobalPanelVisibility() {
  var panel = document.getElementById('globalInputsPanel');
  if (!panel) return;
  var hasAny = !!(window.globalInputs.video.trim() || window.globalInputs.image.trim() ||
                   window.globalInputs.pathIn.trim() || window.globalInputs.pathOut.trim());
  panel.classList.toggle('populated', hasAny);
}
"""

js = re.sub(
    r'function updateGlobalInputs\(\) \{.*?(?=function _syncTabInputFromGlobal)',
    new_update,
    js,
    flags=re.DOTALL
)

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
        window.openFileBrowser('giMediaOut', false, 'file_save', 'all');
      }
    });
  }
  
  const inEl = document.getElementById('giMediaIn');
  if (inEl) inEl.addEventListener('input', updateGlobalInputs);
  const outEl = document.getElementById('giMediaOut');
  if (outEl) outEl.addEventListener('input', updateGlobalInputs);

  var btnToggle = document.getElementById('btnGlobalToggle');"""

js = re.sub(
    r'var btnQuickVIn = document\.getElementById\(\'btnQuickVIn\'\);.*?var btnToggle = document\.getElementById\(\'btnGlobalToggle\'\);',
    new_listeners,
    js,
    flags=re.DOTALL
)

with open('mtapi-project/app/static/app.js', 'w') as f:
    f.write(js)
