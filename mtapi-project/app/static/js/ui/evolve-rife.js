/**
 * Shared Evolve + RIFE chrome for DeepDream / Style Transfer / future strip→video ops.
 * Also exports generic RIFE model <select> helpers for other tabs (rife, imagesort, …).
 *
 * idPrefix examples: "dreamEvolve", "stEvolve"
 * Produces element ids: `${idPrefix}Rife`, `${idPrefix}Mult`, …
 * API body keys: evolve_use_rife, evolve_rife_multiplier, …
 */
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

/** Canonical rife-ncnn-vulkan model list (value + short label). */
export const RIFE_MODELS = [
  { value: 'rife-v4.6', label: 'rife-v4.6' },
  { value: 'rife-v4', label: 'rife-v4' },
  { value: 'rife-v2.4', label: 'rife-v2.4' },
  { value: 'rife-v2.3', label: 'rife-v2.3' },
];

/**
 * <option> list for RIFE model selects.
 * @param {string} [selected='rife-v4.6']
 * @param {Record<string, string>} [extraLabels]  optional longer labels by value
 */
export function rifeModelOptionsHtml(selected, extraLabels) {
  const sel = selected || 'rife-v4.6';
  const extra = extraLabels || {};
  return RIFE_MODELS.map((m) => {
    const lab = extra[m.value] || m.label;
    const isSel = m.value === sel ? ' selected' : '';
    return `<option value="${m.value}"${isSel}>${lab}</option>`;
  }).join('');
}

/**
 * Generic RIFE model form-row.
 * @param {string} selectId  e.g. "rifeModel", "isRifeModel"
 * @param {{ label?: string, selected?: string, extraLabels?: Record<string,string>, rowId?: string }} [opts]
 */
export function rifeModelSelectHtml(selectId, opts) {
  opts = opts || {};
  const label = opts.label != null ? opts.label : 'RIFE model';
  const rowId = opts.rowId ? ` id="${opts.rowId}"` : '';
  return `
    <div class="form-row"${rowId}>
      <label for="${selectId}">${label}</label>
      <select id="${selectId}">${rifeModelOptionsHtml(opts.selected, opts.extraLabels)}</select>
    </div>`;
}

/**
 * Model <select> row for evolve panels (ids: `${idPrefix}RifeModel`).
 * @param {string} idPrefix
 */
export function evolveRifeModelSelectHtml(idPrefix) {
  return rifeModelSelectHtml(`${idPrefix}RifeModel`, { label: 'RIFE model' });
}

/**
 * Knob units for RIFE on/off, ×, TTA, UHD, optional save stills.
 * Callers may insert extra knobs before/after this string inside a knob-bank.
 * @param {string} idPrefix
 * @param {{ includeStills?: boolean, rifeDefault?: string, multDefault?: string }} [opts]
 */
export function evolveRifeKnobUnitsHtml(idPrefix, opts) {
  opts = opts || {};
  const rifeDef = opts.rifeDefault != null ? opts.rifeDefault : '0';
  const multDef = opts.multDefault != null ? opts.multDefault : '2';
  let html = `
    ${knobUnitHtml({ id: `${idPrefix}Rife`, label: 'RIFE', value: rifeDef, binary: true, leftCap: 'Off', rightCap: 'On' })}
    ${knobUnitHtml({ id: `${idPrefix}Mult`, label: 'RIFE ×', value: multDef })}
    ${knobUnitHtml({ id: `${idPrefix}Tta`, label: 'TTA', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
    ${knobUnitHtml({ id: `${idPrefix}Uhd`, label: 'UHD', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
  `;
  if (opts.includeStills !== false) {
    html += knobUnitHtml({
      id: `${idPrefix}Stills`, label: 'Save stills', value: '0',
      binary: true, leftCap: 'No', rightCap: 'PNGs',
    });
  }
  return html;
}

/**
 * Wire binary/continuous knobs for shared RIFE evolve fields.
 * Missing DOM (e.g. stills when includeStills:false) is skipped safely.
 * @param {string} idPrefix
 * @param {{ rifeDefault?: string }} [opts]
 */
export function setupEvolveRifeKnobs(idPrefix, opts) {
  opts = opts || {};
  const rifeInit = opts.rifeDefault != null ? opts.rifeDefault : '0';
  setupBinaryKnob({
    knobId: `${idPrefix}RifeKnob`,
    indicatorId: `${idPrefix}RifeKnobInd`,
    hiddenId: `${idPrefix}Rife`,
    leftValue: '0', rightValue: '1', initial: rifeInit,
  });
  setupBinaryKnob({
    knobId: `${idPrefix}TtaKnob`,
    indicatorId: `${idPrefix}TtaKnobInd`,
    hiddenId: `${idPrefix}Tta`,
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: `${idPrefix}UhdKnob`,
    indicatorId: `${idPrefix}UhdKnobInd`,
    hiddenId: `${idPrefix}Uhd`,
    leftValue: '0', rightValue: '1', initial: '0',
  });
  // only present when evolveRifeKnobUnitsHtml(..., { includeStills: true })
  setupBinaryKnob({
    knobId: `${idPrefix}StillsKnob`,
    indicatorId: `${idPrefix}StillsKnobInd`,
    hiddenId: `${idPrefix}Stills`,
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupContinuousKnob({
    knobId: `${idPrefix}MultKnob`,
    indicatorId: `${idPrefix}MultKnobInd`,
    valueId: `${idPrefix}MultVal`,
    hiddenId: `${idPrefix}Mult`,
    min: 2, max: 128, step: 1, decimals: 0,
  });
}

/**
 * Read RIFE evolve fields for API body (evolve_use_rife, …).
 * @param {string} idPrefix
 */
export function collectEvolveRifeFields(idPrefix) {
  const g = (suf) => document.getElementById(`${idPrefix}${suf}`);
  return {
    evolve_use_rife: g('Rife')?.value === '1',
    evolve_rife_multiplier: parseInt(g('Mult')?.value || '2', 10),
    evolve_rife_model: g('RifeModel')?.value || 'rife-v4.6',
    evolve_rife_tta: g('Tta')?.value === '1',
    evolve_rife_uhd: g('Uhd')?.value === '1',
    evolve_save_stills: g('Stills')?.value === '1',
  };
}

/**
 * Master Evolve On/Off binary + show/hide panel(s).
 * Binary knobs dispatch `change` on the hidden input (see knobs.js).
 * @param {string} masterId  hidden input id e.g. dreamEvolve
 * @param {string} panelSelector  CSS selector e.g. '.dream-evolve-only'
 * @returns {() => void} sync — call after external value changes
 */
export function setupEvolveMasterToggle(masterId, panelSelector) {
  setupBinaryKnob({
    knobId: `${masterId}Knob`,
    indicatorId: `${masterId}KnobInd`,
    hiddenId: masterId,
    leftValue: '0', rightValue: '1', initial: '0',
  });
  const sync = () => {
    const on = document.getElementById(masterId)?.value === '1';
    document.querySelectorAll(panelSelector).forEach((el) => {
      el.classList.toggle('hidden', !on);
    });
  };
  document.getElementById(masterId)?.addEventListener('change', sync);
  sync();
  return sync;
}
