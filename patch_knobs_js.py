import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# 1. Update knobUnitHtml
old_html = r'function knobUnitHtml\(\{ id, label, value, binary = false, leftCap = \'\', rightCap = \'\' \}\) \{.*?(?=\n\}\nexport \{)'
new_html = """function knobUnitHtml({ id, label, value, binary = false, leftCap = '', rightCap = '' }) {
  if (binary) {
    return `
      <div class="knob-unit" id="${id}Brick" tabindex="0">
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
    <div class="knob-unit" id="${id}Brick" tabindex="0">
      <span class="knob-unit-label">${label}</span>
      <div class="daw-knob" id="${id}Knob" title="Drag up/down · scroll wheel · Shift+scroll for fine\\nDouble-click to type">
        <div class="daw-knob-dial"></div>
        <div class="daw-knob-indicator" id="${id}KnobInd"></div>
        <div class="daw-knob-value-display" id="${id}ValDisp">${value}</div>
        <input type="text" class="daw-knob-value-input" id="${id}Val" value="${value}" autocomplete="off">
      </div>
      <input type="hidden" id="${id}" value="${value}">
    </div>`;"""
js = re.sub(old_html, new_html, js, flags=re.DOTALL)

# 2. Update setupContinuousKnob updateUI
old_updateUI = """    if (document.activeElement !== valueDisplay) {
      valueDisplay.value = format(val);
    }
    // store raw number (preserve decimals for backend)"""
new_updateUI = """    const formatted = format(val);
    if (document.activeElement !== valueDisplay) {
      valueDisplay.value = formatted;
    }
    const valDisp = document.getElementById(opts.hiddenId + 'ValDisp');
    if (valDisp) valDisp.textContent = formatted;
    
    // store raw number (preserve decimals for backend)"""
js = js.replace(old_updateUI, new_updateUI)

# 3. Update setupContinuousKnob to add double-click/enter handling
old_mouse_down = """  function onMouseDown(e) {"""
new_mouse_down = """
  const brick = document.getElementById(opts.hiddenId + 'Brick');
  if (brick) {
    function startEditing() {
      brick.classList.add('editing');
      valueDisplay.focus();
      valueDisplay.select();
    }
    brick.addEventListener('dblclick', startEditing);
    brick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && document.activeElement === brick) {
        startEditing();
        e.preventDefault();
      }
    });
    valueDisplay.addEventListener('blur', () => {
      brick.classList.remove('editing');
      // trigger change on blur just in case
      const v = parseFloat(valueDisplay.value);
      if (!isNaN(v)) updateUI(v);
    });
    valueDisplay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = parseFloat(valueDisplay.value);
        if (!isNaN(v)) updateUI(v);
        brick.classList.remove('editing');
        brick.focus();
        e.preventDefault();
      }
    });
  }

  function onMouseDown(e) {"""
js = js.replace(old_mouse_down, new_mouse_down)


with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
