// ── Generic DAW knobs ─────────────────────────────────────────────────────

/**
 * Continuous rotary knob bound to a hidden input.
 * opts: { knobId, indicatorId, valueId, hiddenId, min, max, step?, decimals?, format?, sensitivity? }
 * format(val) -> display string; default uses decimals.
 */
function setupContinuousKnob(opts) {
  const knob = document.getElementById(opts.knobId);
  const indicator = document.getElementById(opts.indicatorId);
  const valueDisplay = document.getElementById(opts.valueId);
  const hiddenInput = document.getElementById(opts.hiddenId);
  if (!knob || !indicator || !valueDisplay || !hiddenInput) return;

  const minAngle = -135;
  const maxAngle = 135;
  const rangeAngle = maxAngle - minAngle;
  const minVal = opts.min;
  const maxVal = opts.max;
  const rangeVal = maxVal - minVal;
  const decimals = opts.decimals != null ? opts.decimals : 2;
  const sensitivity = opts.sensitivity || 140;
  const format = opts.format || ((v) => {
    if (decimals <= 0) return String(Math.round(v));
    return v.toFixed(decimals);
  });

  let currentVal = parseFloat(hiddenInput.value);
  if (isNaN(currentVal)) currentVal = minVal;
  currentVal = Math.min(maxVal, Math.max(minVal, currentVal));

  let startY = 0;
  let startVal = currentVal;

  function updateUI(val) {
    currentVal = val;
    const percent = rangeVal === 0 ? 0 : (val - minVal) / rangeVal;
    const angle = minAngle + percent * rangeAngle;
    indicator.style.transform = `translate(-50%, -100%) rotate(${angle}deg)`;
    if (document.activeElement !== valueDisplay) {
      valueDisplay.value = format(val);
    }
    // store raw number (preserve decimals for backend)
    if (decimals <= 0) hiddenInput.value = String(Math.round(val));
    else hiddenInput.value = String(Number(val.toFixed(Math.max(decimals, 4))));
    if (typeof opts.onChange === 'function') opts.onChange(currentVal);
  }

  function onMouseDown(e) {
    knob.classList.add('active');
    startY = e.clientY;
    startVal = currentVal;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  }
  function onMouseMove(e) {
    const deltaY = startY - e.clientY;
    let newVal = startVal + (deltaY / sensitivity) * rangeVal;
    newVal = Math.min(maxVal, Math.max(minVal, newVal));
    if (opts.step && opts.step > 0) {
      newVal = Math.round(newVal / opts.step) * opts.step;
      newVal = Math.min(maxVal, Math.max(minVal, newVal));
    }
    updateUI(newVal);
  }
  function onMouseUp() {
    knob.classList.remove('active');
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }
  function onTextSubmit() {
    let raw = valueDisplay.value.replace(/[^0-9.+\-eE]/g, '').trim();
    let val = parseFloat(raw);
    if (isNaN(val)) val = currentVal;
    val = Math.min(maxVal, Math.max(minVal, val));
    if (opts.step && opts.step > 0) {
      val = Math.round(val / opts.step) * opts.step;
    }
    updateUI(val);
  }

  function snapVal(v) {
    let newVal = Math.min(maxVal, Math.max(minVal, v));
    if (opts.step && opts.step > 0) {
      newVal = Math.round(newVal / opts.step) * opts.step;
      newVal = Math.min(maxVal, Math.max(minVal, newVal));
    }
    return newVal;
  }

  function onWheel(e) {
    // Scroll up → increase (same feel as drag-up); Shift = finer steps
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
    if (!dir) return;
    let step;
    if (opts.step && opts.step > 0) {
      const coarseMul = Math.max(1, Math.round(rangeVal / (opts.step * 40)) || 1);
      step = opts.step * (e.shiftKey ? 1 : coarseMul);
    } else if (decimals <= 0) {
      step = e.shiftKey ? 1 : Math.max(1, Math.round(rangeVal / 50) || 1);
    } else {
      step = rangeVal / (e.shiftKey ? 200 : 50);
    }
    updateUI(snapVal(currentVal + dir * step));
  }

  knob.addEventListener('mousedown', onMouseDown);
  knob.addEventListener('wheel', onWheel, { passive: false });
  // Wheel over the numeric readout also adjusts the knob
  valueDisplay.addEventListener('wheel', onWheel, { passive: false });
  valueDisplay.addEventListener('change', onTextSubmit);
  valueDisplay.addEventListener('blur', onTextSubmit);
  valueDisplay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { valueDisplay.blur(); e.preventDefault(); }
  });
  updateUI(currentVal);
}

