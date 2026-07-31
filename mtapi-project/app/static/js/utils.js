import { VIDEO_EXTS, IMAGE_EXTS } from '/js/pool/constants.js';

function isVideoPath(path) {
  if (!path) return false;
  const lower = path.toLowerCase();
  return VIDEO_EXTS.some(ext => lower.endsWith(ext));
}

function isImagePath(path) {
  if (!path) return false;
  const lower = path.toLowerCase();
  return IMAGE_EXTS.some(ext => lower.endsWith(ext));
}

function basename(path) {
  if (!path) return '';
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.substring(i + 1) : path;
}

function formatDurationExact(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const s = Math.max(0, Number(seconds));
  if (s < 60) return `${s.toFixed(3)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (m < 60) return `${m}m ${rem.toFixed(3)}s`;
  const h = Math.floor(m / 60);
  const mins = m % 60;
  return `${h}h ${mins}m ${rem.toFixed(3)}s`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Global timeline selection (1-based inclusive). Used by video-pipeline ops. */
function globalFrameRange() {
  const gi = window.globalInputs || {};
  let s = parseInt(gi.frameStart, 10);
  let e = parseInt(gi.frameEnd, 10);
  if (!Number.isFinite(s) || s < 1) s = 1;
  if (!Number.isFinite(e) || e < s) e = 999999;
  return { start_frame: s, end_frame: e };
}

function withFrameRange(body) {
  return Object.assign({}, body, globalFrameRange());
}

export { isVideoPath, isImagePath, basename, formatDurationExact, escapeHtml, globalFrameRange, withFrameRange };
