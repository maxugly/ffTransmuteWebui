import re

with open('mtapi-project/app/static/js/tabs/txt2img.js', 'r') as f:
    js = f.read()

profile_logic = """
  document.getElementById('t2iModel')?.addEventListener('change', function(e) {
    const val = e.target.value.toLowerCase();
    const stepsEl = document.getElementById('t2iSteps');
    const guideEl = document.getElementById('t2iGuidance');
    const stepsDisp = document.getElementById('t2iStepsValDisp');
    const guideDisp = document.getElementById('t2iGuidanceValDisp');
    const stepsKnobVal = document.getElementById('t2iStepsVal');
    const guideKnobVal = document.getElementById('t2iGuidanceVal');
    
    if (!stepsEl || !guideEl) return;
    
    let steps = 20, guide = 6;
    if (val.includes('turbo') || val.includes('lcm') || val.includes('lightning') || val.includes('hyper')) {
      steps = 4;
      guide = 1;
    } else if (val.includes('quality') || val.includes('sdxl')) {
      steps = 30;
      guide = 7;
    }
    
    stepsEl.value = steps;
    stepsEl.setAttribute('data-default', steps);
    if (stepsDisp) stepsDisp.textContent = steps;
    if (stepsKnobVal) stepsKnobVal.value = steps;
    
    guideEl.value = guide;
    guideEl.setAttribute('data-default', guide);
    if (guideDisp) guideDisp.textContent = guide;
    if (guideKnobVal) guideKnobVal.value = guide;
    
    // Dispatch change event to update the knob indicator if possible, 
    // or the knob script handles updates if the hidden input changes?
    stepsEl.dispatchEvent(new Event('change', { bubbles: true }));
    guideEl.dispatchEvent(new Event('change', { bubbles: true }));
  });
"""

# Inject before document.getElementById('btnT2iBrowseOut')
insert_target = "  document.getElementById('btnT2iBrowseOut')?.addEventListener('click',"
js = js.replace(insert_target, profile_logic + "\n" + insert_target)

with open('mtapi-project/app/static/js/tabs/txt2img.js', 'w') as f:
    f.write(js)
