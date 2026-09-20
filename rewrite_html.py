import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# Replace knobUnitHtml
old_func = """function knobUnitHtml({ id, label, value, binary = false, leftCap = '', rightCap = '', dice = false }) {"""
# Wait, it might be the old one:
old_func_regex = r"function knobUnitHtml\(\{ id, label, value, binary = false, leftCap = '', rightCap = ''(?:, dice = false)? \}\) \{[\s\S]*?export \{ setupContinuousKnob, setupBinaryKnob, knobUnitHtml \};"

new_func = """function knobUnitHtml({ id, label, value, binary = false, leftCap = '', rightCap = '', dice = false }) {
  const resetHtml = `<button type="button" class="knob-reset-btn" title="Reset to default">⟲</button>`;
  const diceHtml = dice ? `<button type="button" class="knob-dice-btn" id="btn${id}Dice" title="Randomize">🎲</button>` : '';

  if (binary) {
    return `
      <div class="knob-unit" id="${id}Brick" tabindex="0" draggable="false">
        ${resetHtml}
        ${diceHtml}
        <span class="knob-unit-label">${label}</span>
        <div class="daw-knob binary-knob" id="${id}Knob" title="Click to toggle · scroll wheel">
          <div class="daw-knob-dial"></div>
          <div class="daw-knob-indicator" id="${id}KnobInd"></div>
        </div>
        <div class="binary-knob-caption">
          <span class="cap-left">${leftCap}</span>
          <span class="cap-right">${rightCap}</span>
        </div>
        <input type="hidden" id="${id}" value="${value}" data-default="${value}">
      </div>`;
  }
  return `
    <div class="knob-unit" id="${id}Brick" tabindex="0" draggable="false">
      ${resetHtml}
      ${diceHtml}
      <span class="knob-unit-label">${label}</span>
      <div class="daw-knob" id="${id}Knob" title="Drag up/down · scroll wheel · Shift+scroll for fine">
        <div class="daw-knob-dial"></div>
        <div class="daw-knob-indicator" id="${id}KnobInd"></div>
        <div class="daw-knob-value-display" id="${id}ValDisp">${value}</div>
        <input type="text" class="daw-knob-value-input" id="${id}Val" value="${value}">
      </div>
      <input type="hidden" id="${id}" value="${value}" data-default="${value}">
    </div>`;
}
export { setupContinuousKnob, setupBinaryKnob, knobUnitHtml };"""

js = re.sub(old_func_regex, new_func, js)
with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
