/** CDP execution Worker (spec: docs/cdp-integration-spec.md §7.1 path (i)).
 *
 * One dedicated Worker owns the vendored cdp-wasm runtime so long renders
 * never touch the main thread. Two commands:
 *   run      — single tool: fetch asset → render → POST artifact
 *   pipeline — ordered steps (§5.2): render-then-feed, one artifact POST per
 *              completed step (disk is the store of record, §5.3); a cancel
 *              kills us between stages and finished artifacts survive.
 *
 * Progress is stage-based and honest (§7.2: CDP programs report no render
 * progress — never a fake 0-100). Curated effects go through `applyEffect`
 * (auto pvoc wrap, per-channel, source-relative defaults); raw steps go
 * through `cdp.process` with explicit file types.
 */
import { CDP, applyEffect, EFFECTS } from '/vendor/cdp-wasm-0.7.0/src/index.js';
import { resolveArgv } from './tools.js';

let cdp = null;

const post = (o) => self.postMessage(o);

async function getCdp() {
  if (!cdp) cdp = new CDP(); // default baseUrl: ../wasm/ next to the vendored src
  return cdp;
}

async function fetchAsset(token) {
  const res = await fetch(`/api/cdp/asset/${encodeURIComponent(token)}`);
  if (res.headers.get('content-type').includes('application/json')) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || 'asset fetch failed');
  }
  if (!res.ok) throw new Error(`asset fetch failed (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function postArtifact(token, name, bytes) {
  const res = await fetch('/api/cdp/artifact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Cdp-Token': token,
      'X-Cdp-Tool': name.tool,
      'X-Cdp-Name': name.file,
    },
    body: bytes,
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'artifact ingest failed');
  return j;
}

function artifactName(prefix, toolId, ext) {
  const safe = String(toolId).replace(/[^a-z0-9]+/gi, '_');
  return { tool: String(toolId), file: `${prefix}cdp_${safe}.${ext || 'wav'}` };
}

/** One render, in memory. Returns the output bytes (Uint8Array). */
async function renderStep(c, step, bytes, extra = {}) {
  if (step.kind === 'effect') {
    const eff = EFFECTS.find((e) => e.id === step.toolId);
    if (!eff) throw new Error(`tool ${step.toolId} not in the vendored EFFECTS catalog`);
    return applyEffect(c, eff, step.values || {}, bytes, extra);
  }
  const argv = resolveArgv(step.argv, step.values || {});
  const r = await c.process(step.program, argv, bytes,
    { inExt: step.inExt, outExt: step.outExt });
  if (r.exitCode !== 0) {
    throw new Error((r.stderr || `exit ${r.exitCode}`).trim().slice(0, 400));
  }
  return r.bytes;
}

self.onmessage = async (ev) => {
  const d = ev.data || {};
  try {
    const c = await getCdp();
    if (d.cmd === 'run') return await singleRun(c, d);
    if (d.cmd === 'pipeline') return await pipelineRun(c, d);
  } catch (e) {
    post({ type: 'error', runId: d.runId, message: String((e && e.message) || e) });
  }
};

async function singleRun(c, d) {
  const { runId, tool, values, token, brk } = d;
  post({ type: 'stage', runId, stage: 'fetch', detail: 'fetching canonical WAV' });
  const bytes = await fetchAsset(token);

  post({ type: 'stage', runId, stage: 'load', detail: 'loading CDP modules' });
  const t0 = performance.now();

  if (tool.kind === 'info') {
    const r = await c.run(tool.program, ['in.wav'], { inputs: { 'in.wav': bytes } });
    post({
      type: 'done-info', runId,
      stdout: r.stdout || r.stderr || '(no output)',
      exitCode: r.exitCode,
      ms: performance.now() - t0,
    });
    return;
  }

  const extra = {};
  if (brk && Object.keys(brk).length) extra.brk = brk;
  if (d.token2) {
    extra.in2 = await fetchAsset(d.token2);
  }

  const outBytes = await renderStep(c, { kind: tool.kind, toolId: tool.id, program: tool.program, argv: tool.argv, inExt: tool.inExt, outExt: tool.outExt, values }, bytes, extra);

  post({ type: 'stage', runId, stage: 'ingest', detail: 'saving output' });
  const saved = await postArtifact(token, artifactName('', tool.id, tool.outExt), outBytes);
  post({
    type: 'done', runId, path: saved.path, size: saved.size,
    catalogStamped: saved.catalogStamped,
    ms: performance.now() - t0,
    outBytes: outBytes.length,
  });
}

async function pipelineRun(c, d) {
  const { runId, steps, token, token2: t2, prefix } = d;
  post({ type: 'stage', runId, stage: 'fetch', detail: 'fetching pipeline input' });
  let bytes = await fetchAsset(token);
  let type = 'wav';
  const in2Bytes = t2 ? await fetchAsset(t2) : null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.enabled) {
      post({ type: 'step-skip', runId, index: i, toolId: step.toolId });
      continue;
    }
    const inType = step.kind === 'effect' ? 'wav' : step.inExt;
    if (inType !== type) {
      throw new Error(`step ${i + 1} (${step.toolId}) expects .${inType} but the chain provides .${type} — ${type === 'wav' ? 'insert pvoc anal' : 'insert pvoc synth'}`);
    }
    post({ type: 'stage', runId, stage: 'render', detail: `step ${i + 1}/${steps.length}: ${step.toolId}`, index: i });
    const t0 = performance.now();
    const extra = {};
    const eff = step.kind === 'effect' ? EFFECTS.find((e) => e.id === step.toolId) : null;
    if (eff && (eff.inputs || 1) >= 2) {
      if (!in2Bytes) throw new Error(`step ${i + 1} (${step.toolId}) needs a second input`);
      extra.in2 = in2Bytes;
    }
    if (step.brk && Object.keys(step.brk).length) extra.brk = step.brk;
    bytes = await renderStep(c, step, bytes, extra);
    type = step.kind === 'effect' ? 'wav' : step.outExt;

    post({ type: 'stage', runId, stage: 'ingest', detail: `step ${i + 1}: saving artifact`, index: i });
    const saved = await postArtifact(token, artifactName(`${prefix || 'p'}${i + 1}_`, step.toolId, type), bytes);
    post({
      type: 'step-done', runId, index: i, toolId: step.toolId,
      path: saved.path, size: saved.size, catalogStamped: saved.catalogStamped,
      ms: performance.now() - t0, outType: type,
    });
  }
  post({
    type: 'done-pipeline', runId,
    finalType: type,
    steps: steps.length,
  });
}
