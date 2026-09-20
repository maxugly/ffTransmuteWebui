import re

with open('mtapi-project/app/static/js/tabs/upscale.js', 'r') as f:
    js = f.read()

js = js.replace(
    "knobId: 'knobUpScaleKnob', indicatorId: 'knobUpScaleKnobInd', hiddenId: 'knobUpScale',",
    "knobId: 'knobUpScaleKnob', indicatorId: 'knobUpScaleKnobInd', valueId: 'knobUpScaleVal', hiddenId: 'knobUpScale',"
)
js = js.replace(
    "knobId: 'knobUpTileKnob', indicatorId: 'knobUpTileKnobInd', hiddenId: 'knobUpTile',",
    "knobId: 'knobUpTileKnob', indicatorId: 'knobUpTileKnobInd', valueId: 'knobUpTileVal', hiddenId: 'knobUpTile',"
)
js = js.replace(
    "knobId: 'upNoiseValKnob', indicatorId: 'upNoiseValKnobInd', hiddenId: 'upNoiseVal',",
    "knobId: 'upNoiseValKnob', indicatorId: 'upNoiseValKnobInd', valueId: 'upNoiseValVal', hiddenId: 'upNoiseVal',"
)
js = js.replace(
    "knobId: 'upGrainValKnob', indicatorId: 'upGrainValKnobInd', hiddenId: 'upGrainVal',",
    "knobId: 'upGrainValKnob', indicatorId: 'upGrainValKnobInd', valueId: 'upGrainValVal', hiddenId: 'upGrainVal',"
)

with open('mtapi-project/app/static/js/tabs/upscale.js', 'w') as f:
    f.write(js)
