/**
 * Jobs tab — queue snapshot (pending / running / history).
 * In-memory on server; F5 clears pending (v1).
 */
import { elements, logConsole } from '/app.js';
import { escapeHtml } from '/js/utils.js';

let _poll = null;

function _fmtTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts * 1000).toLocaleTimeString();
  } catch (_) {
    return '—';
  }
}

function _row(it, kind) {
  const id = (it.id || '').slice(0, 8);
  const label = escapeHtml(it.label || it.op_id || '?');
  const op = escapeHtml(it.op_id || '');
  let actions = '';
  if (kind === 'pending') {
    actions = `<button type="button" class="btn btn-sm jobs-rm" data-id="${escapeHtml(it.id)}">Remove</button>`;
  } else if (kind === 'running') {
    actions = `<button type="button" class="btn btn-sm jobs-stop" data-id="${escapeHtml(it.id)}">Stop</button>`;
  }
  let extra = '';
  if (kind === 'history') {
    const st = escapeHtml(it.status || '');
    const err = it.error ? ` · ${escapeHtml(String(it.error).slice(0, 80))}` : '';
    const sum = it.result_summary ? ` · ${escapeHtml(String(it.result_summary).slice(0, 60))}` : '';
    extra = `<span class="jobs-meta">${st}${err || sum}</span>`;
  }
  return `
    <div class="jobs-row jobs-${kind}" data-id="${escapeHtml(it.id || '')}">
      <div class="jobs-main">
        <strong>${label}</strong>
        <span class="jobs-meta">${op} · ${id}… · ${_fmtTime(it.created_at || it.started_at)}</span>
        ${extra}
      </div>
      <div class="jobs-actions">${actions}</div>
    </div>
  `;
}

async function fetchQueue() {
  const res = await fetch('/api/queue');
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function refreshJobsPanel() {
  const root = document.getElementById('jobsPanel');
  if (!root) return;
  try {
    const data = await fetchQueue();
    const run = data.running;
    const pending = data.pending || [];
    const history = data.history || [];
    let runHtml = '<p class="form-row-hint">Idle</p>';
    if (run) {
      runHtml = _row(run, 'running');
      // live progress
      try {
        const pr = await fetch(`/api/job/${encodeURIComponent(run.id)}`);
        if (pr.ok) {
          const p = await pr.json();
          if (p.found) {
            const bits = [];
            if (p.phase) bits.push(p.phase);
            if (p.total > 0) bits.push(`${p.current || 0}/${p.total}${p.unit ? ' ' + p.unit : ''}`);
            if (p.eta_h) bits.push(`ETA ${p.eta_h}`);
            if (p.rate_h) bits.push(`~${p.rate_h}`);
            runHtml += `<p class="jobs-progress">${escapeHtml(bits.join(' · ') || p.message || '')}</p>`;
          }
        }
      } catch (_) { /* ignore */ }
    }
    root.innerHTML = `
      <div class="panel-title-desc dense">
        <h3>Jobs</h3>
        <p class="dream-hint">
          FIFO queue — one op at a time. <strong>In-memory</strong> (lost on server restart / F5 for pending).
          Use <strong>Add to Queue</strong> on Run tabs when the engine is busy.
        </p>
      </div>
      <h4 class="jobs-h">Running ${data.busy ? '●' : ''}</h4>
      <div class="jobs-section">${runHtml}</div>
      <h4 class="jobs-h">Pending (${pending.length})
        <button type="button" class="btn btn-sm" id="btnJobsClear" ${pending.length ? '' : 'disabled'}>Clear pending</button>
      </h4>
      <div class="jobs-section">${pending.length ? pending.map(p => _row(p, 'pending')).join('') : '<p class="form-row-hint">Empty</p>'}</div>
      <h4 class="jobs-h">Recent</h4>
      <div class="jobs-section">${history.length ? history.slice(0, 20).map(h => _row(h, 'history')).join('') : '<p class="form-row-hint">None yet</p>'}</div>
    `;
    root.querySelectorAll('.jobs-rm').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/queue/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
        refreshJobsPanel();
      });
    });
    root.querySelectorAll('.jobs-stop').forEach(btn => {
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
  }
}

function renderJobsForm() {
  elements.actionPanel.innerHTML = `<div id="jobsPanel" class="jobs-panel">Loading…</div>`;
  refreshJobsPanel();
  if (_poll) clearInterval(_poll);
  _poll = setInterval(() => {
    if (document.getElementById('jobsPanel')) refreshJobsPanel();
  }, 1500);
}

function stopJobsPoll() {
  if (_poll) {
    clearInterval(_poll);
    _poll = null;
  }
}

export { renderJobsForm, refreshJobsPanel, stopJobsPoll };
