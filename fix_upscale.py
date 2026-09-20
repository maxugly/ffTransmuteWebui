import re

with open('mtapi-project/app/static/js/tabs/upscale.js', 'r') as f:
    js = f.read()

# Fix knobUnitHtml positional calls
js = js.replace(
    "${knobUnitHtml('upNoiseVal', '-1', -1, 10, 1)}",
    "${knobUnitHtml({ id: 'upNoiseVal', label: 'Noise', value: '-1' })}"
)
js = js.replace(
    "${knobUnitHtml('upGrainVal', '0', 0, 24, 1)}",
    "${knobUnitHtml({ id: 'upGrainVal', label: 'Grain', value: '0' })}"
)

# Fix setupContinuousKnob positional calls
old_setup_scale = """  setupContinuousKnob('knobUpScale', 2, 4, 1, 4, function(v) {
    document.getElementById('knobUpScale').querySelector('.knob-val').textContent = v;
  });"""
new_setup_scale = """  setupContinuousKnob({
    knobId: 'knobUpScaleKnob', indicatorId: 'knobUpScaleKnobInd', hiddenId: 'knobUpScale',
    min: 2, max: 4, step: 1, initial: 4
  });"""
js = js.replace(old_setup_scale, new_setup_scale)

old_setup_tile = """  setupContinuousKnob('knobUpTile', 0, 1024, 32, 256, function(v) {
    document.getElementById('knobUpTile').querySelector('.knob-val').textContent = v;
  });"""
new_setup_tile = """  setupContinuousKnob({
    knobId: 'knobUpTileKnob', indicatorId: 'knobUpTileKnobInd', hiddenId: 'knobUpTile',
    min: 0, max: 1024, step: 32, initial: 256
  });"""
js = js.replace(old_setup_tile, new_setup_tile)

old_setup_noise = """  setupContinuousKnob('upNoiseVal', -1, 10, 1, 3, function(v) {
    document.getElementById('upNoiseVal').querySelector('.knob-val').textContent = v;
  });"""
new_setup_noise = """  setupContinuousKnob({
    knobId: 'upNoiseValKnob', indicatorId: 'upNoiseValKnobInd', hiddenId: 'upNoiseVal',
    min: -1, max: 10, step: 1, initial: 3
  });"""
js = js.replace(old_setup_noise, new_setup_noise)

old_setup_grain = """  setupContinuousKnob('upGrainVal', 0, 24, 1, 0, function(v) {
    document.getElementById('upGrainVal').querySelector('.knob-val').textContent = v;
  });"""
new_setup_grain = """  setupContinuousKnob({
    knobId: 'upGrainValKnob', indicatorId: 'upGrainValKnobInd', hiddenId: 'upGrainVal',
    min: 0, max: 24, step: 1, initial: 0
  });"""
js = js.replace(old_setup_grain, new_setup_grain)

# Also fix the HTML generation for Scale and Tile
old_html_scale = """        <div class="knob-wrap">
          <label for="knobUpScale">Scale</label>
          <div class="knob-unit" id="knobUpScale">2</div>
        </div>
        <div class="knob-wrap">
          <label for="knobUpTile">Tile size</label>
          <div class="knob-unit" id="knobUpTile">256</div>
        </div>"""
new_html_scale = """        <div class="knob-bank">
          ${knobUnitHtml({ id: 'knobUpScale', label: 'Scale', value: '4' })}
          ${knobUnitHtml({ id: 'knobUpTile', label: 'Tile size', value: '256' })}
        </div>"""
js = js.replace(old_html_scale, new_html_scale)

# And TTA binary knob HTML
old_tta_html = """        <div class="knob-wrap">
          <label for="knobUpTTA">TTA</label>
          <div class="knob-unit binary-knob" id="knobUpTTA">Off</div>
        </div>"""
new_tta_html = """        <div class="knob-bank">
          ${knobUnitHtml({ id: 'knobUpTTA', label: 'TTA', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        </div>"""
js = js.replace(old_tta_html, new_tta_html)

# And TTA setup
old_setup_tta = "  setupBinaryKnob('knobUpTTA', 'Off', 'On', false, function() {});"
new_setup_tta = """  setupBinaryKnob({
    knobId: 'knobUpTTAKnob', indicatorId: 'knobUpTTAKnobInd', hiddenId: 'knobUpTTA',
    leftValue: '0', rightValue: '1'
  });"""
js = js.replace(old_setup_tta, new_setup_tta)

with open('mtapi-project/app/static/js/tabs/upscale.js', 'w') as f:
    f.write(js)
