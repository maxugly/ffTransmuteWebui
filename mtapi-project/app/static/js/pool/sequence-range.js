// Sequence clip-range math — PURE module (zero imports, no DOM) so it can be
// unit tested with plain node (see tests/test_sequence_range.mjs).
//
// A range is a 1-based, inclusive clip window over the Sequence strip
// ("render clip 34 → clip 56"). It scopes the Sequence RENDER (Stitch) only:
// Instant RIFE / Erase keep covering the whole sequence (spec §2.5).
//
// The range NEVER mutates the sequence or the project — it only chooses which
// clips the render consumes, so a sub-range render never needs a second
// project file.

/** True when a bound is unset (blank input). */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * Parse one range bound.
 * @param {*} raw  number | string | null | undefined
 * @returns {{ value: number|null, error: string|null }}
 */
export function parseRangeBound(raw) {
  if (isBlank(raw)) return { value: null, error: null };
  let n = raw;
  if (typeof n === 'string') {
    const t = n.trim();
    if (!/^\d+$/.test(t)) return { value: null, error: 'must be a whole number' };
    n = Number(t);
  } else {
    n = Number(n);
    if (!Number.isFinite(n)) return { value: null, error: 'must be a number' };
  }
  if (n < 1) return { value: null, error: 'must be 1 or more' };
  return { value: Math.floor(n), error: null };
}

/**
 * Resolve a range against the current sequence length.
 *
 * @param {{from?: *, to?: *}} range  raw bounds (numbers or strings; null = unset)
 * @param {number} count             number of clips in the sequence
 * @returns {{
 *   active: boolean, from: number|null, to: number|null, total: number,
 *   count: number, error: string|null, note: string, clipped: boolean
 * }}
 *   `active` = a bound was supplied (it may still be invalid → `error`).
 *   `count`  = clips inside the effective window (0 when `error`).
 */
export function resolveRange(range, count) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const r = (range && typeof range === 'object') ? range : {};
  const rawFrom = r.from ?? null;
  const rawTo = r.to ?? null;
  const from = parseRangeBound(rawFrom);
  const to = parseRangeBound(rawTo);
  const active = !isBlank(rawFrom) || !isBlank(rawTo);

  const out = {
    active,
    from: null,
    to: null,
    total,
    count: total,
    error: null,
    note: '',
    clipped: false,
  };
  if (!active) return out; // whole sequence
  if (from.error) return { ...out, error: `From clip ${from.error}` };
  if (to.error) return { ...out, error: `To clip ${to.error}` };
  if (total === 0) return { ...out, error: 'Sequence is empty' };

  const start = from.value ?? 1;
  if (start > total) {
    return { ...out, error: `From clip ${start} is past the last clip (${total})` };
  }
  let end = to.value ?? total;
  let clipped = false;
  let note = '';
  if (end > total) {
    end = total;
    clipped = true;
    note = `To clamped to ${total} (last clip)`;
  }
  if (end < start) {
    return { ...out, error: `From clip ${start} is after To clip ${end}` };
  }
  return { ...out, from: start, to: end, count: end - start + 1, clipped, note };
}

/**
 * Clip list a render would consume.
 * @returns {{ entries: any[], resolved: ReturnType<typeof resolveRange> }}
 */
export function sliceRange(range, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const resolved = resolveRange(range, list.length);
  if (resolved.error) return { entries: [], resolved };
  if (!resolved.active) return { entries: list, resolved };
  return { entries: list.slice(resolved.from - 1, resolved.to), resolved };
}

/** Clips a render would consume (0 when the range cannot be used). */
export function rangeClipCount(resolved) {
  if (!resolved || resolved.error) return 0;
  return resolved.count;
}

/** True when the 1-based clip index is inside the effective window. */
export function rangeIncludes(resolved, index1Based) {
  if (!resolved || !resolved.active || resolved.error) return true;
  const i = Number(index1Based);
  if (!Number.isFinite(i)) return true;
  return i >= resolved.from && i <= resolved.to;
}

/** "34–56" (empty when no range is active or the range is invalid). */
export function rangeLabel(resolved) {
  if (!resolved || !resolved.active || resolved.error) return '';
  return `${resolved.from}–${resolved.to}`;
}

/** One-line status for the range control. */
export function rangeHint(resolved) {
  if (!resolved) return '';
  if (resolved.error) return resolved.error;
  if (!resolved.active) return `All ${resolved.total} clips`;
  const note = resolved.note ? ` · ${resolved.note}` : '';
  const plural = resolved.count === 1 ? 'clip' : 'clips';
  return `Clips ${resolved.from}–${resolved.to} of ${resolved.total} · ${resolved.count} ${plural}${note}`;
}
