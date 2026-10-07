/** CDP execution Worker (spec: docs/cdp-integration-spec.md §7.1 path (i)).
 *
 * One dedicated Worker owns the vendored cdp-wasm runtime so long renders
 * never touch the main thread. Flow per run:
 *   fetch canonical WAV (/api/cdp/asset) → render → POST bytes (/api/cdp/artifact)
 * Progress is stage-based and honest (§7.2: CDP programs report no render
 * progress — never a fake 0-100). Cancel = the main thread terminates us;
 * a completed artifact POST has already survived, nothing partial is saved.
 */
import { CDP, applyEffect, EFFECTS } from '/vendor/cdp-wasm-0.7.0/src/index.js';

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

async function postArtifact(token, tool, bytes) {
  const ext = tool.outExt || 'wav';
  const suggested = `cdp_${tool.id.replace(/[^a-z0-9]+/gi, '_')}.${ext}`;
  const res = await fetch('/api/cdp/artifact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Cdp-Token': token,
      'X-Cdp-Tool': tool.id,
      'X-Cdp-Name': suggested,
    },
    body: bytes,
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'artifact ingest failed');
  return j;
}

self.onmessage = async (ev) => {
  const { cmd, runId, tool, values, token } = ev.data || {};
  if (cmd !== 'run' || !tool) return;
  try {
    post({ type: 'stage', runId, stage: 'fetch', detail: 'fetching canonical WAV' });
    const bytes = await fetchAsset(token);

    post({ type: 'stage', runId, stage: 'load', detail: 'loading CDP modules' });
    const c = await getCdp();
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

    let outBytes;
    let stdout = '';
    if (tool.kind === 'effect') {
      const eff = EFFECTS.find((e) => e.id === tool.id);
      if (!eff) throw new Error(`tool ${tool.id} not in the vendored EFFECTS catalog`);
      // applyEffect owns the pvoc wrap (spectral) and per-channel handling
      // (mono-only) — the §2.2 curated layer changes no DSP.
      outBytes = await applyEffect(c, eff, values || {}, bytes);
    } else {
      const r = await c.process(tool.program, tool.argv, bytes,
        { inExt: tool.inExt, outExt: tool.outExt });
      if (r.exitCode !== 0) {
        throw new Error((r.stderr || `exit ${r.exitCode}`).trim().slice(0, 400));
      }
      outBytes = r.bytes;
      stdout = r.stderr || '';
    }

    post({ type: 'stage', runId, stage: 'ingest', detail: 'saving output' });
    const saved = await postArtifact(token, tool, outBytes);
    post({
      type: 'done', runId, path: saved.path, size: saved.size,
      catalogStamped: saved.catalogStamped,
      stdout: stdout.slice(0, 400),
      ms: performance.now() - t0,
      outBytes: outBytes.length,
    });
  } catch (e) {
    post({ type: 'error', runId, message: String((e && e.message) || e) });
  }
};
