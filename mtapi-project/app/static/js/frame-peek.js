/**
 * Global frame peek — show the frame you are setting, while you set it.
 *
 * Drag or step the In / Out point of the global frame range and the media
 * preview shows that exact frame. The primary path is what a normal video
 * player does: seek the <video> already in the preview panel. `/api/video` is a
 * FileResponse (honours Range), so `currentTime = (frame - 1) / fps` costs
 * nothing — no ffmpeg, no server work, and it is the video's own resolution.
 *
 * Sources, in order:
 *   1. player seek   — the panel is showing the clip being trimmed
 *   2. auto-load     — the panel is empty, so load the clip then seek
 *   3. strip still   — `[+]` already extracted it, served from cache
 *   4. frame extract — on demand, one cheap `-ss` + single frame, disk-cached
 *
 * Gated by state.settings.globalFramePeek; size for 3/4 by
 * state.settings.framePeekSize (L/M/H = 120/240/480 px).
 *
 * The extracted strip is an ACCELERATOR, never a gate. Clips over the strip
 * limit still scrub, because paths 1 and 2 do not need frames on disk.
 */
import { state, elements } from '/app.js?v=2';
import { showPreview } from '/js/preview.js?v=2';
import {
  globalVideoPath, globalFps, frameToSeconds, frameThumbUrl, frameStripUrl,
  normalizeSize, FRAME_WIDTHS,
} from '/js/media-urls.js?v=2';

// ── state ───────────────────────────────────────────────────────────────────

let _armed = false;        // a set-point is being set right now
let _armEnd = 'start';     // which point is live: 'start' | 'end'
let _pointerDown = false;  // a real drag/press is holding the peek open
let _idleTimer = null;     // keyboard/stepper grace before disarming
let _pending = null;       // { path, frame } waiting on loadedmetadata
let _strip = null;         // { path, hash, count, size } from `[+]`
let _warmed = new Set();   // strip URLs already preloaded
const PREWARM = 10;
const IDLE_MS = 1200;

function peekEnabled() {
  return state?.settings?.globalFramePeek !== false;
}

function peekSize() {
  return normalizeSize(state?.settings?.framePeekSize, 'M');
}

function currentFrame() {
  const gi = window.globalInputs || {};
  const raw = _armEnd === 'end' ? gi.frameEnd : gi.frameStart;
  return Math.max(1, parseInt(raw, 10) || 1);
}

// ── preview panel plumbing ──────────────────────────────────────────────────

function viewerVideo() {
  return elements?.mediaViewer ? elements.mediaViewer.querySelector('video') : null;
}

function shownPath() {
  return (elements?.mediaPath?.textContent || '').trim();
}

/** True when the panel holds no real media — safe to auto-load into. */
function previewIsEmpty() {
  const viewer = elements?.mediaViewer;
  if (!viewer) return true;
  if (viewer.querySelector('video, img, audio')) return false;
  // A running job owns the panel (Live preview frame, dry-run placeholder).
  // Do not wipe what an operation is showing.
  if (state?.previewLive) return false;
  try {
    if (typeof activeJob !== 'undefined' && activeJob && activeJob.token) return false;
  } catch (_) { /* ignore */ }
  return true;
}

/** The sequence transport owns its own element — never pause it behind the UI. */
function isSequencePlayer(video) {
  if (!video) return false;
  const pb = state?.pool?.playback;
  return !!pb && pb.video === video;
}

// ── the player seek (free) ──────────────────────────────────────────────────

function seekTo(path, frame) {
  const video = viewerVideo();
  if (isSequencePlayer(video)) return false;
  if (!video) {
    if (!previewIsEmpty()) return false;
    showPreview(path);          // showPreview writes #mediaPath before appending
    const fresh = viewerVideo();
    return fresh ? seekTo(path, frame) : false;
  }
  // The panel is showing something else (an op output, another pool card).
  // Scrubbing that would be a lie, so fall through to a still instead.
  if (shownPath() !== path) return false;

  const seconds = frameToSeconds(frame, globalFps(path));
  if (video.readyState < 1) {
    // Metadata not in yet — a seek now is dropped by the browser.
    _pending = { path, frame };
    video.addEventListener('loadedmetadata', () => {
      const todo = _pending;
      _pending = null;
      if (todo && todo.path === shownPath()) seekTo(todo.path, todo.frame);
    }, { once: true });
    return true;
  }
  try { video.pause(); } catch (_) { /* ignore */ }
  if (Math.abs((video.currentTime || 0) - seconds) > 0.0005) video.currentTime = seconds;
  return true;
}

// ── the still overlay (fallback) ────────────────────────────────────────────

function stripStill(path, frame) {
  if (!_strip || _strip.path !== path || _strip.size !== peekSize()) return '';
  if (frame > _strip.count) return '';
  const url = frameStripUrl(_strip.hash, frame, _strip.size);
  if (!url) return '';
  prewarm(frame);
  return url;
}

function prewarm(frame) {
  for (let n = Math.max(1, frame - PREWARM); n <= Math.min(_strip.count, frame + PREWARM); n++) {
    const url = frameStripUrl(_strip.hash, n, _strip.size);
    if (!url || _warmed.has(url)) continue;
    _warmed.add(url);
    const img = new Image();
    img.src = url;
  }
}

function showStill(url, frame) {
  const popup = document.getElementById('scrubPopup');
  const img = document.getElementById('scrubPopupImg');
  const cap = document.getElementById('scrubPopupCap');
  if (!popup || !img) return;
  // Assign once per URL. Never clear src — a cleared img is a black flash.
  if (img.getAttribute('src') !== url) img.setAttribute('src', url);
  if (cap) cap.textContent = `${_armEnd === 'end' ? 'Out' : 'In'} · frame ${frame}`;
  popup.style.display = '';
}

