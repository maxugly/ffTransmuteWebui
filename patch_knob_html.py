import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

old_func = """function knobUnitHtml({ id, label, value, binary = false, leftCap = '', rightCap = '' }) {"""
new_func = """function knobUnitHtml({ id, label, value, binary = false, leftCap = '', rightCap = '', dice = false }) {
  const resetHtml = `<button type="button" class="knob-reset-btn" title="Reset to default">⟲</button>`;
  const diceHtml = dice ? `<button type="button" class="knob-dice-btn" id="btn${id}Dice" title="Randomize">🎲</button>` : '';"""
js = js.replace(old_func, new_func)

old_bin = """    return `
      <div class="knob-unit" id="${id}Brick" tabindex="0" draggable="false">
        <span class="knob-unit-label">${label}</span>"""
new_bin = """    return `
      <div class="knob-unit" id="${id}Brick" tabindex="0" draggable="false">
        ${resetHtml}
        ${diceHtml}
        <span class="knob-unit-label">${label}</span>"""
js = js.replace(old_bin, new_bin)

old_cont = """  return `
    <div class="knob-unit" id="${id}Brick" tabindex="0" draggable="false">
      <span class="knob-unit-label">${label}</span>"""
new_cont = """  return `
    <div class="knob-unit" id="${id}Brick" tabindex="0" draggable="false">
      ${resetHtml}
      ${diceHtml}
      <span class="knob-unit-label">${label}</span>"""
js = js.replace(old_cont, new_cont)

old_hidden = """<input type="hidden" id="${id}" value="${value}">"""
new_hidden = """<input type="hidden" id="${id}" value="${value}" data-default="${value}">"""
js = js.replace(old_hidden, new_hidden)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
