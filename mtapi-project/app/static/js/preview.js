// Preview panel + console output + AR fitting
import { state, elements } from '/app.js';
import { findPoolItem } from '/js/pool/sequence.js';
import { bindPoolDragResize } from '/js/pool/layout.js';

// ── Preview AR + console split ────────────────────────────────────────────

function gcdInt(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) { const t = b; b = a % b; a = t; }
  return a || 1;
}

/** Set preview box to source aspect ratio; never crops (object-fit: contain). */
function setPreviewAspect(w, h) {
  const viewer = elements.mediaViewer;
  if (!viewer || !w || !h || w <= 0 || h <= 0) return;
  viewer.dataset.arW = String(w);
  viewer.dataset.arH = String(h);
  viewer.classList.add('has-media');
  const badge = document.getElementById('mediaArBadge');
  if (badge) {
    const g = gcdInt(w, h);
    badge.textContent = `${w}×${h} · ${Math.round(w / g)}:${Math.round(h / g)}`;
  }
  fitPreviewViewer();
}

function clearPreviewAspect() {
  const viewer = elements.mediaViewer;
  if (!viewer) return;
  viewer.classList.remove('has-media');
  delete viewer.dataset.arW;
  delete viewer.dataset.arH;
  viewer.style.width = '';
  viewer.style.height = '';
  const badge = document.getElementById('mediaArBadge');
  if (badge) badge.textContent = '';
}

/** Fit viewer inside stage using source AR — letterbox only if stage differs. */
function fitPreviewViewer() {
  const stage = document.getElementById('mediaViewerStage');
  const viewer = elements.mediaViewer;
  if (!stage || !viewer) return;

  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (sw < 8 || sh < 8) return;

  let arW = parseFloat(viewer.dataset.arW);
  let arH = parseFloat(viewer.dataset.arH);
  if (!arW || !arH) {
    const side = Math.min(sw, sh);
    viewer.style.width = `${side}px`;
    viewer.style.height = `${side}px`;
    return;
  }

  let vw = sw;
  let vh = sw * (arH / arW);
  if (vh > sh) {
    vh = sh;
    vw = sh * (arW / arH);
  }
  viewer.style.width = `${Math.max(1, Math.floor(vw))}px`;
  viewer.style.height = `${Math.max(1, Math.floor(vh))}px`;
}

function setupPreviewConsoleResize() {
  const handle = document.getElementById('previewConsoleResize');
  const panel = document.getElementById('previewPanel');
  const consoleBox = document.getElementById('consoleBox');
  if (!handle || !panel || !consoleBox) return;

  try {
    const saved = parseInt(localStorage.getItem('mtapi_console_h') || '', 10);
    if (saved >= 72 && saved <= 800) {
      panel.style.setProperty('--console-h', `${saved}px`);
    }
  } catch (_) { /* ignore */ }

  bindPoolDragResize(handle, {
    axis: 'y',
    onMove: (dy, start) => {
      const height = Math.max(72, Math.min(panel.clientHeight * 0.72, start.consoleH - dy));
      panel.style.setProperty('--console-h', `${Math.round(height)}px`);
      fitPreviewViewer();
    },
    startVals: () => {
      const cs = getComputedStyle(panel).getPropertyValue('--console-h').trim();
      const px = parseInt(cs, 10);
      return { consoleH: Number.isFinite(px) ? px : consoleBox.offsetHeight || 180 };
    },
  });

  handle.addEventListener('pointerup', () => {
    try {
      const cs = getComputedStyle(panel).getPropertyValue('--console-h').trim();
      const px = parseInt(cs, 10);
      if (px >= 72) localStorage.setItem('mtapi_console_h', String(px));
    } catch (_) { /* ignore */ }
    fitPreviewViewer();
  });

  window.addEventListener('resize', () => fitPreviewViewer());
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => fitPreviewViewer());
    const stage = document.getElementById('mediaViewerStage');
    if (stage) ro.observe(stage);
  }
}

function showPreview(filePath) {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  const filename = filePath.substring(filePath.lastIndexOf('/') + 1);
  
  elements.mediaName.textContent = filename;
  elements.mediaPath.textContent = filePath;
  elements.mediaInfo.style.display = 'flex';
  
  elements.mediaViewer.innerHTML = '';
  clearPreviewAspect();
  
  if (['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
    const video = document.createElement('video');
    video.src = `/api/video?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth && video.videoHeight) {
        setPreviewAspect(video.videoWidth, video.videoHeight);
      }
    });
    elements.mediaViewer.appendChild(video);
    const item = findPoolItem(filePath);
    if (item?.meta?.width && item?.meta?.height) {
      setPreviewAspect(item.meta.width, item.meta.height);
    }
  } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    const img = document.createElement('img');
    img.src = `/api/image?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        setPreviewAspect(img.naturalWidth, img.naturalHeight);
      }
    };
    elements.mediaViewer.appendChild(img);
  } else if (['.m4a', '.mp3', '.wav'].includes(ext)) {
    elements.mediaViewer.innerHTML = `
      <div class="media-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
        <p>Audio Extracted successfully!</p>
        <audio controls src="/api/video?path=${encodeURIComponent(filePath)}" style="margin-top: 12px; width: 80%;"></audio>
      </div>
    `;
    setPreviewAspect(16, 9);
  } else {
    elements.mediaViewer.innerHTML = `
      <div class="media-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <p>File generated: <strong>${filename}</strong></p>
        <p style="font-size: 0.75rem;">Path: ${filePath}</p>
      </div>
    `;
    setPreviewAspect(16, 9);
  }
}

function logConsole(text, type = 'normal') {
  const line = document.createElement('div');
  
  if (type === 'command') {
    line.className = 'console-cmd';
    line.textContent = `$ ${text}`;
  } else if (type === 'stdout') {
    line.className = 'console-stdout';
    line.textContent = text;
  } else if (type === 'stderr') {
    line.className = 'console-stderr';
    line.textContent = text;
  } else if (type === 'error') {
    line.className = 'console-error';
    line.textContent = text;
  } else {
    line.textContent = text;
  }
  
  elements.consoleBody.appendChild(line);
  elements.consoleBody.scrollTop = elements.consoleBody.scrollHeight;
}

export {
  gcdInt, setPreviewAspect, clearPreviewAspect,
  fitPreviewViewer, setupPreviewConsoleResize,
  showPreview, logConsole,
};
