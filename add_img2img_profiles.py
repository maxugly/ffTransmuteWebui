import re

with open('mtapi-project/app/static/js/tabs/img2img.js', 'r') as f:
    js = f.read()

profile_logic = """
  document.getElementById('i2iModel')?.addEventListener('change', function(e) {
    const val = e.target.value.toLowerCase();
    const stepsEl = document.getElementById('i2iSteps');
    const guideEl = document.getElementById('i2iGuidance');
    const stepsKnobVal = document.getElementById('i2iStepsVal');
    const guideKnobVal = document.getElementById('i2iGuidanceVal');
    
    if (!stepsEl || !guideEl) return;
    
    let steps = 20, guide = 7;
    if (val.includes('turbo') || val.includes('lcm') || val.includes('lightning') || val.includes('hyper')) {
      steps = 4;
      guide = 1;
    } else if (val.includes('quality') || val.includes('sdxl')) {
      steps = 30;
      guide = 7.5;
    }
    
    stepsEl.setAttribute('data-default', steps);
    if (stepsKnobVal) {
      stepsKnobVal.value = steps;
      stepsKnobVal.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    guideEl.setAttribute('data-default', guide);
    if (guideKnobVal) {
      guideKnobVal.value = guide;
      guideKnobVal.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
"""

insert_target = "  document.getElementById('btnI2iBrowseIn')?.addEventListener('click',"
js = js.replace(insert_target, profile_logic + "\n" + insert_target)

with open('mtapi-project/app/static/js/tabs/img2img.js', 'w') as f:
    f.write(js)
