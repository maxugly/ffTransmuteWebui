/** CDP tool catalog (spec: docs/cdp-integration-spec.md §3, §9 Phase 2).
 *
 * Every menu leaf is data, not code. Phase 2 exposes the FULL vendored catalog:
 * all EFFECTS entries (232) as curated L3 leaves, plus raw CDP modes — both the
 * hand-listed raw entries below and the generic raw-program runner fed by the
 * verbatim usage text from the vendored man pages.
 *
 * `kind: 'effect'` entries take their params/label/blurb/category from EFFECTS
 * at runtime (never duplicated here). `kind: 'raw'` entries carry everything
 * locally; their argv may use `{p:'name'}` placeholders resolved from values.
 *
 * Adding a tool = adding data here. Never invent params: ranges and defaults
 * come from the pinned catalog (0.7.0).
 */

export const CDP_WASM_VERSION = '0.7.0';
export const CDP_VENDOR_URL = `/vendor/cdp-wasm-${CDP_WASM_VERSION}/src/index.js`;
export const CDP_MAN_URL = (program) =>
  `/vendor/cdp-wasm-${CDP_WASM_VERSION}/man/man1/cdp-${program}.1`;

/** Raw entries that are not in EFFECTS (spec §3.1 "All modes (raw)" seed +
 *  §9 Phase-2 pipeline primitives with explicit .ana types). */
export const CDP_RAW_TOOLS = [
  {
    id: 'pvoc.anal', kind: 'raw', program: 'pvoc', group: 'Spectral (raw)',
    label: 'pvoc anal — soundfile → spectral file',
    blurb: 'Phase-vocoder analysis: turns a WAV into a .ana spectral file that the spectral programs consume. The UI wraps this automatically for curated spectral tools; this raw entry is the pipeline conversion step. Mono input only (measured: stereo is refused — mix down first).',
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
  // Pipeline primitives: the raw spectral programs with explicit .ana I/O —
  // these are what a "pvoc anal → stretch → blur → synth" chain is built from.
  {
    id: 'raw.stretch.time', kind: 'raw', program: 'stretch', group: 'Spectral (raw)',
    label: 'stretch time (raw, .ana in/out)',
    blurb: 'Raw spectral time-stretch on a .ana file. The curated `stretch.time` wraps pvoc itself; this raw entry sits inside explicit analysis/resynthesis chains.',
    inExt: 'ana', outExt: 'ana', spectralWrap: false,
    argv: ['time', '1', '$IN', '$OUT', { p: 'factor' }],
    usage: 'stretch time 1 in.ana out.ana factor',
    params: [{ name: 'factor', label: 'Stretch ×', min: 0.25, max: 8, default: 2, step: 0.25, help: 'How much longer to make the sound. 2 is twice as long; the pitch stays the same.' }],
    tags: ['spectral', 'time', 'raw'],
  },
  {
    id: 'raw.blur.blur', kind: 'raw', program: 'blur', group: 'Spectral (raw)',
    label: 'blur blur (raw, .ana in/out)',
    blurb: 'Raw spectral blur on a .ana file — average spectral amplitudes over N windows. For explicit analysis/resynthesis chains.',
    inExt: 'ana', outExt: 'ana', spectralWrap: false,
    argv: ['blur', '$IN', '$OUT', { p: 'windows' }],
    usage: 'blur blur in.ana out.ana windows',
    params: [{ name: 'windows', label: 'Windows', min: 1, max: 100, default: 10, step: 1, help: 'How many successive analysis frames are averaged together.' }],
    tags: ['spectral', 'raw'],
  },
];

/** Merge the vendored EFFECTS catalog into menu entries.
 *
 * Returns `{ curated, raw, missing }`: `curated` is every EFFECTS entry
 * (Phase 2 full menu — 232), `raw` the hand-listed raw tools, `missing` ids
 * that drifted out of the vendored catalog (reported, never hidden).
 */
export function buildCatalog(effects) {
  const raw = CDP_RAW_TOOLS.map((t) => ({ params: [], mono: false, nondeterministic: false, ...t }));
  const curated = (effects || []).map((e) => ({
    id: e.id,
    kind: 'effect',
    program: e.program,
    label: e.label,
    blurb: e.blurb,
    group: e.category,
    params: e.params || [],
    mono: !!e.mono,
    args: e.args,
    inputs2: (e.inputs || 1) >= 2,
    nondeterministic: !!e.parityExempt,
    usage: usageFromEffect(e),
    spectral: e.domain === 'spectral',
  }));
  const rawIds = new Set(raw.map((t) => t.id));
  const missing = [];
  for (const id of ['pvoc.anal', 'pvoc.synth', 'sndinfo']) {
    if (!rawIds.has(id)) missing.push(id);
  }
  return { curated, raw, missing };
}

/** Back-compat helper used by the Phase-1 render path and tests. */
export function mergeTools(effects) {
  const { curated, raw, missing } = buildCatalog(effects);
  const wanted = ['modify.speed', 'modify.brassage', 'blur.blur', 'hilite.trace',
    'stretch.time', 'distort.overload', 'grain.omit', 'envel.dovetail'];
  const tools = curated.filter((t) => wanted.includes(t.id)).concat(raw);
  return { tools, missing };
}

/** Verbatim CDP usage shape from an EFFECTS entry: program + literal args +
 *  parameter names, with $IN/$OUT spelled as files. */
export function usageFromEffect(e) {
  const parts = [e.program, ...(e.args || [])].map((tok) => {
    if (typeof tok === 'string') {
      if (tok === '$IN') return 'in.wav';
      if (tok === '$IN2') return 'in2.wav';
      if (tok === '$OUT') return 'out.wav';
      return tok;
    }
    return tok && tok.p ? String(tok.p) : '?';
  });
  return parts.join(' ');
}

/** Live raw-argv preview: the exact argv the Worker passes, with values. */
export function argvPreview(tool, values) {
  const src = tool.kind === 'effect' ? (tool.args || []) : (tool.argv || []);
  const argv = [tool.kind === 'effect' ? tool.id.split('.')[0] : tool.program, ...src];
  return argv.map((tok) => {
    if (typeof tok === 'string') {
      if (tok === '$IN') return 'in.' + (tool.inExt || 'wav');
      if (tok === '$IN2') return 'in2.' + (tool.inExt || 'wav');
      if (tok === '$OUT') return 'out.' + (tool.outExt || 'wav');
      return tok;
    }
    if (tok && tok.p) return String(values[tok.p] ?? '');
    return '?';
  });
}

/** Extract CDP's own verbatim usage text from a vendored man page.
 *  Returns '' when the page is missing or shaped unexpectedly. */
export function parseManUsage(roff) {
  if (!roff) return '';
  const start = roff.indexOf("own usage text:");
  if (start < 0) return '';
  const block = roff.slice(start);
  const fi = block.indexOf('.fi');
  const lines = [];
  for (const line of block.slice(0, fi > 0 ? fi : undefined).split('\n').slice(1)) {
    const t = line.replace(/^\.(B |I |RI |PP |nf |br )*/, '').trim();
    if (t && !t.startsWith('.')) lines.push(t);
  }
  return lines.join('\n').trim();
}

/** Worker-side argv mapping shared with the preview: resolve {p} tokens. */
export function resolveArgv(argv, values) {
  return (argv || []).map((tok) => (tok && tok.p ? String(values[tok.p] ?? '') : tok));
}
