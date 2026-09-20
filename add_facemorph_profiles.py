import re

with open('mtapi-project/app/static/js/tabs/facemorph.js', 'r') as f:
    js = f.read()

profile_logic = """
  document.getElementById('fmDreamModel')?.addEventListener('change', function(e) {
    const val = e.target.value.toLowerCase();
    
    let iters = 10, octaves = 2, step = 0.015;
    if (val.includes('turbo') || val.includes('lcm') || val.includes('lightning') || val.includes('hyper')) {
      iters = 4;
      octaves = 2;
      step = 0.015;
    } else if (val.includes('quality') || val.includes('sdxl')) {
      iters = 12;
      octaves = 3;
      step = 0.012;
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
    
    setKnob('fmDreamIters', iters);
    setKnob('fmDreamOctaves', octaves);
    setKnob('fmDreamStep', step);
  });
"""

insert_target = "  document.getElementById('btnFmBrowseA')?.addEventListener('click',"
js = js.replace(insert_target, profile_logic + "\n" + insert_target)

with open('mtapi-project/app/static/js/tabs/facemorph.js', 'w') as f:
    f.write(js)
