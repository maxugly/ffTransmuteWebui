/**
 * Jobs tab — read-only desk view of work in flight.
 *
 * Sources of truth (do not invent a second queue):
 *  1. Server FIFO  — POST /api/queue  ("Add to Queue")
 *  2. Server live  — job_control tokens on any /ops/* (Run, Instant densify, queue worker)
 *  3. Client Instant RIFE — sequence densify FIFO (browser only)
 *
 * This tab must not change how jobs start, cancel, or order — display only
 * (existing Remove/Stop/Clear buttons stay wired to the same APIs).
 */
import { elements, logConsole } from '/app.js';
import { escapeHtml, basename } from '/js/utils.js';
import { getMainJobSnapshot } from '/js/job-control.js';

let _poll = null;

function _fmtTime(ts) {
  if (!ts) return '—';
  try {
    // Accept unix seconds or ms
    const ms = ts > 1e12 ? ts : ts * 1000;
    return new Date(ms).toLocaleTimeString();
  } catch (_) {
    return '—';
  }
}

function _fmtElapsed(startedAt) {
  if (!startedAt) return '';
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - (startedAt > 1e12 ? startedAt / 1000 : startedAt)));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function _pathFromBody(body) {
  if (!body || typeof body !== 'object') return '';
  const p = body.input_path || body.image_path || body.image_a
    || (Array.isArray(body.image_paths) && body.image_paths[0])
    || (Array.isArray(body.input_paths) && body.input_paths[0])
    || '';
  return p ? basename(String(p)) : '';
}

function _progressBits(p) {
  if (!p) return '';
  const bits = [];
  if (p.phase) bits.push(String(p.phase));
  if (p.total > 0) {
    bits.push(`${p.current || 0}/${p.total}${p.unit ? ' ' + p.unit : ''}`);
  } else if (p.message) {
    bits.push(String(p.message).slice(0, 80));
  }
  if (p.eta_h) bits.push(`ETA ${p.eta_h}`);
  else if (p.eta_s != null && p.eta_s > 0) bits.push(`ETA ~${Math.round(p.eta_s)}s`);
  if (p.rate_h) bits.push(`~${p.rate_h}`);
  if (p.status && p.status !== 'running') bits.push(String(p.status));
  return bits.join(' · ');
}

function _rowQueue(it, kind) {
  const id = (it.id || '').slice(0, 8);
  const label = escapeHtml(it.label || it.op_id || '?');
  const op = escapeHtml(it.op_id || '');
  const pathHint = _pathFromBody(it.body);
  let actions = '';
  if (kind === 'pending') {
    actions = `<button type="button" class="btn btn-sm jobs-rm" data-id="${escapeHtml(it.id)}">Remove</button>`;
  } else if (kind === 'running') {
    actions = `<button type="button" class="btn btn-sm jobs-stop" data-id="${escapeHtml(it.id)}">Stop</button>`;
  }
  let extra = '';
  if (kind === 'history') {
    const st = escapeHtml(it.status || '');
    const err = it.error ? ` · ${escapeHtml(String(it.error).slice(0, 100))}` : '';
    const sum = it.result_summary ? ` · ${escapeHtml(String(it.result_summary).slice(0, 80))}` : '';
    extra = `<span class="jobs-meta">${st}${err || sum}</span>`;
  }
  const when = kind === 'history'
    ? (it.finished_at || it.started_at || it.created_at)
    : (it.started_at || it.created_at);
  return `
    <div class="jobs-row jobs-${kind}" data-id="${escapeHtml(it.id || '')}">
      <div class="jobs-main">
        <strong>${label}</strong>
        <span class="jobs-meta">${op}${pathHint ? ' · ' + escapeHtml(pathHint) : ''} · ${id}… · ${_fmtTime(when)}</span>
        ${extra}
      </div>
      <div class="jobs-actions">${actions}</div>
    </div>
  `;
}

function _rowLiveOp(op) {
  const tok = (op.token || '').slice(0, 8);
  const opName = escapeHtml(op.operation || 'op');
  const status = escapeHtml(op.status || 'running');
  const prog = escapeHtml(_progressBits(op));
  const elap = op.started_at ? _fmtElapsed(op.started_at) : '';
  return `
    <div class="jobs-row jobs-running">
      <div class="jobs-main">
        <strong>${opName}</strong>
        <span class="jobs-meta">${status}${elap ? ' · ' + elap : ''} · ${tok}…</span>
        ${prog ? `<p class="jobs-progress">${prog}</p>` : ''}
      </div>
      <div class="jobs-actions">
        <span class="jobs-pill jobs-pill-live">server</span>
      </div>
    </div>
  `;
}

