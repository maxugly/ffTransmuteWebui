import re

with open('mtapi-project/app/static/app.js', 'r') as f:
    js = f.read()

# Make window.globalInputs hold audio too
js = js.replace("image:   '',   // newline-separated image paths", "image:   '',   // newline-separated image paths\\n  audio:   '',")

# In updateGlobalInputs, read audio
js = js.replace("window.globalInputs.image   = document.getElementById('giImage')?.value || '';", "window.globalInputs.image   = document.getElementById('giImage')?.value || '';\\n  window.globalInputs.audio   = document.getElementById('giAudio')?.value || '';")

# Add hasAudio to declutter logic
declutter_old = """  const hasVideo = !!window.globalInputs.video.trim();
  const hasImage = !!window.globalInputs.image.trim();
  const hasPathIn = !!window.globalInputs.pathIn.trim();
  
  const videoRow = document.querySelector('.global-row[data-input="video"]');
  const imageRow = document.querySelector('.global-row[data-input="image"]');
  const pathInRow = document.querySelector('.global-row[data-input="pathIn"]');"""

declutter_new = """  const hasVideo = !!window.globalInputs.video.trim();
  const hasImage = !!window.globalInputs.image.trim();
  const hasAudio = !!window.globalInputs.audio.trim();
  const hasPathIn = !!window.globalInputs.pathIn.trim();
  
  const videoRow = document.querySelector('.global-row[data-input="video"]');
  const imageRow = document.querySelector('.global-row[data-input="image"]');
  const audioRow = document.querySelector('.global-row[data-input="audio"]');
  const pathInRow = document.querySelector('.global-row[data-input="pathIn"]');"""
js = js.replace(declutter_old, declutter_new)

hide_old = """  if (videoRow)  videoRow.style.display  = (!hasVideo  && (hasImage || hasPathIn)) ? 'none' : '';
  if (imageRow)  imageRow.style.display  = (!hasImage && (hasVideo || hasPathIn)) ? 'none' : '';
  if (pathInRow) pathInRow.style.display = (!hasPathIn && (hasVideo || hasImage)) ? 'none' : '';"""

hide_new = """  if (videoRow)  videoRow.style.display  = (!hasVideo  && (hasImage || hasAudio || hasPathIn)) ? 'none' : '';
  if (imageRow)  imageRow.style.display  = (!hasImage && (hasVideo || hasAudio || hasPathIn)) ? 'none' : '';
  if (audioRow)  audioRow.style.display  = (!hasAudio  && (hasVideo || hasImage || hasPathIn)) ? 'none' : '';
  if (pathInRow) pathInRow.style.display = (!hasPathIn && (hasVideo || hasImage || hasAudio)) ? 'none' : '';"""
js = js.replace(hide_old, hide_new)

# syncGlobalPanelVisibility
sync_old = """  var hasAny = !!(window.globalInputs.video.trim() || window.globalInputs.image.trim() ||
                   window.globalInputs.pathIn.trim() || window.globalInputs.pathOut.trim());
  panel.classList.toggle('populated', hasAny);
  // Update quick button active states
  var map = { btnQuickVIn: 'video', btnQuickVOut: 'pathOut', btnQuickIIn: 'image', btnQuickIOut: 'pathIn' };
  Object.keys(map).forEach(function(id) {
    var btn = document.getElementById(id);
    var key = map[id];
    if (btn) btn.classList.toggle('active', !!window.globalInputs[key].trim());
  });"""

sync_new = """  var hasAny = !!(window.globalInputs.video.trim() || window.globalInputs.image.trim() || window.globalInputs.audio.trim() ||
                   window.globalInputs.pathIn.trim() || window.globalInputs.pathOut.trim());
  panel.classList.toggle('populated', hasAny);
  
  const btnI = document.getElementById('btnQuickI');
  if (btnI) {
      btnI.classList.toggle('active', !!(window.globalInputs.video.trim() || window.globalInputs.image.trim() || window.globalInputs.audio.trim() || window.globalInputs.pathIn.trim()));
      btnI.className = btnI.className.replace(/media-mode-\\w+/g, '').trim();
      if (window.globalInputs.video.trim()) btnI.classList.add('media-mode-video');
      else if (window.globalInputs.image.trim()) btnI.classList.add('media-mode-image');
      else if (window.globalInputs.audio.trim()) btnI.classList.add('media-mode-audio');
  }
  const btnO = document.getElementById('btnQuickO');
  if (btnO) btnO.classList.toggle('active', !!window.globalInputs.pathOut.trim());"""
js = js.replace(sync_old, sync_new)

# Event listeners setup
listeners_old = """  var btnQuickVIn = document.getElementById('btnQuickVIn');
  if (btnQuickVIn) {
    btnQuickVIn.addEventListener('click', function() {
      window.openFileBrowser('giVideo', false, 'files', 'video');
    });
  }
  var btnQuickVOut = document.getElementById('btnQuickVOut');
  if (btnQuickVOut) {
    btnQuickVOut.addEventListener('click', function() {
      window.openFileBrowser('giPathOut', true, 'dir', 'all');
    });
  }
  var btnQuickIIn = document.getElementById('btnQuickIIn');
  if (btnQuickIIn) {
    btnQuickIIn.addEventListener('click', function() {
      window.openFileBrowser('giImage', false, 'files', 'image');
    });
  }
  var btnQuickIOut = document.getElementById('btnQuickIOut');
  if (btnQuickIOut) {
    btnQuickIOut.addEventListener('click', function() {
      window.openFileBrowser('giPathIn', true, 'dir', 'all');
    });
  }"""

listeners_new = """  var btnQuickI = document.getElementById('btnQuickI');
  if (btnQuickI) {
    btnQuickI.addEventListener('click', function() {
      if (typeof window.openFileBrowser === 'function') {
        window.openFileBrowser('giSecretIn', false, 'files', 'all');
      }
    });
  }
  var btnQuickO = document.getElementById('btnQuickO');
  if (btnQuickO) {
    btnQuickO.addEventListener('click', function() {
      if (typeof window.openFileBrowser === 'function') {
        window.openFileBrowser('giPathOut', true, 'dir', 'all');
      }
    });
  }
  
  const secretIn = document.getElementById('giSecretIn');
  if (secretIn) {
      secretIn.addEventListener('input', function() {
          const val = secretIn.value.trim();
          if (!val) return;
          const firstLine = val.split('\\n')[0];
          const ext = firstLine.split('.').pop().toLowerCase();
          const videoExts = ['mp4','mkv','avi','mov','m4v','webm','mpg','mpeg','wmv','flv','ts','m2ts'];
          const imageExts = ['png','jpg','jpeg','webp','bmp','gif','tif','tiff','ppm','pgm','svg'];
          const audioExts = ['wav','mp3','aif','aiff','flac','ogg','m4a'];
          
          let targetId = 'giPathIn';
          if (videoExts.includes(ext)) targetId = 'giVideo';
          else if (imageExts.includes(ext)) targetId = 'giImage';
          else if (audioExts.includes(ext)) targetId = 'giAudio';
          else if (firstLine.includes('.')) targetId = 'giVideo'; // fallback

          const targetEl = document.getElementById(targetId);
          if (targetEl) {
              targetEl.value = val;
              targetEl.dispatchEvent(new Event('input'));
          }
          secretIn.value = ''; // clear it
      });
  }"""
js = js.replace(listeners_old, listeners_new)

with open('mtapi-project/app/static/app.js', 'w') as f:
    f.write(js)