/**
 * Two-position snap knob. Click toggles; drag snaps to nearer side.
 * opts: { knobId, indicatorId, hiddenId, leftLabel, rightLabel,
 *         leftValue, rightValue, initial? }
 * leftValue/rightValue are the stored hidden values (string or bool-ish).
 */
function setupBinaryKnob(opts) {
  const knob = document.getElementById(opts.knobId);
  const indicator = document.getElementById(opts.indicatorId);
  const hiddenInput = document.getElementById(opts.hiddenId);
  if (!knob || !indicator || !hiddenInput) return;

  const leftVal = String(opts.leftValue);
  const rightVal = String(opts.rightValue);
  const leftAngle = -110;
  const rightAngle = 110;

  function isRight(v) {
    return String(v) === rightVal;
  }

  function updateUI(v) {
    const right = isRight(v);
    hiddenInput.value = right ? rightVal : leftVal;
    indicator.style.transform = `translate(-50%, -100%) rotate(${right ? rightAngle : leftAngle}deg)`;
    knob.classList.toggle('is-right', right);
    const leftCap = knob.parentElement?.querySelector('.cap-left');
    const rightCap = knob.parentElement?.querySelector('.cap-right');
    if (leftCap) leftCap.classList.toggle('cap-on', !right);
    if (rightCap) rightCap.classList.toggle('cap-on', right);
  }

  function toggle() {
    updateUI(isRight(hiddenInput.value) ? leftVal : rightVal);
    hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  let startX = 0;
  let startRight = false;
  let dragged = false;

  function onMouseDown(e) {
    knob.classList.add('active');
    startX = e.clientX;
    startRight = isRight(hiddenInput.value);
    dragged = false;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  }
  function onMouseMove(e) {
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 6) dragged = true;
    // live preview toward nearer side
    if (dx > 12) updateUI(rightVal);
    else if (dx < -12) updateUI(leftVal);
  }
  function onMouseUp(e) {
    knob.classList.remove('active');
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    if (!dragged) {
      toggle();
    } else {
      // snap to nearest based on final X delta
      const dx = e.clientX - startX;
      updateUI(dx >= 0 ? rightVal : leftVal);
      hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    const wantRight = e.deltaY < 0; // scroll up → right/On
    const next = wantRight ? rightVal : leftVal;
    if (String(hiddenInput.value) === String(next)) return;
    updateUI(next);
    hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  knob.addEventListener('mousedown', onMouseDown);
  knob.addEventListener('wheel', onWheel, { passive: false });
  if (!knob.getAttribute('title') || /click to toggle/i.test(knob.getAttribute('title') || '')) {
    knob.title = 'Click to toggle · scroll wheel';
  }
  // initial
  const init = opts.initial != null ? opts.initial : hiddenInput.value;
  updateUI(init);
}

function knobUnitHtml({ id, label, value, binary = false, leftCap = '', rightCap = '' }) {
  if (binary) {
    return `
      <div class="knob-unit">
        <span class="knob-unit-label">${label}</span>
        <div class="daw-knob binary-knob" id="${id}Knob" title="Click to toggle · scroll wheel">
          <div class="daw-knob-dial"></div>
          <div class="daw-knob-indicator" id="${id}KnobInd"></div>
        </div>
        <div class="binary-knob-caption">
          <span class="cap-left">${leftCap}</span>
          <span class="cap-right">${rightCap}</span>
        </div>
        <input type="hidden" id="${id}" value="${value}">
      </div>`;
  }
  return `
    <div class="knob-unit">
      <span class="knob-unit-label">${label}</span>
      <div class="daw-knob" id="${id}Knob" title="Drag up/down · scroll wheel · Shift+scroll for fine">
        <div class="daw-knob-dial"></div>
        <div class="daw-knob-indicator" id="${id}KnobInd"></div>
      </div>
      <input type="text" class="daw-knob-value-input" id="${id}Val" value="${value}">
      <input type="hidden" id="${id}" value="${value}">
    </div>`;
}
export { setupContinuousKnob, setupBinaryKnob, knobUnitHtml };
