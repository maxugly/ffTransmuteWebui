/** CDP Phase-1 tool catalog (spec: docs/cdp-integration-spec.md §3.3, §9).
 *
 * Every menu leaf is data, not code. `kind: 'effect'` entries take their
 * params/label/blurb/category from the vendored cdp-wasm EFFECTS catalog at
 * runtime (never duplicated here — see mergeTools); `kind: 'raw'` entries are
 * the un-wrapped CDP modes the curated layer doesn't cover (pvoc pair, info
 * tool) and carry everything locally.
 *
 * Adding a Phase-2 tool = adding data here. Never invent params: ranges and
 * defaults come from the pinned catalog (0.7.0).
 */

export const CDP_WASM_VERSION = '0.7.0';
export const CDP_VENDOR_URL = `/vendor/cdp-wasm-${CDP_WASM_VERSION}/src/index.js`;

/** Phase-1 curated list (spec §9 "run ten tools well"). Covers both domains,
 *  one per family, mono-only programs included, zero data-file tools. */
export const CDP_TOOLS = [
  // ── curated (EFFECTS-backed) ────────────────────────────────────────────
  { id: 'modify.speed', kind: 'effect' },
  { id: 'modify.brassage', kind: 'effect' },
  { id: 'blur.blur', kind: 'effect' },
  { id: 'hilite.trace', kind: 'effect' },
  { id: 'stretch.time', kind: 'effect' },
  { id: 'distort.overload', kind: 'effect' },
  { id: 'grain.omit', kind: 'effect' },
  { id: 'envel.dovetail', kind: 'effect' },

  // ── raw CDP modes (not in EFFECTS; §3.1 "All modes (raw)" seed) ─────────
  {
    id: 'pvoc.anal', kind: 'raw', program: 'pvoc', group: 'Spectral (raw)',
    label: 'pvoc anal — soundfile → spectral file',
    blurb: 'Phase-vocoder analysis: turns a WAV into a .ana spectral file that the spectral programs consume. The UI wraps this automatically for curated spectral tools; this raw entry is here for inspection and hand-built chains. Mono input only (measured: stereo is refused — mix down first).',
    inExt: 'wav', outExt: 'ana', spectralWrap: false, mono: true,
    argv: ['anal', '1', '$IN', '$OUT'],
    usage: 'pvoc anal 1 in.wav out.ana',
    tags: ['spectral', 'analysis', 'raw'],
  },
  {
    id: 'pvoc.synth', kind: 'raw', program: 'pvoc', group: 'Spectral (raw)',
    label: 'pvoc synth — spectral file → soundfile',
    blurb: 'Phase-vocoder resynthesis: turns a .ana spectral file back into a listenable WAV.',
    inExt: 'ana', outExt: 'wav', spectralWrap: false,
    argv: ['synth', '$IN', '$OUT'],
    usage: 'pvoc synth in.ana out.wav',
    tags: ['spectral', 'resynthesis', 'raw'],
  },
  {
    id: 'sndinfo', kind: 'info', program: 'sndinfo', group: 'Analysis (raw)',
    label: 'sndinfo — soundfile properties',
    blurb: 'Prints sample rate, channels, duration and sample format of a soundfile to text. Output is an inspectable artifact, not audio.',
    inExt: 'wav', outExt: null, spectralWrap: false,
    usage: 'sndinfo in.wav',
    tags: ['analysis', 'info', 'raw'],
  },
];

/** Merge CDP_TOOLS with the vendored EFFECTS catalog. Curated entries inherit
 *  label/blurb/category/params/mono from EFFECTS; a missing id means the
 *  vendored package and this list have drifted — it is reported, not hidden. */
export function mergeTools(effects) {
  const byId = new Map(effects.map((e) => [e.id, e]));
  const merged = [];
  const missing = [];
  for (const t of CDP_TOOLS) {
    if (t.kind === 'effect') {
      const e = byId.get(t.id);
      if (!e) { missing.push(t.id); continue; }
      merged.push({
        ...t,
        label: e.label,
        blurb: e.blurb,
        group: e.category,
        params: e.params || [],
        mono: !!e.mono,
        args: e.args,
        nondeterministic: !!e.parityExempt,
        usage: usageFromEffect(e),
      });
    } else {
      merged.push({ params: [], mono: false, nondeterministic: false, ...t });
    }
  }
  return { tools: merged, missing };
}

/** Verbatim CDP usage shape from an EFFECTS entry: program + literal args +
 *  parameter names, with $IN/$OUT spelled as files. */
export function usageFromEffect(e) {
  const parts = [e.program, ...(e.args || [])].map((tok) => {
    if (typeof tok === 'string') {
      if (tok === '$IN') return 'in.wav';
      if (tok === '$OUT') return 'out.wav';
      return tok;
    }
    return tok && tok.p ? String(tok.p) : '?';
  });
  return parts.join(' ');
}

/** Live raw-argv preview: the exact argv the Worker passes, with values. */
export function argvPreview(tool, values) {
  const src = tool.kind === 'effect'
    ? (tool.args || [])
    : (tool.argv || []);
  const argv = [tool.kind === 'effect' ? tool.id.split('.')[0] : tool.program, ...src];
  return argv.map((tok) => {
    if (typeof tok === 'string') return tok;
    if (tok && tok.p) return String(values[tok.p] ?? '');
    return '?';
  });
}