function _rowInstant(j, kind) {
  const name = escapeHtml(j.name || j.path || '?');
  const m = j.multiplier != null ? `×${j.multiplier}` : '';
  if (kind === 'running') {
    return `
      <div class="jobs-row jobs-running">
        <div class="jobs-main">
          <strong>Instant RIFE ${m}</strong>
          <span class="jobs-meta">${name}</span>
        </div>
        <div class="jobs-actions"><span class="jobs-pill jobs-pill-instant">RUN</span></div>
      </div>`;
  }
  return `
    <div class="jobs-row jobs-pending">
      <div class="jobs-main">
        <strong>Q${j.position} · Instant RIFE ${m}</strong>
        <span class="jobs-meta">${name}${j.targetFps ? ' · target ' + j.targetFps + ' fps' : ''}</span>
      </div>
      <div class="jobs-actions"><span class="jobs-pill">queued</span></div>
    </div>`;
}

async function fetchQueue() {
  const res = await fetch('/api/queue');
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function _loadInstantSnap() {
  try {
    const mod = await import('/js/pool/sequence.js');
    if (typeof mod.getInstantRifeQueueSnapshot === 'function') {
      return mod.getInstantRifeQueueSnapshot();
    }
  } catch (_) { /* sequence module optional */ }
  return null;
}

async function refreshJobsPanel() {
  const root = document.getElementById('jobsPanel');
  if (!root) return;
  try {
    const data = await fetchQueue();
    const client = getMainJobSnapshot();
    const instant = await _loadInstantSnap();

    const liveOps = data.live_ops || [];
    const recentOps = data.recent_ops || [];
    const run = data.running;
    const pending = data.pending || [];
    const history = data.history || [];

    // ── Status banner ─────────────────────────────────────────────
    const flags = [];
    if (data.busy) flags.push('busy');
    if (data.direct_busy) flags.push('direct Run');
    if (run) flags.push('FIFO worker');
    if (instant?.draining || (instant?.queueDepth > 0)) flags.push('Instant RIFE');
    if (client.busy && client.clientBusyLabel) flags.push(client.clientBusyLabel);
    const statusLine = flags.length
      ? `<p class="jobs-status jobs-status-busy">● ${escapeHtml(flags.join(' · '))}</p>`
      : `<p class="jobs-status jobs-status-idle">○ Idle — nothing running or queued</p>`;

    // ── Running now ───────────────────────────────────────────────
    const runningBlocks = [];

    // Live server tokens (Run / Instant densify / queue worker share job_control)
    if (liveOps.length) {
      liveOps.forEach((op) => { runningBlocks.push(_rowLiveOp(op)); });
    }

    // FIFO running item (may duplicate a live token — still show with queue label)
    if (run) {
      let runHtml = _rowQueue(run, 'running');
      try {
        const pr = await fetch(`/api/job/${encodeURIComponent(run.id)}`);
        if (pr.ok) {
          const p = await pr.json();
          if (p.found || p.phase || p.total) {
            const bits = _progressBits(p);
            if (bits) runHtml += `<p class="jobs-progress">${escapeHtml(bits)}</p>`;
          }
        }
      } catch (_) { /* ignore */ }
      // Avoid double-listing if same token already in liveOps
      const already = liveOps.some((o) => o.token === run.id);
      if (!already) runningBlocks.push(runHtml);
      else {
        // Annotate: already shown as live op
        runningBlocks.push(`
          <div class="jobs-row jobs-running">
            <div class="jobs-main">
              <strong>FIFO · ${escapeHtml(run.label || run.op_id || '')}</strong>
              <span class="jobs-meta">same server token as above · ${(run.id || '').slice(0, 8)}…</span>
            </div>
            <div class="jobs-actions"><span class="jobs-pill">queue</span></div>
          </div>`);
      }
    }

    // Client busy without a server token yet (between Instant densifies)
    if (client.busy && !client.token && client.clientBusyLabel && !liveOps.length && !run) {
      runningBlocks.push(`
        <div class="jobs-row jobs-running">
          <div class="jobs-main">
            <strong>${escapeHtml(client.clientBusyLabel)}</strong>
            <span class="jobs-meta">client hold · waiting for next encode or probe</span>
          </div>
          <div class="jobs-actions"><span class="jobs-pill jobs-pill-instant">client</span></div>
        </div>`);
    }

    // Instant currently encoding (name from sequence even if progress is in liveOps)
    if (instant?.running) {
      runningBlocks.push(_rowInstant(instant.running, 'running'));
    }

    const runSection = runningBlocks.length
      ? runningBlocks.join('')
      : '<p class="form-row-hint">Nothing running</p>';

    // ── FIFO pending ──────────────────────────────────────────────
    const pendingSection = pending.length
      ? pending.map((p, i) => {
          const row = _rowQueue(p, 'pending');
          return row.replace('<strong>', `<strong>#${i + 1} · `);
        }).join('')
      : '<p class="form-row-hint">Empty — use “Add to Queue” on op tabs</p>';

    // ── Instant queue ─────────────────────────────────────────────
    let instantSection = '<p class="form-row-hint">Instant RIFE off or idle</p>';
    if (instant) {
      const lines = [];
      if (!instant.enabled) {
        lines.push('<p class="form-row-hint">Instant RIFE is off (Sequence · Instant checkbox)</p>');
      } else if (instant.queueDepth === 0 && !instant.running && !instant.draining) {
        lines.push('<p class="form-row-hint">No Instant densify jobs queued</p>');
      }
      if (instant.queue && instant.queue.length) {
        instant.queue.forEach((j) => lines.push(_rowInstant(j, 'pending')));
      }
      if (instant.sequenceNeed && instant.sequenceNeed.length) {
        const fail = instant.sequenceNeed.filter((e) => e.status === 'failed');
        if (fail.length) {
          lines.push(`<p class="jobs-meta jobs-fail-note">${fail.length} sequence clip(s) FAIL — toggle Instant or edit Time to retry</p>`);
          fail.forEach((e) => {
            lines.push(`
              <div class="jobs-row jobs-history">
                <div class="jobs-main">
                  <strong>FAIL · ${escapeHtml(e.name || '')}</strong>
                  <span class="jobs-meta">${escapeHtml(e.error || 'error')}</span>
                </div>
              </div>`);
          });
        }
      }
      if (lines.length) instantSection = lines.join('');
    }

    // ── Done ──────────────────────────────────────────────────────
    const doneRows = [];
    history.slice(0, 25).forEach((h) => doneRows.push(_rowQueue(h, 'history')));
    // Server recent ops not already in FIFO history
    const histIds = new Set(history.map((h) => h.id));
    recentOps.slice(0, 15).forEach((op) => {
      if (histIds.has(op.token)) return;
      const st = escapeHtml(op.status || '');
      const opName = escapeHtml(op.operation || 'op');
      const tok = (op.token || '').slice(0, 8);
      doneRows.push(`
        <div class="jobs-row jobs-history">
          <div class="jobs-main">
            <strong>${opName}</strong>
            <span class="jobs-meta">${st} · ${tok}… · ${_fmtTime(op.updated_at || op.started_at)}</span>
            ${op.message ? `<span class="jobs-meta">${escapeHtml(String(op.message).slice(0, 100))}</span>` : ''}
          </div>
          <div class="jobs-actions"><span class="jobs-pill">server</span></div>
        </div>`);
    });
    const doneSection = doneRows.length
      ? doneRows.join('')
      : '<p class="form-row-hint">None yet</p>';

    root.innerHTML = `
      <div class="panel-title-desc dense">
        <h3>Jobs</h3>
        <p class="dream-hint">
          Live view only — does not change how work is scheduled.
          <strong>Running</strong> = server ops + Instant densify.
          <strong>Queued (FIFO)</strong> = Add to Queue.
          <strong>Instant</strong> = Sequence densify waiting in the browser.
          Pending FIFO is in-memory (lost on server restart).
        </p>
        ${statusLine}
      </div>

      <h4 class="jobs-h">Running now ${data.busy || liveOps.length || instant?.running ? '●' : ''}</h4>
      <div class="jobs-section">${runSection}</div>

      <h4 class="jobs-h">Queued — FIFO (${pending.length})
        <button type="button" class="btn btn-sm" id="btnJobsClear" ${pending.length ? '' : 'disabled'}>Clear pending</button>
      </h4>
      <div class="jobs-section">${pendingSection}</div>

      <h4 class="jobs-h">Queued — Instant RIFE (${instant?.queueDepth || 0})</h4>
      <div class="jobs-section">${instantSection}</div>

      <h4 class="jobs-h">Done</h4>
      <div class="jobs-section">${doneSection}</div>
    `;

    root.querySelectorAll('.jobs-rm').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/queue/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
        refreshJobsPanel();
      });
    });
    root.querySelectorAll('.jobs-stop').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/queue/${encodeURIComponent(btn.dataset.id)}/cancel`, { method: 'POST' });
        refreshJobsPanel();
      });
    });
    const clr = document.getElementById('btnJobsClear');
    if (clr) {
      clr.addEventListener('click', async () => {
        await fetch('/api/queue/clear', { method: 'POST' });
        refreshJobsPanel();
      });
    }
  } catch (err) {
    root.innerHTML = `<p class="form-row-hint">Queue error: ${escapeHtml(err.message)}</p>`;
    logConsole(`[JOBS]: ${err.message}`, 'error');
  }
}

function renderJobsForm() {
  elements.actionPanel.innerHTML = `<div id="jobsPanel" class="jobs-panel">Loading…</div>`;
  refreshJobsPanel();
  if (_poll) clearInterval(_poll);
  _poll = setInterval(() => {
    if (document.getElementById('jobsPanel')) refreshJobsPanel();
  }, 1200);
}

function stopJobsPoll() {
  if (_poll) {
    clearInterval(_poll);
    _poll = null;
  }
}

export { renderJobsForm, refreshJobsPanel, stopJobsPoll };
