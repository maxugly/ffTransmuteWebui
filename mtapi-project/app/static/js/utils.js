import { VIDEO_EXTS } from '/js/pool/constants.js';

function isVideoPath(path) {
  if (!path) return false;
  const lower = path.toLowerCase();
  return VIDEO_EXTS.some(ext => lower.endsWith(ext));
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

export { isVideoPath, basename, formatDurationExact, escapeHtml };
