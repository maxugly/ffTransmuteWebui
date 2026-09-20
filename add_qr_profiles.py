import re

with open('mtapi-project/app/static/js/tabs/qr.js', 'r') as f:
    js = f.read()

profile_logic = """
  document.getElementById('qrModel')?.addEventListener('change', function(e) {
    const val = e.target.value.toLowerCase();
    
    let steps = 30, guide = 9;
    if (val.includes('turbo') || val.includes('lcm') || val.includes('lightning') || val.includes('hyper')) {
      steps = 12;
      guide = 3.5;
    } else if (val.includes('quality') || val.includes('sdxl')) {
      steps = 40;
      guide = 9;
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
    
    setKnob('qrSteps', steps);
    setKnob('qrGuidance', guide);
  });
"""

insert_target = "  document.getElementById('btnQrBrowseSrc')?.addEventListener('click',"
js = js.replace(insert_target, profile_logic + "\n" + insert_target)

with open('mtapi-project/app/static/js/tabs/qr.js', 'w') as f:
    f.write(js)
