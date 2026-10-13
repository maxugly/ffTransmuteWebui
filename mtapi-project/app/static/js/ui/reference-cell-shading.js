// Stable comparison colors use the complete catalog, never the filtered rows.
const neutral = /^(?:[-–—]|n\/?a|not supplied|not disclosed|not published|unknown|unspecified)?$/i;
const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const warning = /⚠|\b(?:warn(?:ing)?s?|caution|beware|risks?|restrictions?|restricted|non[- ]?commercial|research[- ]only|unverified|conflicts?|unsupported|incompatib\w*|inactive|legacy|deprecated|experimental|bugs?|limitations?|leakage|uncertain|inaccurate)\b|\bcc[- ]by[- ]nc\b|\bnot (?:supported|commercially|a turnkey|working|for commercial)\b/i;

export function numericCell(value) {
  // Only a scalar or one range, optionally with a known unit. Do not extract
  // incidental numbers from model names, dates, URLs, benchmarks or prose.
  const text = normalize(value).replace(/,/g, '');
  const match = text.match(/^(?:~|≈|about\s+|approximately\s+)?([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-z%]*)(?:\s*[–—-]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-z%]*))?(?:\s+(parameters?|params?|vram|languages?|voices?))?$/);
  if (!match) return null;
  let [, first, firstUnit, last, lastUnit, label = ''] = match;
  if (last && !firstUnit) firstUnit = lastUnit;
  if (last && !lastUnit) lastUnit = firstUnit;
  const units = {
    '':['quantity',1], k:['quantity',1e3], m:['quantity',1e6], b:['quantity',1e9], t:['quantity',1e12],
    kb:['bytes',1e3], mb:['bytes',1e6], gb:['bytes',1e9], tb:['bytes',1e12], byte:['bytes',1], bytes:['bytes',1],
    ms:['duration',.001], s:['duration',1], sec:['duration',1], second:['duration',1], seconds:['duration',1],
    min:['duration',60], minute:['duration',60], minutes:['duration',60],
    hz:['frequency',1], khz:['frequency',1e3], mhz:['frequency',1e6], '%':['percent',1],
    parameter:['quantity',1], parameters:['quantity',1], param:['quantity',1], params:['quantity',1],
    language:['languages',1], languages:['languages',1], voice:['voices',1], voices:['voices',1],
  };
  const start = units[firstUnit], end = last ? units[lastUnit] : start;
  if (!start || !end || start[0] !== end[0]) return null;
  let group = start[0];
  if (/^languages?$/.test(label) && group === 'quantity') group = 'languages';
  if (/^voices?$/.test(label) && group === 'quantity') group = 'voices';
  if (label === 'vram' && group !== 'bytes') return null;
  const number = last ? (Number(first)*start[1] + Number(last)*end[1])/2 : Number(first)*start[1];
  return {number, group, range:Boolean(last)};
}

export function cellState(value) {
  const text = normalize(value);
  if (neutral.test(text)) return 'neutral';
  if (/(?:yes\s*[/|]\s*no|✅\s*[/|]\s*❌)/.test(text)) return 'partial';
  if (/\b(?:conditional|depends|depending)\b|\bonly (?:if|with)\b/.test(text)) return 'conditional';
  if (/^(?:conditional|depends|maybe|limited|experimental)(?:\b|$)/.test(text)) return 'conditional';
  if (/^(?:partial|partially|mixed|sometimes)(?:\b|$)/.test(text)) return 'partial';
  if (/^(?:yes|y|true|supported|available)(?:\b|$)|^(?:✅|✔|✓)/.test(text)) return 'yes';
  if (/^(?:no|n|false|unsupported)(?:\b|$)|^(?:❌|✗|✘)/.test(text)) return 'no';
  return null;
}

function hueFor(text) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return [185,210,240,270,300,155,35][(hash >>> 0) % 7];
}

export function createCellShading(columns, rows) {
  const repeated = new Map();
  const ranges = columns.map(() => new Map());
  for (const row of rows) row.forEach((value, index) => {
    if (index === 0) return;
    const text = normalize(value);
    if (!neutral.test(text)) repeated.set(text, (repeated.get(text) || 0) + 1);
    const numeric = numericCell(value);
    if (!numeric) return;
    const range = ranges[index].get(numeric.group) || {min:Infinity,max:-Infinity};
    range.min = Math.min(range.min, numeric.number);
    range.max = Math.max(range.max, numeric.number);
    ranges[index].set(numeric.group, range);
  });
  return (value, index) => {
    const text = normalize(value);
    if (index === 0 || neutral.test(text)) return {kind:'neutral',label:'Unshaded'};
    if (/^(?:limits|warnings|caveats)\b/i.test(columns[index]) || warning.test(text)) {
      return {kind:'warning',label:'Warning / limitation'};
    }
    const state = cellState(value);
    if (state) return {kind:state,label:{yes:'Yes / supported',no:'No / unsupported',partial:'Partial',conditional:'Conditional'}[state]};
    const numeric = numericCell(value);
    if (numeric) {
      const range = ranges[index].get(numeric.group);
      if (range.max > range.min) {
        const fraction = (numeric.number-range.min)/(range.max-range.min);
        return {kind:'numeric',hue:220-170*fraction,
          label:`Numeric scale within this column (${numeric.group}): ${range.min}–${range.max}${numeric.range ? '; range midpoint' : ''}. Higher means larger, not better.`};
      }
    }
    if ((repeated.get(text) || 0) > 1) return {kind:'repeat',hue:hueFor(text),label:`Repeated value (${repeated.get(text)} cells in the full catalog)`};
    return {kind:'neutral',label:'Unique text; unshaded'};
  };
}
