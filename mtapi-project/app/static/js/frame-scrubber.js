// Frame Scrubber — thumbnail hover preview for global frame range picker

let _frameUrls = null;
let _frameCount = 0;
let _loadedFrames = {};
let _loadRange = 10;
let _stripPath = '';

// ── setup ──────────────────────────────────────────────────────────────────

export function setupFrameScrubber() {
  const btn = document.getElementById('btnFrameScrub');
  const startThumb = document.getElementById('giTimelineStart');
  const endThumb = document.getElementById('giTimelineEnd');
  const popup = document.getElementById('scrubPopup');
  const popupImg = document.getElementById('scrubPopupImg');
  const giVideo = document.getElementById('giVideo');

  if (!btn || !startThumb || !endThumb || !popup || !popupImg) return;

  btn.addEventListener('click', () => fetchFrameStrip(btn));

  if (giVideo) {
    giVideo.addEventListener('input', () => {
      const path = giVideo.value.split('\n')[0].trim();
      if (path && path !== _stripPath) {
        resetFrameScrubber();
      }
    });
  }

  [startThumb, endThumb].forEach(thumb => {
    thumb.addEventListener('input', () => updatePopup(thumb, popupImg));
    thumb.addEventListener('mouseenter', () => showPopup(thumb, popup, popupImg));
    thumb.addEventListener('mouseleave', () => hidePopup(popup));
  });
}

// ── fetch ──────────────────────────────────────────────────────────────────

async function fetchFrameStrip(btn) {
  const gi = window.globalInputs;
  const path = (gi.video || '').split('\n')[0].trim();
  if (!path) return;

  btn.classList.add('loading');
  btn.textContent = '...';
  _frameUrls = null;
  _frameCount = 0;
  _loadedFrames = {};
  _stripPath = '';

  try {
    const res = await fetch('/media/frame-strip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.ok && data.frame_urls) {
      _frameUrls = data.frame_urls;
      _frameCount = data.frame_count;
      _stripPath = path;
      btn.classList.remove('loading');
      btn.classList.add('done');
      btn.textContent = '\u2713';
      btn.title = `${data.frame_count} frame thumbnails ready` +
        (data.cached ? ' (cached)' : '');
    } else {
      btn.classList.remove('loading');
      btn.textContent = '[x]';
      btn.title = data.error || 'Failed to extract frames';
      console.warn('frame-scrubber:', data.error);
    }
  } catch (err) {
    btn.classList.remove('loading');
    btn.textContent = '[x]';
    btn.title = 'Network error';
    console.error('frame-scrubber:', err);
  }
}

// ── popup show/hide ────────────────────────────────────────────────────────

function showPopup(thumb, popup, popupImg) {
  if (!_frameUrls || !_frameUrls.length) return;
  updatePopup(thumb, popupImg);
  popup.style.display = '';
}

function hidePopup(popup) {
  popup.style.display = 'none';
}

// ── popup update ───────────────────────────────────────────────────────────

function updatePopup(thumb, popupImg) {
  if (!_frameUrls || !_frameUrls.length) return;
  let val = parseInt(thumb.value, 10);
  if (isNaN(val) || val < 1) return;

  const timelineMax = parseInt(thumb.max, 10) || 100;
  const pct = (val - 1) / Math.max(1, timelineMax - 1);
  const idx = Math.min(_frameCount - 1, Math.round(pct * (_frameCount - 1)));
  lazyLoadFrame(idx);

  const frameUrl = _loadedFrames[idx];
  if (frameUrl && popupImg.src !== frameUrl) {
    popupImg.src = frameUrl;
  }
}

function lazyLoadFrame(idx) {
  if (_loadedFrames[idx]) return;
  _loadedFrames[idx] = _frameUrls[idx];
  const lo = Math.max(0, idx - _loadRange);
  const hi = Math.min(_frameCount - 1, idx + _loadRange);
  for (let i = lo; i <= hi; i++) {
    if (!_loadedFrames[i]) {
      _loadedFrames[i] = _frameUrls[i];
      const img = new Image();
      img.src = _frameUrls[i];
    }
  }
}

// ── state reset ────────────────────────────────────────────────────────────

export function resetFrameScrubber() {
  _frameUrls = null;
  _frameCount = 0;
  _loadedFrames = {};
  _stripPath = '';
  const btn = document.getElementById('btnFrameScrub');
  if (btn) {
    btn.classList.remove('loading', 'done');
    btn.textContent = '[+]';
    btn.title = 'Generate frame thumbnails for hover preview';
  }
  const popup = document.getElementById('scrubPopup');
  if (popup) popup.style.display = 'none';
}