function hideStill() {
  const popup = document.getElementById('scrubPopup');
  if (popup && popup.style.display !== 'none') popup.style.display = 'none';
  const cap = document.getElementById('scrubPopupCap');
  if (cap) cap.textContent = '';
}

// ── paint ───────────────────────────────────────────────────────────────────

function paint() {
  if (!_armed || !peekEnabled()) return;
  const path = globalVideoPath();
  if (!path) { hideStill(); return; }
  const frame = currentFrame();
  if (seekTo(path, frame)) { hideStill(); return; }
  const url = stripStill(path, frame) || frameThumbUrl(path, frame, peekSize());
  if (url) showStill(url, frame);
  else hideStill();
}

// ── arm / disarm ────────────────────────────────────────────────────────────

function clearIdle() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}

function arm(end) {
  _armed = true;
  if (end) _armEnd = end;
  clearIdle();
}

function armIdle(end) {
  arm(end);
  clearIdle();
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    _armed = false;
    hideStill();
  }, IDLE_MS);
}

function disarm() {
  clearIdle();
  _armed = false;
  _pointerDown = false;
  // The player path deliberately leaves the video seeked and paused: the frame
  // you just set stays on screen so you can judge it. The still overlay is a
  // stand-in for that video, so it goes when you let go.
  hideStill();
}

function endForNode(node) {
  return node === document.getElementById('giTimelineEnd') ? 'end' : 'start';
}

// ── setup ───────────────────────────────────────────────────────────────────

export function setupFramePeek() {
  const row = document.getElementById('giFramesRow');
  const startThumb = document.getElementById('giTimelineStart');
  const endThumb = document.getElementById('giTimelineEnd');
  const btn = document.getElementById('btnFrameScrub');
  if (!row || !startThumb || !endThumb) return;

  // Pointer: the drag itself, the window slide, and the stepper hold-repeat.
  ['pointerdown', 'mousedown', 'touchstart'].forEach((type) => {
    row.addEventListener(type, (e) => {
      _pointerDown = true;
      arm(endForNode(e.target));
      paint();
    }, { passive: true });
  });
  window.addEventListener('pointerup', disarm);
  window.addEventListener('pointercancel', disarm);

  // Focus + keyboard: arrows, Home/End on a thumb, typing in the value box.
  row.addEventListener('focusin', (e) => {
    if (_pointerDown) { arm(endForNode(e.target)); paint(); return; }
    armIdle(endForNode(e.target));
    paint();
  });
  row.addEventListener('keydown', (e) => {
    if (_pointerDown) { arm(endForNode(e.target)); paint(); return; }
    armIdle(endForNode(e.target));
    paint();
  });
  row.addEventListener('focusout', () => { if (_armed && !_pointerDown) armIdle(null); });

  // One event covers every path that moves a set-point: thumb input, the blue
  // window drag (which dispatches no `input`), the steppers, and text commit.
  document.addEventListener('mtapi:frame-range', () => {
    if (!_armed) return;
    // A press focuses the control, which arms the idle grace. A slow drag can
    // outlive it, so a held pointer keeps the peek open instead of dropping it.
    if (_pointerDown) arm(null);
    paint();
  });

  // A new clip invalidates the strip — the old `[+]` bound to `#giVideo`,
  // which the unified Media In bar (8.098) deleted, so it never reset.
  const mediaIn = document.getElementById('giMediaIn');
  if (mediaIn) {
    mediaIn.addEventListener('input', () => {
      if (globalVideoPath() !== (_strip && _strip.path)) resetFramePeek();
    });
  }
  document.addEventListener('mtapi:video-probed', (e) => {
    const path = (e.detail && e.detail.path) || '';
    if (_strip && path && path !== _strip.path) resetFramePeek();
  });

  if (btn) btn.addEventListener('click', () => fetchFrameStrip(btn));
}

// ── `[+]` optional strip extraction ─────────────────────────────────────────

async function fetchFrameStrip(btn) {
  const path = globalVideoPath();
  if (!path) return;
  const size = peekSize();

  btn.classList.add('loading');
  btn.textContent = '...';
  _strip = null;
  _warmed = new Set();

  try {
    const res = await fetch('/media/frame-strip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, s: size }),
    });
    const data = await res.json();
    if (data.ok && data.hash) {
      _strip = { path, hash: data.hash, count: data.frame_count || 0, size: data.size || size };
      btn.classList.remove('loading');
      btn.classList.add('done');
      btn.textContent = '✓';
      btn.setAttribute('data-help-title',
        `${_strip.count} frame stills at ${size} (${FRAME_WIDTHS[size]}px wide)`
        + (data.cached ? ' · cached' : ''));
    } else {
      btn.classList.remove('loading');
      btn.textContent = '[x]';
      btn.setAttribute('data-help-title', data.error || 'Failed to extract frames');
      console.warn('frame-peek:', data.error);
    }
  } catch (err) {
    btn.classList.remove('loading');
    btn.textContent = '[x]';
    btn.setAttribute('data-help-title', 'Network error');
    console.error('frame-peek:', err);
  }
}

export function resetFramePeek() {
  _strip = null;
  _warmed = new Set();
  _pending = null;
  _pointerDown = false;
  clearIdle();
  _armed = false;
  const btn = document.getElementById('btnFrameScrub');
  if (btn) {
    btn.classList.remove('loading', 'done');
    btn.textContent = '[+]';
    btn.setAttribute('data-help-title', 'Optional: extract frame stills for faster scrubbing (clips ≤500 frames)');
  }
  hideStill();
}
