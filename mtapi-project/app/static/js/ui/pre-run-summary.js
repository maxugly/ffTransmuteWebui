function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  var s = Math.max(0, Number(sec));
  if (s >= 3600) {
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var rem = s % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + rem.toFixed(0).padStart(2, '0');
  }
  if (s >= 60) {
    var mm = Math.floor(s / 60);
    var r = s % 60;
    return mm + ':' + r.toFixed(0).padStart(2, '0');
  }
  return s.toFixed(2) + ' s';
}

function fmtFrames(n) {
  if (n == null || !isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

/**
 * Renderer for pre-run summary strip.
 * `containerId` — element ID that receives the strip (must exist).
 * `build` — fn() returning { lines, tone } where tone is 'ok'|'estimate'|'warn'.
 * Returns a function `refresh()` to re-render on input changes.
 */
function bindPreRunSummary(containerId, build) {
  var el = document.getElementById(containerId);
  if (!el) return function() {};

  el.classList.add('pre-run-summary');

  function render() {
    var info = build();
    var tone = info.tone || 'ok';
    el.className = 'pre-run-summary';
    if (tone === 'estimate') el.classList.add('is-estimate');
    if (tone === 'warn') el.classList.add('is-warn');

    var parts = [];
    (info.lines || []).forEach(function(line) {
      if (typeof line === 'string') {
        parts.push('<span>' + line + '</span>');
      } else if (line && typeof line === 'object') {
        var cls = line.estimate ? 'prs-estimate' : 'prs-number';
        parts.push('<span class="' + cls + '">' + line.text + '</span>');
      }
    });
    el.innerHTML = '<span class="prs-body">' + parts.join('<span class="prs-sep"> · </span>') + '</span>';
  }

  render();
  return render;
}

function renderPreRunSummary(el, info) {
  if (!el) return;
  var tone = info.tone || 'ok';
  el.className = 'pre-run-summary';
  if (tone === 'estimate') el.classList.add('is-estimate');
  if (tone === 'warn') el.classList.add('is-warn');

  var parts = [];
  (info.lines || []).forEach(function(line) {
    if (typeof line === 'string') {
      parts.push('<span>' + line + '</span>');
    } else if (line && typeof line === 'object') {
      var cls = line.estimate ? 'prs-estimate' : 'prs-number';
      parts.push('<span class="' + cls + '">' + line.text + '</span>');
    }
  });
  el.innerHTML = '<span class="prs-body">' + parts.join('<span class="prs-sep"> · </span>') + '</span>';
}

export { fmtDuration, fmtFrames, bindPreRunSummary, renderPreRunSummary };
