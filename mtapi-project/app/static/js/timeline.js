// Global video probe + timeline slider controls
import { state } from '/app.js';

// ── Global video probe → populates global frame range ─────────────────────

async function probeGlobalVideo(path) {
  if (!path) return;
  var gi = window.globalInputs;
  if (path === gi._lastProbedPath) return;
  gi._lastProbedPath = path;

  try {
    const res = await fetch(`/api/probe?path=${encodeURIComponent(path)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && data.true_frames) {
      var frames = data.true_frames;
      gi.totalFrames = frames;
      gi.frameEnd = frames;
      if (gi.frameStart < 1 || gi.frameStart > frames) gi.frameStart = 1;

      var startEl = document.getElementById('giTimelineStart');
      var endEl   = document.getElementById('giTimelineEnd');
      var valS    = document.getElementById('giValStartFrame');
      var valE    = document.getElementById('giValEndFrame');
      if (startEl && endEl) {
        startEl.max = frames;
        endEl.max = frames;
        startEl.value = gi.frameStart;
        endEl.value   = gi.frameEnd;
        if (valS) valS.value = gi.frameStart;
        if (valE) valE.value = gi.frameEnd;
        startEl.dispatchEvent(new Event('input')); // updates selected count + bar
      }
    }
  } catch (err) {
    console.error("Failed to probe video:", err);
  }
}

// ── Global timeline slider setup ──────────────────────────────────────────

function setupGlobalTimeline() {
  var startEl = document.getElementById('giTimelineStart');
  var endEl   = document.getElementById('giTimelineEnd');
  var rangeEl = document.getElementById('giTimelineRange');
  var valS    = document.getElementById('giValStartFrame');
  var valE    = document.getElementById('giValEndFrame');
  if (!startEl || !endEl || !rangeEl) return;

  function maxFrames() {
    var m = parseInt(window.globalInputs.totalFrames, 10);
    return (m > 1) ? m : 2;
  }

  function sync() {
    var m = maxFrames();
    startEl.min = 1; startEl.max = m;
    endEl.min   = 1; endEl.max   = m;

    var s = parseInt(startEl.value, 10);
    var e = parseInt(endEl.value, 10);
    if (isNaN(s)) s = 1;
    if (isNaN(e)) e = m;
    if (s >= e) { s = Math.max(1, e - 1); startEl.value = s; }
    if (e <= s) { e = Math.min(m, s + 1); endEl.value = e; }

    var span = Math.max(1, m - 1);
    var pL   = ((s - 1) / span) * 100;
    var pW   = Math.max(0, ((e - 1) / span) * 100 - pL);
    rangeEl.style.left  = pL + '%';
    rangeEl.style.width = pW + '%';

    if (valS && document.activeElement !== valS) valS.value = s;
    if (valE && document.activeElement !== valE) valE.value = e;

    window.globalInputs.frameStart = s;
    window.globalInputs.frameEnd   = e;

    // Show selected span as primary count; full clip length in title
    var totalEl = document.getElementById('giTotalFrames');
    if (totalEl) {
      var selected = Math.max(1, e - s + 1);
      totalEl.textContent = selected;
      totalEl.title = selected + ' selected of ' + m + ' in clip';
    }
  }

  startEl.addEventListener('input', sync);
  endEl.addEventListener('input', sync);

  // Range dragging: drag the blue bar to slide the whole window
  var rangeDragging = false;
  var dragStartX = 0;
  var dragStartValL = 0;
  var dragStartValR = 0;

  function onRangeMouseDown(e) {
    if (e.target !== rangeEl) return;
    rangeDragging = true;
    dragStartX = e.clientX;
    dragStartValL = parseInt(startEl.value, 10);
    dragStartValR = parseInt(endEl.value, 10);
    rangeEl.classList.add('active');
    window.addEventListener('mousemove', onRangeMouseMove);
    window.addEventListener('mouseup', onRangeMouseUp);
    e.preventDefault();
    e.stopPropagation();
  }

  function onRangeMouseMove(e) {
    if (!rangeDragging) return;
    var m = maxFrames();
    var trackRect = startEl.getBoundingClientRect();
    var trackWidth = trackRect.width;
    if (trackWidth <= 0) return;
    var deltaX = e.clientX - dragStartX;
    var deltaFrames = Math.round((deltaX / trackWidth) * Math.max(1, m - 1));
    var span = dragStartValR - dragStartValL;
    var ns = dragStartValL + deltaFrames;
    var ne = dragStartValR + deltaFrames;
    if (ns < 1) { ns = 1; ne = ns + span; }
    if (ne > m) { ne = m; ns = ne - span; }
    startEl.value = ns;
    endEl.value = ne;
    sync();
  }

  function onRangeMouseUp() {
    rangeDragging = false;
    rangeEl.classList.remove('active');
    window.removeEventListener('mousemove', onRangeMouseMove);
    window.removeEventListener('mouseup', onRangeMouseUp);
  }

  rangeEl.addEventListener('mousedown', onRangeMouseDown);

  // Touch support for the blue range handle
  rangeEl.addEventListener('touchstart', function(e) {
    if (!e.touches || !e.touches[0]) return;
    var t = e.touches[0];
    rangeDragging = true;
    dragStartX = t.clientX;
    dragStartValL = parseInt(startEl.value, 10);
    dragStartValR = parseInt(endEl.value, 10);
    rangeEl.classList.add('active');
    var onMove = function(ev) {
      if (!rangeDragging || !ev.touches || !ev.touches[0]) return;
      onRangeMouseMove({ clientX: ev.touches[0].clientX });
      ev.preventDefault();
    };
    var onEnd = function() {
      onRangeMouseUp();
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    e.preventDefault();
  }, { passive: false });

  [valS, valE].forEach(function(el) {
    if (!el) return;
    function commit() {
      var raw = parseInt(String(el.value).replace(/[^0-9]/g, ''), 10);
      var m = maxFrames();
      if (isNaN(raw)) raw = (el === valS ? 1 : m);
      if (el === valS) {
        raw = Math.min(Math.max(1, raw), parseInt(endEl.value, 10) - 1);
        startEl.value = raw;
      } else {
        raw = Math.max(Math.min(m, raw), parseInt(startEl.value, 10) + 1);
        endEl.value = raw;
      }
      sync();
    }
    el.addEventListener('change', commit);
    el.addEventListener('blur', commit);
    el.addEventListener('keydown', function(e) { if (e.key === 'Enter') { el.blur(); e.preventDefault(); } });
  });

  sync();
}

function setupTimelineSlider(hiddenStartId, hiddenEndId, defaultStart, defaultEnd) {
  const startInput = document.getElementById('timelineStart');
  const endInput = document.getElementById('timelineEnd');
  const rangeHighlight = document.getElementById('timelineRange');
  const valStart = document.getElementById('valStartFrame');
  const valEnd = document.getElementById('valEndFrame');

  const hiddenStart = document.getElementById(hiddenStartId);
  const hiddenEnd = document.getElementById(hiddenEndId);

  if (!startInput || !endInput || !rangeHighlight || !hiddenStart || !hiddenEnd || !valStart || !valEnd) return;

  function currentMaxFrames() {
    const fromState = parseInt(state.moshVideoFrames, 10);
    const fromDom = parseInt(startInput.max, 10);
    const max = fromState || fromDom || 100;
    return max > 1 ? max : 2; // avoid divide-by-zero in percent math
  }

  function applyMax(maxFrames) {
    startInput.min = 1;
    startInput.max = maxFrames;
    endInput.min = 1;
    endInput.max = maxFrames;
  }

  let maxFrames = currentMaxFrames();
  applyMax(maxFrames);

  let initStart = parseInt(hiddenStart.value, 10) || defaultStart;
  let initEnd = parseInt(hiddenEnd.value, 10) || defaultEnd;

  if (initStart > maxFrames) initStart = 1;
  if (initEnd > maxFrames || initEnd === 999999) initEnd = maxFrames;
  if (initStart < 1) initStart = 1;
  if (initEnd <= initStart) initEnd = Math.min(maxFrames, initStart + 1);

  startInput.value = initStart;
  endInput.value = initEnd;

  function updateTimeline() {
    maxFrames = currentMaxFrames();
    applyMax(maxFrames);

    let startVal = parseInt(startInput.value, 10);
    let endVal = parseInt(endInput.value, 10);
    if (isNaN(startVal)) startVal = 1;
    if (isNaN(endVal)) endVal = maxFrames;

    // Keep at least 1 frame of distance
    if (startVal >= endVal) {
      if (this === startInput) {
        startVal = Math.max(1, endVal - 1);
        startInput.value = startVal;
      } else {
        endVal = Math.min(maxFrames, startVal + 1);
        endInput.value = endVal;
      }
    }

    const span = Math.max(1, maxFrames - 1);
    const percentLeft = ((startVal - 1) / span) * 100;
    const percentRight = ((endVal - 1) / span) * 100;
    const widthPct = Math.max(0, percentRight - percentLeft);

    rangeHighlight.style.left = `${percentLeft}%`;
    rangeHighlight.style.width = `${widthPct}%`;

    if (document.activeElement !== valStart) {
      valStart.value = startVal;
    }
    if (document.activeElement !== valEnd) {
      valEnd.value = endVal;
    }

    hiddenStart.value = startVal;
    hiddenEnd.value = endVal;
  }

  startInput.addEventListener('input', updateTimeline);
  endInput.addEventListener('input', updateTimeline);

  // Range dragging: drag the blue bar to slide the whole window
  let rangeDragging = false;
  let dragStartX = 0;
  let dragStartValL = 0;
  let dragStartValR = 0;

  function onRangeMouseDown(e) {
    // Ignore if a thumb is the real target (they sit above the bar)
    if (e.target !== rangeHighlight) return;

    rangeDragging = true;
    dragStartX = e.clientX;
    dragStartValL = parseInt(startInput.value, 10);
    dragStartValR = parseInt(endInput.value, 10);

    rangeHighlight.classList.add('active');

    window.addEventListener('mousemove', onRangeMouseMove);
    window.addEventListener('mouseup', onRangeMouseUp);
    e.preventDefault();
    e.stopPropagation();
  }

  function onRangeMouseMove(e) {
    if (!rangeDragging) return;

    maxFrames = currentMaxFrames();
    const trackRect = startInput.getBoundingClientRect();
    const trackWidth = trackRect.width;
    if (trackWidth <= 0) return;

    const deltaX = e.clientX - dragStartX;
    const deltaFrames = Math.round((deltaX / trackWidth) * Math.max(1, maxFrames - 1));

    let newStart = dragStartValL + deltaFrames;
    let newEnd = dragStartValR + deltaFrames;
    const rangeSpan = dragStartValR - dragStartValL;

    if (newStart < 1) {
      newStart = 1;
      newEnd = newStart + rangeSpan;
    }
    if (newEnd > maxFrames) {
      newEnd = maxFrames;
      newStart = newEnd - rangeSpan;
    }

    startInput.value = newStart;
    endInput.value = newEnd;

    updateTimeline();
  }

  function onRangeMouseUp() {
    rangeDragging = false;
    rangeHighlight.classList.remove('active');
    window.removeEventListener('mousemove', onRangeMouseMove);
    window.removeEventListener('mouseup', onRangeMouseUp);
  }

  rangeHighlight.addEventListener('mousedown', onRangeMouseDown);
  // Touch support for the blue range handle
  rangeHighlight.addEventListener('touchstart', (e) => {
    if (!e.touches || !e.touches[0]) return;
    const t = e.touches[0];
    rangeDragging = true;
    dragStartX = t.clientX;
    dragStartValL = parseInt(startInput.value, 10);
    dragStartValR = parseInt(endInput.value, 10);
    rangeHighlight.classList.add('active');
    const onMove = (ev) => {
      if (!rangeDragging || !ev.touches || !ev.touches[0]) return;
      onRangeMouseMove({ clientX: ev.touches[0].clientX });
      ev.preventDefault();
    };
    const onEnd = () => {
      onRangeMouseUp();
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    e.preventDefault();
  }, { passive: false });

  // Editable inputs key listeners
  function onTextSubmit() {
    maxFrames = currentMaxFrames();
    let sVal = parseInt(String(valStart.value).replace(/[^0-9]/g, ''), 10);
    let eVal = parseInt(String(valEnd.value).replace(/[^0-9]/g, ''), 10);

    if (isNaN(sVal)) sVal = 1;
    if (isNaN(eVal)) eVal = maxFrames;

    if (sVal < 1) sVal = 1;
    if (eVal > maxFrames) eVal = maxFrames;

    if (sVal >= eVal) {
      if (this === valStart) {
        sVal = Math.max(1, eVal - 1);
      } else {
        eVal = Math.min(maxFrames, sVal + 1);
      }
    }

    startInput.value = sVal;
    endInput.value = eVal;

    updateTimeline();
  }

  valStart.addEventListener('change', onTextSubmit);
  valStart.addEventListener('blur', onTextSubmit);
  valStart.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valStart.blur(); e.preventDefault(); } });

  valEnd.addEventListener('change', onTextSubmit);
  valEnd.addEventListener('blur', onTextSubmit);
  valEnd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valEnd.blur(); e.preventDefault(); } });

  // Initial update — paints the blue selected-range bar
  updateTimeline();
}

export { probeGlobalVideo, setupGlobalTimeline, setupTimelineSlider };
