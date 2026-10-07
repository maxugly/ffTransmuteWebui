/** CDP linear pipeline model (spec: docs/cdp-integration-spec.md §5.2–5.4).
 *
 * A pipeline = ordered steps[], rendered sequentially (render-then-feed).
 * The bytes flow through the Worker in memory; each completed step's artifact
 * is POSTed to the server (disk is the store of record, §5.3). Types are
 * explicit: 'wav' | 'ana' — a step whose inExt doesn't match the current
 * type is refused with the concrete fix, never silently converted (§4.1).
 *
 * Schema-versioned save/load (§5.4): re-runs never overwrite prior outputs —
 * the server allocates fresh names each run.
 */
export const PIPELINE_SCHEMA = 'mtapi-cdp-pipeline/1';

let uidSeq = 0;
export function newUid() { return `s${Date.now().toString(36)}_${++uidSeq}`; }

export function newPipeline() {
  return {
    schema: PIPELINE_SCHEMA,
    name: 'Untitled pipeline',
    inputPath: '',
    input2Path: '',
    steps: [],
  };
}

export function newStep(tool) {
  return {
    uid: newUid(),
    toolId: tool.id,
    kind: tool.kind,
    values: Object.fromEntries((tool.params || []).map((p) => [p.name, p.default])),
    enabled: true,
    note: '',
  };
}

/** File type a step consumes ('wav' | 'ana' | null for info). */
export function stepInType(tool) {
  if (tool.kind === 'effect') return 'wav';
  return tool.inExt || null;
}
export function stepOutType(tool) {
  if (tool.kind === 'effect') return 'wav';
  return tool.outExt || null;
}

/** Validate the chain end-to-end against the pipeline input type.
 *  Returns { ok, errors: [{index, message}] }. Disabled steps are skipped. */
export function validatePipeline(pipeline, toolsById, { hasInput2 = false } = {}) {
  const errors = [];
  let type = 'wav'; // pipeline input is the canonical prepared WAV
  let seen = 0;
  (pipeline.steps || []).forEach((step, i) => {
    const tool = toolsById.get(step.toolId);
    if (!tool) {
      errors.push({ index: i, message: `unknown tool ${step.toolId} — re-add the step` });
      return;
    }
    if (!step.enabled) return;
    if (tool.kind === 'info') {
      errors.push({ index: i, message: 'info tools produce text, not audio — they cannot sit in a chain' });
      return;
    }
    const inType = stepInType(tool);
    if (inType !== type) {
      errors.push({
        index: i,
        message: `expects .${inType} but the chain provides .${type} — ${type === 'wav' ? 'insert pvoc anal' : 'insert pvoc synth'}`,
      });
    }
    if (tool.inputs2 && !hasInput2) {
      errors.push({ index: i, message: `${tool.id} needs a second input — set Input 2 below` });
    }
    type = stepOutType(tool) || type;
    seen++;
  });
  if (!seen) errors.push({ index: -1, message: 'no enabled steps' });
  return { ok: errors.length === 0, errors, outType: type };
}

/** Serialized step for the Worker (no functions, no DOM state). */
export function slimStep(step, tool) {
  return {
    uid: step.uid,
    toolId: step.toolId,
    kind: tool.kind,
    program: tool.program,
    argv: tool.argv,
    inExt: tool.kind === 'effect' ? 'wav' : tool.inExt,
    outExt: tool.kind === 'effect' ? 'wav' : tool.outExt,
    values: step.values || {},
  };
}

export function pipelineToJSON(pipeline) {
  return JSON.stringify({
    schema: PIPELINE_SCHEMA,
    name: pipeline.name || 'Untitled pipeline',
    inputPath: pipeline.inputPath || '',
    input2Path: pipeline.input2Path || '',
    savedAt: new Date().toISOString(),
    steps: (pipeline.steps || []).map((s) => ({
      toolId: s.toolId, kind: s.kind, values: s.values,
      enabled: s.enabled !== false, note: s.note || '',
    })),
  }, null, 2);
}

/** Import: accepts a JSON string. Unknown tools are kept but flagged via
 *  `unknown` so the UI can say so — never silently dropped (§5.4 fork-on-edit
 *  keeps history; re-runs stamp revisions). */
export function pipelineFromJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('not valid JSON'); }
  if (!data || data.schema !== PIPELINE_SCHEMA) {
    throw new Error(`wrong schema — expected ${PIPELINE_SCHEMA}`);
  }
  const unknown = [];
  const steps = (Array.isArray(data.steps) ? data.steps : []).map((s) => {
    if (!s || typeof s.toolId !== 'string') throw new Error('step missing toolId');
    if (s.kind === 'effect' || s.kind === 'raw') {
      return {
        uid: newUid(), toolId: s.toolId, kind: s.kind,
        values: s.values && typeof s.values === 'object' ? s.values : {},
        enabled: s.enabled !== false, note: s.note || '',
      };
    }
    unknown.push(s.toolId);
    return null;
  }).filter(Boolean);
  return {
    schema: PIPELINE_SCHEMA,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled pipeline',
    inputPath: typeof data.inputPath === 'string' ? data.inputPath : '',
    input2Path: typeof data.input2Path === 'string' ? data.input2Path : '',
    steps,
    unknown,
  };
}
