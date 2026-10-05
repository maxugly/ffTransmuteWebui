/**
 * Canonical media URL builders + frame maths.
 *
 * One home for the frame/image/strip URL shapes that used to be inlined in a
 * dozen call sites, so the two conventions that actually bite are stated once:
 *
 *   - frame numbers are 1-BASED everywhere (`/api/thumbnail?frame=1` is the
 *     first frame; a strip is written with `-start_number 1`);
 *   - size is a LETTER class resolved to a max width server-side
 *     (L=120, M=240, H=480 — mirrors THUMBNAIL_SIZES in app/media/config.py).
 *
 * Note on caching: these frame URLs are stable for a given (path, frame, size)
 * and the server marks them `immutable`, so the browser will not revalidate
 * them if a file is replaced in place. That is pre-existing behaviour (the old
 * nonce was derived from the frame number, not the content) and is not
 * changed here.
 */

/** Size classes, cheapest first. Keep in sync with THUMBNAIL_SIZES. */
export const FRAME_SIZES = ['L', 'M', 'H'];

/** Max width in pixels per class. Display-only stills, never a match source. */
export const FRAME_WIDTHS = { L: 120, M: 240, H: 480 };

/** Human labels for the Settings knob. */
export const FRAME_SIZE_LABELS = ['Quarter', 'Half', 'Full'];

/** Clamp any incoming token to a real class. Mirrors normalize_thumb_size(). */
export function normalizeSize(size, fallback = 'M') {
  const value = String(size || '').toUpperCase();
  return FRAME_SIZES.indexOf(value) >= 0 ? value : fallback;
}

/** The clip the global frame range belongs to: pool's best input, else Media In. */
export function globalVideoPath() {
  try {
    if (typeof bestInput === 'function') {
      const fromBest = bestInput();
      if (fromBest && fromBest.trim()) return fromBest.trim();
    }
  } catch (_) { /* bestInput is a global that may not be booted yet */ }
  const gi = window.globalInputs || {};
  const first = String(gi.video || '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .find(Boolean);
  return first || '';
}

/**
 * Frame rate for the active clip, for mapping a frame number onto a time.
 *
 * `/api/probe` returns both `fps` (the container's *nominal* r_frame_rate) and
 * `fps_avg` (the real average from frame timestamps), and the timeline keeps the
 * whole probe body on `globalInputs._probeData`. The nominal rate is the one
 * every op uses, but it lies on VFR and badly tagged files — a 577-frame clip
 * tagged 60fps that actually plays at 24.02 — and a seek computed from it lands
 * the frame 2.5x away. So: prefer the average when the two disagree materially,
 * fall back to frames/duration, then to the nominal rate, then 24.
 */
export function isVfrClip(meta) {
  if (!meta) return 'unknown';
  const nominal = parseFloat(meta.fps) || 0;
  const average = parseFloat(meta.fps_avg) || 0;
  if (nominal > 0 && average > 0) {
    return Math.abs(average - nominal) / Math.max(nominal, 1e-9) > 0.01 ? 'vfr' : 'cfr';
  }
  return 'unknown';
}

export function globalFps(path) {
  const gi = window.globalInputs || {};
  const data = gi._probeData;
  if (!data || (path && gi._lastProbedPath !== path)) return 24;

  const sane = (n) => n > 0 && n <= 1000;
  const nominal = parseFloat(data.fps) || 0;
  const average = parseFloat(data.fps_avg) || 0;
  if (sane(nominal) && sane(average)) {
    // 1% tolerance: identical for CFR, and keeps tiny rounding noise from
    // overriding a trustworthy nominal rate.
    return Math.abs(nominal - average) / Math.max(nominal, 1e-9) > 0.01 ? average : nominal;
  }
  if (sane(average)) return average;

  const frames = parseInt(data.true_frames || data.frames, 10) || 0;
  const duration = parseFloat(data.duration) || 0;
  if (frames > 0 && duration > 0) {
    const derived = frames / duration;
    if (sane(derived)) return derived;
  }
  return sane(nominal) ? nominal : 24;
}

/**
 * 1-based frame → seconds. Same formula the server-side frame extractor uses
 * (app/media/thumbnails.py: n0 = n - 1; t = n0 / fps) so a seek and an
 * extracted still of the same frame never disagree.
 */
export function frameToSeconds(frame1, fps) {
  const n = Math.max(1, parseInt(frame1, 10) || 1);
  const rate = parseFloat(fps) > 0 ? parseFloat(fps) : 24;
  return (n - 1) / rate;
}

/** On-demand single-frame JPEG, 1-based. Cached on disk per (hash, frame, size). */
export function frameThumbUrl(path, frame1, size = 'M') {
  if (!path) return '';
  const n = Math.max(1, parseInt(frame1, 10) || 1);
  return `/api/thumbnail?path=${encodeURIComponent(path)}&frame=${n}&s=${normalizeSize(size)}`;
}

/**
 * A frame out of an extracted strip. The strip is written with
 * `-start_number 1`, so frame n is index n-1 — no percentage guessing.
 */
export function frameStripUrl(hash, frame1, size = 'M') {
  if (!hash) return '';
  const n = Math.max(1, parseInt(frame1, 10) || 1);
  const file = `frame_${String(n).padStart(6, '0')}_${normalizeSize(size)}.jpg`;
  return `/media/frame-strip/${encodeURIComponent(hash)}/${file}`;
}
