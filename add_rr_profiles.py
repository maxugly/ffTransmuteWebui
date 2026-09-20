import re

with open('mtapi-project/app/static/js/tabs/riferecohere.js', 'r') as f:
    js = f.read()

profile_logic = """
  document.getElementById('rrModel')?.addEventListener('change', function(e) {
    const val = e.target.value.toLowerCase();
    
    let steps = 20, guide = 5;
    if (val.includes('turbo') || val.includes('lcm') || val.includes('lightning') || val.includes('hyper')) {
      steps = 8;
      guide = 1.5;
    } else if (val.includes('quality') || val.includes('sdxl')) {
      steps = 30;
      guide = 6;
    }
    
    function setKnob(id, newVal) {
      const el = document.getElementById(id);
      const valEl = document.getElementById(id + 'Val');
      if (el) el.setAttribute('data-default', newVal);
      if (valEl) {
        valEl.value = newVal;
        valEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    
    setKnob('rrSteps', steps);
    setKnob('rrGuidance', guide);
  });
"""

insert_target = "  document.getElementById('btnRrBrowseIn')?.addEventListener('click',"
js = js.replace(insert_target, profile_logic + "\n" + insert_target)

with open('mtapi-project/app/static/js/tabs/riferecohere.js', 'w') as f:
    f.write(js)
