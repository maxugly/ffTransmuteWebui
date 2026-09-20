import re

with open('mtapi-project/app/static/js/tabs/fastsam.js', 'r') as f:
    js = f.read()

js = js.replace(
    "knobId: 'fastsamTargetXKnob', indicatorId: 'fastsamTargetXKnobInd', hiddenId: 'fastsamTargetX',",
    "knobId: 'fastsamTargetXKnob', indicatorId: 'fastsamTargetXKnobInd', valueId: 'fastsamTargetXVal', hiddenId: 'fastsamTargetX',"
)

js = js.replace(
    "knobId: 'fastsamTargetYKnob', indicatorId: 'fastsamTargetYKnobInd', hiddenId: 'fastsamTargetY',",
    "knobId: 'fastsamTargetYKnob', indicatorId: 'fastsamTargetYKnobInd', valueId: 'fastsamTargetYVal', hiddenId: 'fastsamTargetY',"
)

js = js.replace(
    "knobId: 'fastsamConfKnob', indicatorId: 'fastsamConfKnobInd', hiddenId: 'fastsamConf',",
    "knobId: 'fastsamConfKnob', indicatorId: 'fastsamConfKnobInd', valueId: 'fastsamConfVal', hiddenId: 'fastsamConf',"
)

js = js.replace(
    "knobId: 'fastsamIouKnob', indicatorId: 'fastsamIouKnobInd', hiddenId: 'fastsamIou',",
    "knobId: 'fastsamIouKnob', indicatorId: 'fastsamIouKnobInd', valueId: 'fastsamIouVal', hiddenId: 'fastsamIou',"
)

with open('mtapi-project/app/static/js/tabs/fastsam.js', 'w') as f:
    f.write(js)
