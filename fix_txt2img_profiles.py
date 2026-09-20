import re

with open('mtapi-project/app/static/js/tabs/txt2img.js', 'r') as f:
    js = f.read()

js = js.replace("stepsEl.dispatchEvent(new Event('change', { bubbles: true }));", "if (stepsKnobVal) stepsKnobVal.dispatchEvent(new Event('change', { bubbles: true }));")
js = js.replace("guideEl.dispatchEvent(new Event('change', { bubbles: true }));", "if (guideKnobVal) guideKnobVal.dispatchEvent(new Event('change', { bubbles: true }));")

with open('mtapi-project/app/static/js/tabs/txt2img.js', 'w') as f:
    f.write(js)
